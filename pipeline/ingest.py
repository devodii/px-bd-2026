"""Get sermon media into the pipeline.

    bot           run the Telegram bot: send or forward sermon audio/video to it (what the compose service runs)
    import-local  register files dropped into ./data/inbox (no Telegram needed)

The bot connects over MTProto (Telethon) rather than the HTTP Bot API, because the HTTP Bot API
can't download files over 20 MB and sermons are much bigger.
"""
import asyncio
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

    await client.download_media(msg, file=str(part), progress_callback=progress)
    part.rename(dest)
    fwd = msg.fwd_from
    register(conn, source_key=source_key, tg_chat_id=msg.chat_id, tg_message_id=msg.id,
             file_name=name, mime_type=f.mime_type, size_bytes=f.size, caption=msg.message or None,
             posted_at=(fwd.date if fwd else msg.date), raw_path=str(dest))
    log.info("saved %s", dest.name)
    return f"Saved {name} ({(f.size or 0) / 1e6:.0f} MB)"


async def run_bot() -> None:
    from telethon import TelegramClient, events

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
    log.info("bot @%s is listening; send or forward sermon audio to it", me.username)

    one_at_a_time = asyncio.Lock()

    @client.on(events.NewMessage(incoming=True, func=lambda e: e.is_private))
    async def on_message(event):
        if config.TG_ALLOWED_USER_IDS and event.sender_id not in config.TG_ALLOWED_USER_IDS:
            log.warning("ignoring message from unlisted user %s", event.sender_id)
            return
        if not is_media(event.message):
            await event.reply(f"Send or forward sermon audio/video files here. (your user id: {event.sender_id})")
            return
        async with one_at_a_time:
            try:
                result = await download(client, conn, event.message)
            except Exception as e:
                log.exception("download failed")
                result = f"Failed to save {event.message.file.name or 'file'}: {e}"
        await event.reply(result)

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
