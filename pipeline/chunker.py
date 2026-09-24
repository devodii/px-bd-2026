import logging
import shutil
import subprocess
from pathlib import Path

from . import bus, config, db

log = logging.getLogger("chunker")

CLAIM = """
UPDATE sermons
SET status = 'chunking', claimed_at = now(), attempts = attempts + 1, updated_at = now()
WHERE id = (
    SELECT id FROM sermons
    WHERE status = 'downloaded'
       OR (status = 'chunking' AND claimed_at < now() - make_interval(secs => %s))
    ORDER BY priority DESC, posted_at NULLS LAST, id
    FOR UPDATE SKIP LOCKED
    LIMIT 1
)
RETURNING *
"""


def split(src: Path, out_dir: Path) -> list[tuple[Path, float, float]]:
    """Cut src into chunks; returns (path, start_sec, duration_sec) per chunk.

    Timings come from ffmpeg's segment list because the segment muxer can't write
    durations into FLAC headers, so ffprobe on a chunk reports N/A.
    """
    shutil.rmtree(out_dir, ignore_errors=True)
    out_dir.mkdir(parents=True)
    segment_list = out_dir / "segments.csv"
    subprocess.run(
        [
            "ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin",
            "-i", str(src),
            "-vn", "-ac", "1", "-ar", "16000", "-c:a", "flac",
            "-f", "segment", "-segment_time", str(config.CHUNK_SECONDS), "-reset_timestamps", "1",
            "-segment_list", str(segment_list), "-segment_list_type", "csv",
            str(out_dir / "%04d.flac"),
        ],
        check=True, capture_output=True, text=True,
    )
    chunks = []
    for line in segment_list.read_text().splitlines():
        name, start, end = line.rsplit(",", 2)
        chunks.append((out_dir / name, float(start), float(end) - float(start)))
    return chunks


def chunk_sermon(conn, sermon: dict) -> None:
    chunks = split(Path(sermon["raw_path"]), config.CHUNKS_DIR / str(sermon["id"]))
    if not chunks:
        raise RuntimeError("ffmpeg produced no chunks (no audio stream?)")

    total = sum(duration for _, _, duration in chunks)
    with conn.transaction():
        conn.execute("DELETE FROM chunks WHERE sermon_id = %s", (sermon["id"],))
        for idx, (path, start, duration) in enumerate(chunks):
            conn.execute(
                "INSERT INTO chunks (sermon_id, idx, start_sec, duration_sec, path) VALUES (%s, %s, %s, %s, %s)",
                (sermon["id"], idx, start, duration, str(path.relative_to(config.DATA_DIR))),
            )
        conn.execute(
            "UPDATE sermons SET status = 'chunked', duration_sec = %s, error = NULL, updated_at = now() WHERE id = %s",
            (total, sermon["id"]),
        )
    log.info("sermon %s (%s): %d chunks, %.1f min", sermon["id"], sermon["file_name"], len(chunks), total / 60)


def process_next(conn) -> bool:
    sermon = conn.execute(CLAIM, (config.STALE_CLAIM_SECONDS,)).fetchone()
    if not sermon:
        return False
    try:
        chunk_sermon(conn, sermon)
    except Exception as e:
        detail = e.stderr.strip() if isinstance(e, subprocess.CalledProcessError) else repr(e)
        status = "failed" if sermon["attempts"] >= config.MAX_ATTEMPTS else "downloaded"
        log.error("sermon %s: chunking failed (%s): %s", sermon["id"], status, detail)
        conn.execute(
            "UPDATE sermons SET status = %s, error = %s, updated_at = now() WHERE id = %s",
            (status, detail[-4000:], sermon["id"]),
        )
        return True
    except BaseException:
        conn.execute("UPDATE sermons SET status = 'downloaded', attempts = attempts - 1 WHERE id = %s", (sermon["id"],))
        raise
    bus.ring(bus.TRANSCRIBE)
    return True


def main() -> None:
    bus.setup_logging()
    conn = db.connect()
    log.info("chunker ready (%ss chunks)", config.CHUNK_SECONDS)
    bus.run_worker(bus.CHUNK, lambda: process_next(conn))


if __name__ == "__main__":
    main()
