"""/transcribe requests: live progress in Telegram, then the transcript sent back as a .txt file.

Requests live in Postgres, so this loop is restartable: it re-reads open requests every few seconds
and edits each one's status message as the pipeline moves.
"""
import asyncio
import html
import logging

from . import bus, config
from .transcriber import write_transcript

log = logging.getLogger("deliver")

POLL_SECONDS = 3

OPEN_REQUESTS = """
SELECT r.*, s.file_name, s.duration_sec, s.status AS sermon_status,
       count(c.id) AS total,
       count(c.id) FILTER (WHERE c.status = 'done') AS done,
       count(c.id) FILTER (WHERE c.status = 'failed') AS failed
FROM transcript_requests r
JOIN sermons s ON s.id = r.sermon_id
LEFT JOIN chunks c ON c.sermon_id = s.id
WHERE r.status = 'pending'
GROUP BY r.id, s.id
ORDER BY r.id
"""


def request(conn, sermon_id: int, chat_id: int, reply_to_msg_id: int, status_msg_id: int, requested_by: int) -> bool:
    """Record a /transcribe and move the sermon to the front of the queue. False if one is already open."""
    row = conn.execute(
        """
        INSERT INTO transcript_requests (sermon_id, chat_id, reply_to_msg_id, status_msg_id, requested_by)
        VALUES (%s, %s, %s, %s, %s)
        ON CONFLICT (sermon_id, chat_id) WHERE status = 'pending' DO NOTHING
        RETURNING id
        """,
        (sermon_id, chat_id, reply_to_msg_id, status_msg_id, requested_by),
    ).fetchone()
    conn.execute("UPDATE sermons SET priority = 1 WHERE id = %s", (sermon_id,))
    bus.ring(bus.CHUNK)
    bus.ring(bus.TRANSCRIBE)
    return row is not None


# --- rendering -----------------------------------------------------------------------------------

def esc(text: str) -> str:
    return html.escape(text, quote=False)  # quotes are only special inside attributes


def title(file_name: str) -> str:
    return file_name.rsplit(".", 1)[0].strip()


def clock(seconds: float) -> str:
    s = int(seconds)
    h, m, s = s // 3600, s % 3600 // 60, s % 60
    return f"{h}:{m:02d}:{s:02d}" if h else f"{m}:{s:02d}"


def bar(done: int, total: int, width: int = 12) -> str:
    filled = round(width * done / total) if total else 0
    return "▰" * filled + "▱" * (width - filled)


def headline(r: dict) -> str:
    text = f"🎧 <b>{esc(title(r['file_name']))}</b>"
    if r["duration_sec"]:
        text += f" · {round(r['duration_sec'] / 60)} min"
    return text


def progress_text(r: dict) -> str:
    if r["sermon_status"] in ("downloaded", "chunking"):
        return f"{headline(r)}\n⚙️ Preparing the audio…"
    if not r["done"]:
        return f"{headline(r)}\n🧠 Queued for transcription {bar(0, r['total'])} 0/{r['total']}"
    return f"{headline(r)}\n🧠 Transcribing {bar(r['done'], r['total'])} {r['done']}/{r['total']}"


# --- telegram side -------------------------------------------------------------------------------

class Delivery:
    def __init__(self, client, conn):
        self.client = client
        self.conn = conn
        self.shown: dict[int, str] = {}  # request id -> status text currently on screen

    async def run(self) -> None:
        while True:
            try:
                for r in self.conn.execute(OPEN_REQUESTS).fetchall():
                    await self.step(r)
            except Exception:
                log.exception("delivery loop error")
            await asyncio.sleep(POLL_SECONDS)

    async def step(self, r: dict) -> None:
        if r["failed"] or r["sermon_status"] == "failed":
            await self.set_status(r, f"{headline(r)}\n❌ Transcription failed. Send /transcribe again to retry.")
            self.conn.execute("UPDATE transcript_requests SET status = 'failed', updated_at = now() WHERE id = %s", (r["id"],))
        elif r["sermon_status"] == "transcribed":
            await self.deliver(r)
        else:
            await self.set_status(r, progress_text(r))

    async def set_status(self, r: dict, text: str) -> None:
        if self.shown.get(r["id"]) == text:
            return
        try:
            await self.client.edit_message(r["chat_id"], r["status_msg_id"], text, parse_mode="html")
        except Exception as e:  # message deleted, not modified, etc. — progress is cosmetic
            log.debug("status edit skipped: %s", e)
        self.shown[r["id"]] = text

    async def send_file(self, r: dict, path, filename: str, caption: str) -> None:
        from telethon.tl.types import DocumentAttributeFilename

        kwargs = {"caption": caption, "parse_mode": "html", "force_document": True,
                  "attributes": [DocumentAttributeFilename(filename)]}
        try:
            await self.client.send_file(r["chat_id"], path, reply_to=r["reply_to_msg_id"], **kwargs)
        except Exception as e:
            if "reply" not in str(e).lower():
                raise
            # The audio was deleted; send without threading rather than not at all.
            await self.client.send_file(r["chat_id"], path, **kwargs)

    async def deliver(self, r: dict) -> None:
        path = next(config.TRANSCRIPTS_DIR.glob(f"{r['sermon_id']:04d}-*.txt"), None)
        if path is None:
            sermon = self.conn.execute("SELECT * FROM sermons WHERE id = %s", (r["sermon_id"],)).fetchone()
            write_transcript(self.conn, sermon)
            path = next(config.TRANSCRIPTS_DIR.glob(f"{r['sermon_id']:04d}-*.txt"))

        name = title(r["file_name"])
        minutes = f" · {round(r['duration_sec'] / 60)} min" if r["duration_sec"] else ""
        await self.set_status(r, f"{headline(r)}\n📤 Sending transcript…")
        await self.send_file(
            r, path, filename=f"{name} - transcript.txt",
            caption=f"📄 <b>{esc(name)}</b>{minutes}\nFull transcript with timestamps. Lines marked [?] were unclear, "
                    f"so check them against the audio.",
        )
        self.conn.execute("UPDATE transcript_requests SET status = 'delivered', updated_at = now() WHERE id = %s", (r["id"],))
        await self.set_status(r, f"{headline(r)}\n✅ Done. Transcript below ↓")
        log.info("delivered sermon %s to chat %s", r["sermon_id"], r["chat_id"])
