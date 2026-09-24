import logging
import re
import time

from faster_whisper import WhisperModel
from psycopg.types.json import Jsonb

from . import bus, config, db

log = logging.getLogger("transcriber")

CLAIM = """
UPDATE chunks
SET status = 'processing', claimed_at = now(), attempts = attempts + 1, updated_at = now()
WHERE id = (
    SELECT id FROM chunks
    WHERE status = 'pending'
       OR (status = 'processing' AND claimed_at < now() - make_interval(secs => %s))
    ORDER BY sermon_id, idx
    FOR UPDATE SKIP LOCKED
    LIMIT 1
)
RETURNING *
"""

# Only the worker that finishes the last chunk flips the sermon, so the transcript is written once.
FINISH_SERMON = """
UPDATE sermons SET status = 'transcribed', updated_at = now()
WHERE id = %(id)s AND status = 'chunked'
  AND NOT EXISTS (SELECT 1 FROM chunks WHERE sermon_id = %(id)s AND status <> 'done')
RETURNING *
"""


def hms(seconds: float) -> str:
    s = int(seconds)
    return f"{s // 3600:02d}:{s % 3600 // 60:02d}:{s % 60:02d}"


def write_transcript(conn, sermon: dict) -> None:
    chunks = conn.execute(
        "SELECT segments FROM chunks WHERE sermon_id = %s ORDER BY idx", (sermon["id"],)
    ).fetchall()
    slug = re.sub(r"[^A-Za-z0-9]+", "-", sermon["file_name"].rsplit(".", 1)[0]).strip("-")[:60]
    path = config.TRANSCRIPTS_DIR / f"{sermon['id']:04d}-{slug}.txt"
    path.parent.mkdir(parents=True, exist_ok=True)

    lines = [f"# {sermon['file_name']}"]
    if sermon["posted_at"]:
        lines.append(f"# posted: {sermon['posted_at']:%Y-%m-%d}")
    if sermon["caption"]:
        lines.append(f"# caption: {sermon['caption']}")
    lines.append("")
    for chunk in chunks:
        lines += [f"[{hms(seg['start'])}] {seg['text']}" for seg in chunk["segments"]]
    path.write_text("\n".join(lines) + "\n")
    log.info("sermon %s transcribed -> %s", sermon["id"], path)


def transcribe_chunk(conn, model: WhisperModel, chunk: dict) -> None:
    t0 = time.monotonic()
    segments, info = model.transcribe(
        chunk["path"],
        language=config.WHISPER_LANGUAGE,
        beam_size=config.WHISPER_BEAM_SIZE,
        initial_prompt=config.WHISPER_INITIAL_PROMPT,
        vad_filter=True,
        # Stops one misheard phrase (common over praise & worship) from looping for minutes.
        condition_on_previous_text=False,
    )
    segs = [
        {
            "start": round(chunk["start_sec"] + s.start, 2),
            "end": round(chunk["start_sec"] + s.end, 2),
            "text": s.text.strip(),
        }
        for s in segments
    ]
    elapsed = time.monotonic() - t0
    conn.execute(
        """
        UPDATE chunks
        SET status = 'done', text = %s, segments = %s, language = %s, model = %s,
            transcribe_seconds = %s, error = NULL, updated_at = now()
        WHERE id = %s
        """,
        (" ".join(s["text"] for s in segs), Jsonb(segs), info.language, config.WHISPER_MODEL, elapsed, chunk["id"]),
    )
    log.info(
        "sermon %s chunk %s: %.0fs audio in %.0fs (%.1fx realtime)",
        chunk["sermon_id"], chunk["idx"], chunk["duration_sec"], elapsed, chunk["duration_sec"] / max(elapsed, 0.01),
    )


def process_next(conn, model: WhisperModel) -> bool:
    chunk = conn.execute(CLAIM, (config.STALE_CLAIM_SECONDS,)).fetchone()
    if not chunk:
        return False
    try:
        transcribe_chunk(conn, model, chunk)
    except Exception as e:
        status = "failed" if chunk["attempts"] >= config.MAX_ATTEMPTS else "pending"
        log.exception("sermon %s chunk %s failed (%s)", chunk["sermon_id"], chunk["idx"], status)
        conn.execute(
            "UPDATE chunks SET status = %s, error = %s, updated_at = now() WHERE id = %s",
            (status, repr(e)[-4000:], chunk["id"]),
        )
        return True
    except BaseException:
        conn.execute("UPDATE chunks SET status = 'pending', attempts = attempts - 1 WHERE id = %s", (chunk["id"],))
        raise
    sermon = conn.execute(FINISH_SERMON, {"id": chunk["sermon_id"]}).fetchone()
    if sermon:
        write_transcript(conn, sermon)
    return True


def main() -> None:
    bus.setup_logging()
    conn = db.connect()
    log.info("loading whisper model %s (%s, %d threads)...", config.WHISPER_MODEL, config.WHISPER_COMPUTE_TYPE, config.WHISPER_CPU_THREADS)
    model = WhisperModel(
        config.WHISPER_MODEL,
        device="cpu",
        compute_type=config.WHISPER_COMPUTE_TYPE,
        cpu_threads=config.WHISPER_CPU_THREADS,
        download_root=config.WHISPER_MODELS_DIR,
    )
    log.info("transcriber ready")
    bus.run_worker(bus.TRANSCRIBE, lambda: process_next(conn, model))


if __name__ == "__main__":
    main()
