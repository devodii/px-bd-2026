"""Transcribe pending chunks.

Two backends:
  mlx             native on Apple Silicon, uses the GPU (run it on the Mac: scripts/transcribe-mac.sh)
  faster-whisper  CPU, for the optional Docker service on machines without a GPU
"""
import logging
import re
import time

from psycopg.types.json import Jsonb

from . import bus, config, db

log = logging.getLogger("transcriber")

CLAIM = """
UPDATE chunks
SET status = 'processing', claimed_at = now(), attempts = attempts + 1, updated_at = now()
WHERE id = (
    SELECT c.id FROM chunks c
    JOIN sermons s ON s.id = c.sermon_id
    WHERE c.status = 'pending'
       OR (c.status = 'processing' AND c.claimed_at < now() - make_interval(secs => %s))
    ORDER BY s.priority DESC, c.sermon_id, c.idx
    FOR UPDATE OF c SKIP LOCKED
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

# Whisper's own signals that a segment may be made up rather than heard; flagged segments get a
# "[?]" in the transcript file so a human checks them before they're used.
LOW_CONFIDENCE_LOGPROB = -1.0
REPETITIVE_COMPRESSION_RATIO = 2.4
LIKELY_NO_SPEECH_PROB = 0.6


def flags_for(seg: dict, previous_text: str | None) -> list[str]:
    flags = []
    if seg["avg_logprob"] < LOW_CONFIDENCE_LOGPROB:
        flags.append("low_confidence")
    if seg["compression_ratio"] > REPETITIVE_COMPRESSION_RATIO:
        flags.append("repetitive")
    if seg["no_speech_prob"] > LIKELY_NO_SPEECH_PROB:
        flags.append("likely_no_speech")
    if previous_text and seg["text"].lower() == previous_text.lower():
        flags.append("repeated_line")
    return flags


class MlxBackend:
    def __init__(self):
        import mlx_whisper

        self._mlx = mlx_whisper
        self.model = config.MLX_WHISPER_MODEL

    def transcribe(self, path: str) -> tuple[list[dict], str]:
        result = self._mlx.transcribe(
            path,
            path_or_hf_repo=self.model,
            language=config.WHISPER_LANGUAGE,
            initial_prompt=config.WHISPER_INITIAL_PROMPT,
            condition_on_previous_text=False,
        )
        segs = [
            {k: s[k] for k in ("start", "end", "text", "avg_logprob", "compression_ratio", "no_speech_prob")}
            for s in result["segments"]
        ]
        return segs, result.get("language") or config.WHISPER_LANGUAGE or ""


class FasterWhisperBackend:
    def __init__(self):
        from faster_whisper import WhisperModel

        self.model = config.WHISPER_MODEL
        log.info("loading whisper model %s (%s, %d threads)...", self.model, config.WHISPER_COMPUTE_TYPE, config.WHISPER_CPU_THREADS)
        self._model = WhisperModel(
            self.model,
            device="cpu",
            compute_type=config.WHISPER_COMPUTE_TYPE,
            cpu_threads=config.WHISPER_CPU_THREADS,
            download_root=config.WHISPER_MODELS_DIR,
        )

    def transcribe(self, path: str) -> tuple[list[dict], str]:
        segments, info = self._model.transcribe(
            path,
            language=config.WHISPER_LANGUAGE,
            beam_size=config.WHISPER_BEAM_SIZE,
            initial_prompt=config.WHISPER_INITIAL_PROMPT,
            vad_filter=True,
            # Stops one misheard phrase (common over praise & worship) from looping for minutes.
            condition_on_previous_text=False,
        )
        segs = [
            {"start": s.start, "end": s.end, "text": s.text, "avg_logprob": s.avg_logprob,
             "compression_ratio": s.compression_ratio, "no_speech_prob": s.no_speech_prob}
            for s in segments
        ]
        return segs, info.language


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
    lines.append("# [?] = whisper was unsure about this line; check it against the audio")
    lines.append("")
    for chunk in chunks:
        lines += [f"[{hms(seg['start'])}]{' [?]' if seg['flags'] else ''} {seg['text']}" for seg in chunk["segments"]]
    path.write_text("\n".join(lines) + "\n")
    log.info("sermon %s transcribed -> %s", sermon["id"], path)


def transcribe_chunk(conn, backend, chunk: dict) -> None:
    t0 = time.monotonic()
    raw_segs, language = backend.transcribe(str(config.DATA_DIR / chunk["path"]))
    segs, previous = [], None
    for s in raw_segs:
        text = s["text"].strip()
        if not text:
            continue
        seg = {**s, "text": text, "start": round(chunk["start_sec"] + s["start"], 2), "end": round(chunk["start_sec"] + s["end"], 2)}
        seg["flags"] = flags_for(seg, previous)
        segs.append(seg)
        previous = text
    elapsed = time.monotonic() - t0
    flagged = sum(1 for s in segs if s["flags"])
    conn.execute(
        """
        UPDATE chunks
        SET status = 'done', text = %s, segments = %s, language = %s, model = %s, flagged_segments = %s,
            transcribe_seconds = %s, error = NULL, updated_at = now()
        WHERE id = %s
        """,
        (" ".join(s["text"] for s in segs), Jsonb(segs), language, backend.model, flagged, elapsed, chunk["id"]),
    )
    log.info(
        "sermon %s chunk %s: %.0fs audio in %.0fs (%.1fx realtime), %d/%d segments flagged",
        chunk["sermon_id"], chunk["idx"], chunk["duration_sec"], elapsed,
        chunk["duration_sec"] / max(elapsed, 0.01), flagged, len(segs),
    )


def process_next(conn, backend) -> bool:
    chunk = conn.execute(CLAIM, (config.STALE_CLAIM_SECONDS,)).fetchone()
    if not chunk:
        return False
    try:
        transcribe_chunk(conn, backend, chunk)
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
    if config.WHISPER_PAUSE_SECONDS:
        time.sleep(config.WHISPER_PAUSE_SECONDS)  # lets a laptop's GPU cool between chunks
    return True


def main() -> None:
    bus.setup_logging()
    conn = db.connect()
    backend = MlxBackend() if config.WHISPER_BACKEND == "mlx" else FasterWhisperBackend()
    log.info("transcriber ready (%s: %s)", config.WHISPER_BACKEND, backend.model)
    bus.run_worker(bus.TRANSCRIBE, lambda: process_next(conn, backend))


if __name__ == "__main__":
    main()
