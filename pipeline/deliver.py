"""/transcribe requests: live progress in Telegram, then the transcript posted back in 5-minute parts.

Requests live in Postgres, so this loop is restartable: it re-reads open requests every few seconds,
edits each one's status message as the pipeline moves, and resumes a half-sent transcript at
parts_sent instead of starting over.
"""
import asyncio
import html
import logging

from . import bus, config

log = logging.getLogger("deliver")

POLL_SECONDS = 3
# Telegram caps a message at 4096 characters of visible text (formatting tags don't count);
# leave room for the header.
MESSAGE_LIMIT = 3950
# Bots may send about 1 message/second to a chat, and about 20/minute to a group.
PACE_SECONDS = {"private": 1.1, "group": 3.2}

OPEN_REQUESTS = """
SELECT r.*, s.file_name, s.duration_sec, s.status AS sermon_status,
       count(c.id) AS total,
       count(c.id) FILTER (WHERE c.status = 'done') AS done,
       count(c.id) FILTER (WHERE c.status = 'failed') AS failed
FROM transcript_requests r
JOIN sermons s ON s.id = r.sermon_id
LEFT JOIN chunks c ON c.sermon_id = s.id
WHERE r.status IN ('pending', 'delivering')
GROUP BY r.id, s.id
ORDER BY r.id
"""


def request(conn, sermon_id: int, chat_id: int, reply_to_msg_id: int, status_msg_id: int, requested_by: int) -> bool:
    """Record a /transcribe and move the sermon to the front of the queue. False if one is already open."""
    row = conn.execute(
        """
        INSERT INTO transcript_requests (sermon_id, chat_id, reply_to_msg_id, status_msg_id, requested_by)
        VALUES (%s, %s, %s, %s, %s)
        ON CONFLICT (sermon_id, chat_id) WHERE status IN ('pending', 'delivering') DO NOTHING
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
        return f"{headline(r)}\n✂️ Splitting into 5-minute parts…"
    if not r["done"]:
        return f"{headline(r)}\n🧠 Queued for transcription {bar(0, r['total'])} 0/{r['total']}"
    return f"{headline(r)}\n🧠 Transcribing {bar(r['done'], r['total'])} {r['done']}/{r['total']}"


def transcript_messages(r: dict, chunks: list[dict]) -> list[str]:
    """One message per 5-minute chunk. A fast speaker can fill more than Telegram's 4096 characters in
    5 minutes, so such a chunk goes out as "(1 of 2)", "(2 of 2)", split between lines.

    Lines whisper was unsure about are italicised so they're easy to double-check.
    """
    name = esc(title(r["file_name"]))
    total = len(chunks)
    messages = []
    for n, c in enumerate(chunks, 1):
        span = f"{clock(c['start_sec'])}–{clock(c['start_sec'] + c['duration_sec'])}"
        header = f"📖 <b>{name}</b>\n<b>Part {n}/{total}</b> · {span}"
        if c["flagged_segments"]:
            header += f" · <i>{c['flagged_segments']} unsure</i>"
        header_plain = f"📖 {title(r['file_name'])}\nPart {n}/{total} · {span} · 99 unsure (9 of 9)\n\n"
        # (visible text, rendered html) per line; only the visible length counts toward the limit.
        lines = [(seg["text"], f"<i>{esc(seg['text'])}</i>" if seg.get("flags") else esc(seg["text"]))
                 for seg in c["segments"]] or [("(no speech)", "<i>(no speech)</i>")]

        pieces, current, size = [], [], 0
        for plain, rendered in lines:
            if current and size + 1 + len(plain) > MESSAGE_LIMIT - len(header_plain):
                pieces.append(" ".join(current))
                current, size = [], 0
            current.append(rendered)
            size += len(plain) + (1 if size else 0)
        pieces.append(" ".join(current))

        for i, body in enumerate(pieces):
            cont = f" <i>({i + 1} of {len(pieces)})</i>" if len(pieces) > 1 else ""
            messages.append(f"{header}{cont}\n\n{body}")
    return messages


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

    async def send(self, r: dict, text: str | None = None, file=None) -> None:
        kwargs = {"parse_mode": "html", "link_preview": False}
        try:
            if file:
                await self.client.send_file(r["chat_id"], file, caption=text, reply_to=r["reply_to_msg_id"],
                                            force_document=True, **kwargs)
            else:
                await self.client.send_message(r["chat_id"], text, reply_to=r["reply_to_msg_id"], **kwargs)
        except Exception as e:
            if r["reply_to_msg_id"] is None or "reply" not in str(e).lower():
                raise
            # The audio was deleted; post without threading rather than not at all.
            r = {**r, "reply_to_msg_id": None}
            await self.send(r, text, file)

    async def deliver(self, r: dict) -> None:
        self.conn.execute("UPDATE transcript_requests SET status = 'delivering', updated_at = now() WHERE id = %s", (r["id"],))
        chunks = self.conn.execute(
            "SELECT start_sec, duration_sec, segments, flagged_segments FROM chunks WHERE sermon_id = %s ORDER BY idx",
            (r["sermon_id"],),
        ).fetchall()
        messages = transcript_messages(r, chunks)
        full = next(config.TRANSCRIPTS_DIR.glob(f"{r['sermon_id']:04d}-*.txt"), None)
        # The .txt goes last and counts as a part, so a resumed delivery never sends it twice.
        items = messages + ([full] if full else [])
        pace = PACE_SECONDS["private"] if r["chat_id"] > 0 else PACE_SECONDS["group"]

        for i in range(r["parts_sent"], len(items)):
            await self.set_status(r, f"{headline(r)}\n📤 Sending transcript {bar(i, len(items))} {i}/{len(items)}")
            if i < len(messages):
                await self.send(r, messages[i])
            else:
                await self.send(r, "📄 <b>Full transcript</b> with timestamps", file=full)
            self.conn.execute("UPDATE transcript_requests SET parts_sent = %s, updated_at = now() WHERE id = %s", (i + 1, r["id"]))
            await asyncio.sleep(pace)

        self.conn.execute("UPDATE transcript_requests SET status = 'delivered', updated_at = now() WHERE id = %s", (r["id"],))
        await self.set_status(r, f"{headline(r)}\n✅ Transcribed · {len(chunks)} parts below")
        log.info("delivered sermon %s to chat %s (%d messages)", r["sermon_id"], r["chat_id"], len(messages))
