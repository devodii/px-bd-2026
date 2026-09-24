"""Get sermon media into the pipeline.

    bot           run the Telegram bot (what the compose service runs): send or forward sermon audio/video
                  to it to save it; reply /transcribe to any audio to get its transcript in 5-minute parts
    import-local  register files dropped into ./data/inbox (no Telegram needed)

The bot connects over MTProto (Telethon) rather than the HTTP Bot API, because the HTTP Bot API
can't download files over 20 MB and sermons are much bigger.
"""
import asyncio
import html
import logging
import re
import sys
from pathlib import Path

from . import bus, config, db

log = logging.getLogger("ingest")


class NotReady(Exception):
    """Telegram isn't configured yet — a setup step for a human, not a crash."""


def safe_name(name: str) -> str:
    return re.sub(r"[^A-Za-z0-9._-]+", "_", name).strip("_") or "file"


def register(conn, **row) -> bool:
    inserted = conn.execute(
        """
        INSERT INTO sermons (source_key, tg_chat_id, tg_message_id, file_name, mime_type, size_bytes, caption, posted_at, raw_path)
        VALUES (%(source_key)s, %(tg_chat_id)s, %(tg_message_id)s, %(file_name)s, %(mime_type)s, %(size_bytes)s,
                %(caption)s, %(posted_at)s, %(raw_path)s)
        ON CONFLICT (source_key) DO NOTHING
        RETURNING id
        """,
        {"tg_chat_id": None, "tg_message_id": None, "mime_type": None, "caption": None, "posted_at": None, **row},
    ).fetchone()
    if inserted:
        bus.ring(bus.CHUNK)
    return inserted is not None


# --- local files ---------------------------------------------------------------------------------

def import_local() -> None:
    conn = db.connect()
    config.INBOX_DIR.mkdir(parents=True, exist_ok=True)
    added = 0
    for path in sorted(config.INBOX_DIR.rglob("*")):
        if path.is_file() and path.suffix.lower() in config.MEDIA_EXTS:
            size = path.stat().st_size
            if register(conn, source_key=f"local:{path.relative_to(config.INBOX_DIR)}:{size}",
                        file_name=path.name, size_bytes=size, raw_path=str(path)):
                log.info("registered %s", path.name)
                added += 1
    log.info("import-local: %d new file(s) from %s", added, config.INBOX_DIR)


# --- telegram bot --------------------------------------------------------------------------------

def is_media(msg) -> bool:
    f = msg.file
    if not f or not msg.document:
        return False
    mime = f.mime_type or ""
    return mime.startswith(("audio/", "video/")) or (f.ext or "").lower() in config.MEDIA_EXTS


async def download(client, conn, msg) -> str:
    """Save one media message to RAW_DIR and register it. Returns a short human-readable result."""
    f = msg.file
    name = f.name or f"{msg.id}{f.ext or ''}"
    # Keyed by Telegram's document id, so forwarding the same file twice doesn't download it twice.
    source_key = f"tgdoc:{msg.document.id}"
    if conn.execute("SELECT 1 FROM sermons WHERE source_key = %s", (source_key,)).fetchone():
        return f"Already have {name}"

    config.RAW_DIR.mkdir(parents=True, exist_ok=True)
    dest = config.RAW_DIR / f"{msg.document.id}_{safe_name(name)}"
    part = dest.with_name(dest.name + ".part")
    log.info("downloading %s (%.1f MB)", name, (f.size or 0) / 1e6)

    last_logged = [0]

    def progress(done, total):
        pct = int(done * 100 / total) if total else 0
        if pct >= last_logged[0] + 20:
            last_logged[0] = pct
            log.info("  %s: %d%%", name, pct)

    # Bigger parts than Telethon's 128 KB default mean fewer round trips per file.
    await client.download_file(msg.document, file=str(part), part_size_kb=512, file_size=f.size,
                                progress_callback=progress)
    part.rename(dest)
    fwd = msg.fwd_from
    register(conn, source_key=source_key, tg_chat_id=msg.chat_id, tg_message_id=msg.id,
             file_name=name, mime_type=f.mime_type, size_bytes=f.size, caption=msg.message or None,
             posted_at=(fwd.date if fwd else msg.date), raw_path=str(dest))
    log.info("saved %s", dest.name)
    return f"Saved {name} ({(f.size or 0) / 1e6:.0f} MB)"


async def backfill(client, conn, handle) -> None:
    """Fetch, by message id, files sent while the bot was down or still queued when it restarted.

    Bots can't read chat history, but they can fetch their own chats' messages by id.
    """
    chats = conn.execute(
        "SELECT tg_chat_id, min(tg_message_id) AS lo, max(tg_message_id) AS hi FROM sermons "
        "WHERE tg_chat_id IS NOT NULL GROUP BY 1"
    ).fetchall()
    tasks = []
    for chat in chats:
        ids = list(range(max(1, chat["lo"] - 50), chat["hi"] + 500))
        for i in range(0, len(ids), 100):
            for msg in await client.get_messages(chat["tg_chat_id"], ids=ids[i:i + 100]):
                if msg and msg.out is False and is_media(msg):
                    tasks.append(handle(msg))
    log.info("backfill: checking %d file message(s) from earlier", len(tasks))
    for task in tasks:
        asyncio.ensure_future(task)


HELP = (
    "Send or forward sermon audio/video here and I'll save it for transcription.\n\n"
    "Reply to any audio with /transcribe to get its transcript back in 5-minute parts."
)


async def run_bot() -> None:
    from telethon import TelegramClient, events, functions, types

    from .deliver import Delivery, request

    if not config.TG_API_ID or not config.TG_API_HASH:
        raise NotReady("Set TG_API_ID and TG_API_HASH in .env (create them at https://my.telegram.org -> API development tools)")
    if not config.TG_BOT_TOKEN:
        raise NotReady("Set TG_BOT_TOKEN in .env (create a bot by messaging @BotFather on Telegram)")

    conn = db.connect()
    Path(config.TG_BOT_SESSION).parent.mkdir(parents=True, exist_ok=True)
    # catch_up picks up files sent while the bot was offline.
    client = TelegramClient(config.TG_BOT_SESSION, config.TG_API_ID, config.TG_API_HASH, catch_up=True)
    await client.start(bot_token=config.TG_BOT_TOKEN)
    me = await client.get_me()
    await client(functions.bots.SetBotCommandsRequest(
        scope=types.BotCommandScopeDefault(), lang_code="",
        commands=[types.BotCommand("transcribe", "Reply to an audio to get its transcript")],
    ))
    log.info("bot @%s is listening; send or forward sermon audio to it", me.username)

    downloads = asyncio.Semaphore(config.TG_PARALLEL_DOWNLOADS)
    in_flight: set[int] = set()

    def allowed(user_id) -> bool:
        if config.TG_ALLOWED_USER_IDS and user_id not in config.TG_ALLOWED_USER_IDS:
            log.warning("ignoring message from unlisted user %s", user_id)
            return False
        return True

    def sermon_id_for(msg) -> int | None:
        row = conn.execute("SELECT id FROM sermons WHERE source_key = %s", (f"tgdoc:{msg.document.id}",)).fetchone()
        return row["id"] if row else None

    async def fetch(msg) -> str | None:
        """Download msg's file unless we have it or another task is already on it. None if skipped."""
        if msg.document.id in in_flight:
            return None
        in_flight.add(msg.document.id)
        try:
            async with downloads:
                return await download(client, conn, msg)
        finally:
            in_flight.discard(msg.document.id)

    async def ensure_sermon(msg) -> int:
        while (sermon_id := sermon_id_for(msg)) is None:
            if await fetch(msg) is None:
                await asyncio.sleep(1)  # someone else is downloading it; wait for their row
        return sermon_id

    async def on_file(msg):
        try:
            result = await fetch(msg)
        except Exception as e:
            log.exception("download failed")
            result = f"Failed to save {msg.file.name or 'file'}: {e}"
        if result and not result.startswith("Already"):
            await msg.reply(result)

    @client.on(events.NewMessage(incoming=True, func=lambda e: e.is_private))
    async def on_private(event):
        msg = event.message
        if not allowed(event.sender_id) or (msg.text or "").startswith("/transcribe"):
            return
        if is_media(msg):
            await on_file(msg)
        else:
            await event.reply(f"{HELP}\n\n(your user id: {event.sender_id})")

    @client.on(events.NewMessage(incoming=True, pattern=r"^/transcribe(?:@(\w+))?\b"))
    async def on_transcribe(event):
        addressed_to = event.pattern_match.group(1)
        if addressed_to and addressed_to.lower() != me.username.lower():
            return
        if not allowed(event.sender_id):
            return
        audio = await event.get_reply_message()
        if not audio or not is_media(audio):
            await event.reply("↩️ Reply to an audio or video message with /transcribe")
            return

        name = html.escape(audio.file.name or "Audio")
        status = await audio.reply(f"🎧 <b>{name}</b>\n⬇️ Downloading…", parse_mode="html")
        try:
            sermon_id = await ensure_sermon(audio)
        except Exception as e:
            log.exception("download for /transcribe failed")
            await status.edit(f"❌ Couldn't download this file: {e}")
            return
        if not request(conn, sermon_id, event.chat_id, audio.id, status.id, event.sender_id):
            await status.edit("👆 Already working on this one — progress is in the message above.")

    asyncio.create_task(Delivery(client, conn).run())
    await backfill(client, conn, on_file)
    await client.run_until_disconnected()


async def bot_forever() -> None:
    while True:
        try:
            await run_bot()
        except NotReady as e:
            log.warning("%s (checking again in 60s)", e)
            await asyncio.sleep(60)


def main() -> None:
    bus.setup_logging()
    cmd = sys.argv[1] if len(sys.argv) > 1 else "bot"
    commands = {
        "bot": lambda: asyncio.run(bot_forever()),
        "import-local": import_local,
    }
    if cmd not in commands:
        sys.exit(__doc__)
    commands[cmd]()


if __name__ == "__main__":
    main()
