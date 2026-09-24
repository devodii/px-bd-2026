"""Get sermon media into the pipeline.

    login                     one-time interactive Telegram login (phone number + code)
    send-code <phone>         non-interactive login, step 1: Telegram texts a code to the phone
    verify <code> [password]  non-interactive login, step 2 (password only if 2FA is on)
    logout                    end the session on Telegram's side and delete the local session file
    list-chats    print the groups/channels this account can see, with their ids
    sync          download every new audio/video message from TG_GROUP, then exit
    watch         sync every TG_POLL_SECONDS (what the compose service runs)
    import-local  register files dropped into ./data/inbox (no Telegram needed)
"""
import asyncio
import json
import logging
import re
import sys
from pathlib import Path

from . import bus, config, db

log = logging.getLogger("ingest")


class NotReady(Exception):
    """Telegram isn't configured or logged in yet — a setup step for a human, not a crash."""


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


# --- telegram ------------------------------------------------------------------------------------

def make_client():
    from telethon import TelegramClient

    if not config.TG_API_ID or not config.TG_API_HASH:
        raise NotReady("Set TG_API_ID and TG_API_HASH in .env (create them at https://my.telegram.org -> API development tools)")
    Path(config.TG_SESSION).parent.mkdir(parents=True, exist_ok=True)
    return TelegramClient(config.TG_SESSION, config.TG_API_ID, config.TG_API_HASH)


async def login() -> None:
    client = make_client()
    await client.start()  # prompts for phone number, login code and 2FA password if set
    me = await client.get_me()
    print(f"Logged in as {me.first_name} (@{me.username}). Session saved to {config.TG_SESSION}.session")
    await client.disconnect()


def pending_login_path() -> Path:
    return Path(config.TG_SESSION).with_name("pending-login.json")


async def send_code(phone: str) -> None:
    client = make_client()
    await client.connect()
    sent = await client.send_code_request(phone)
    pending_login_path().write_text(json.dumps({"phone": phone, "hash": sent.phone_code_hash}))
    print(f"Code sent to {phone}. Next: verify <code>")
    await client.disconnect()


async def verify(code: str, password: str | None = None) -> None:
    from telethon.errors import SessionPasswordNeededError

    pending = json.loads(pending_login_path().read_text())
    client = make_client()
    await client.connect()
    try:
        await client.sign_in(pending["phone"], code, phone_code_hash=pending["hash"])
    except SessionPasswordNeededError:
        if not password:
            sys.exit("This account has two-step verification. Run: verify <code> <password>")
        await client.sign_in(password=password)
    pending_login_path().unlink()
    me = await client.get_me()
    print(f"Logged in as {me.first_name} (@{me.username}).")
    await client.disconnect()


async def logout() -> None:
    client = make_client()
    await client.connect()
    if await client.is_user_authorized():
        await client.log_out()  # revokes the session server-side and deletes the .session file
        print("Logged out; session revoked on Telegram and deleted locally.")
    else:
        await client.disconnect()
        Path(config.TG_SESSION + ".session").unlink(missing_ok=True)
        print("No active login; local session file removed.")


async def list_chats() -> None:
    async with await connected_client() as client:
        async for d in client.iter_dialogs():
            if d.is_group or d.is_channel:
                print(f"{d.id:>16}  {d.name}")


async def connected_client():
    client = make_client()
    await client.connect()
    if not await client.is_user_authorized():
        await client.disconnect()
        raise NotReady("Telegram not logged in. Run: docker compose run --rm ingest login")
    return client


async def resolve_group(client):
    if not config.TG_GROUP:
        raise NotReady("Set TG_GROUP in .env (run `docker compose run --rm ingest list-chats` to find the id)")
    async for d in client.iter_dialogs():
        if str(d.id) == config.TG_GROUP or d.name.strip().lower() == config.TG_GROUP.lower():
            return d.entity
    return await client.get_entity(config.TG_GROUP)  # @username or t.me link


def is_media(msg) -> bool:
    f = msg.file
    if not f:
        return False
    mime = f.mime_type or ""
    return mime.startswith(("audio/", "video/")) or (f.ext or "").lower() in config.MEDIA_EXTS


async def sync(client, conn) -> None:
    group = await resolve_group(client)
    chat_id = group.id
    seen = {r["tg_message_id"] for r in conn.execute("SELECT tg_message_id FROM sermons WHERE tg_chat_id = %s", (chat_id,))}
    config.RAW_DIR.mkdir(parents=True, exist_ok=True)

    new = 0
    async for msg in client.iter_messages(group, reverse=True):
        if msg.id in seen or not is_media(msg):
            continue
        f = msg.file
        name = f.name or f"{msg.id}{f.ext or ''}"
        dest = config.RAW_DIR / f"{msg.id}_{safe_name(name)}"
        part = dest.with_name(dest.name + ".part")
        log.info("downloading %s (%.1f MB)", name, (f.size or 0) / 1e6)

        last_logged = [0]

        def progress(done, total, last_logged=last_logged):
            pct = int(done * 100 / total) if total else 0
            if pct >= last_logged[0] + 20:
                last_logged[0] = pct
                log.info("  %s: %d%%", name, pct)

        await client.download_media(msg, file=str(part), progress_callback=progress)
        part.rename(dest)
        register(conn, source_key=f"tg:{chat_id}:{msg.id}", tg_chat_id=chat_id, tg_message_id=msg.id,
                 file_name=name, mime_type=f.mime_type, size_bytes=f.size, caption=msg.message or None,
                 posted_at=msg.date, raw_path=str(dest))
        new += 1
    log.info("sync: %d new file(s) from %r", new, getattr(group, "title", config.TG_GROUP))


async def sync_once() -> None:
    conn = db.connect()
    async with await connected_client() as client:
        await sync(client, conn)


async def watch() -> None:
    conn = db.connect()
    while True:
        try:
            async with await connected_client() as client:
                await sync(client, conn)
        except NotReady as e:
            log.warning("%s (checking again in 60s)", e)
            await asyncio.sleep(60)
            continue
        await asyncio.sleep(config.TG_POLL_SECONDS)


def main() -> None:
    bus.setup_logging()
    cmd = sys.argv[1] if len(sys.argv) > 1 else "watch"
    commands = {
        "login": lambda: asyncio.run(login()),
        "send-code": lambda: asyncio.run(send_code(*sys.argv[2:3])),
        "verify": lambda: asyncio.run(verify(*sys.argv[2:4])),
        "logout": lambda: asyncio.run(logout()),
        "list-chats": lambda: asyncio.run(list_chats()),
        "sync": lambda: asyncio.run(sync_once()),
        "watch": lambda: asyncio.run(watch()),
        "import-local": import_local,
    }
    if cmd not in commands:
        sys.exit(__doc__)
    try:
        commands[cmd]()
    except NotReady as e:
        sys.exit(str(e))


if __name__ == "__main__":
    main()
