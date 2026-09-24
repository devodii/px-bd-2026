"""Pipeline progress.  `python -m pipeline.status [retry]` — retry re-queues everything that failed."""
import sys

from . import bus, db


def main() -> None:
    conn = db.connect()

    if sys.argv[1:] == ["retry"]:
        s = conn.execute("UPDATE sermons SET status = 'downloaded', attempts = 0, error = NULL WHERE status = 'failed'").rowcount
        c = conn.execute("UPDATE chunks SET status = 'pending', attempts = 0, error = NULL WHERE status = 'failed'").rowcount
        bus.ring(bus.CHUNK)
        bus.ring(bus.TRANSCRIBE)
        print(f"re-queued {s} sermon(s) and {c} chunk(s)")
        return

    print("sermons:", {r["status"]: r["count"] for r in conn.execute("SELECT status, count(*) FROM sermons GROUP BY 1 ORDER BY 1")})
    print("chunks: ", {r["status"]: r["count"] for r in conn.execute("SELECT status, count(*) FROM chunks GROUP BY 1 ORDER BY 1")})

    t = conn.execute(
        """
        SELECT coalesce(sum(duration_sec), 0) AS total,
               coalesce(sum(duration_sec) FILTER (WHERE status = 'done'), 0) AS done,
               coalesce(sum(transcribe_seconds) FILTER (WHERE status = 'done'), 0) AS spent
        FROM chunks
        """
    ).fetchone()
    print(f"audio:   {t['done'] / 3600:.1f}h of {t['total'] / 3600:.1f}h transcribed")
    if t["spent"]:
        speed = t["done"] / t["spent"]
        print(f"speed:   {speed:.1f}x realtime, ~{(t['total'] - t['done']) / speed / 3600:.1f}h remaining for chunked audio")

    for r in conn.execute(
        "SELECT sermon_id, idx, error FROM chunks WHERE status = 'failed' UNION ALL "
        "SELECT id, NULL, error FROM sermons WHERE status = 'failed' LIMIT 20"
    ):
        where = f"sermon {r['sermon_id']}" + (f" chunk {r['idx']}" if r["idx"] is not None else "")
        print(f"FAILED {where}: {(r['error'] or '')[:200]}")


if __name__ == "__main__":
    main()
