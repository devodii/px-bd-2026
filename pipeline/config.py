import os
from pathlib import Path

DATABASE_URL = os.environ["DATABASE_URL"]
REDIS_URL = os.environ["REDIS_URL"]

DATA_DIR = Path(os.environ.get("DATA_DIR", "/data"))
INBOX_DIR = DATA_DIR / "inbox"
RAW_DIR = DATA_DIR / "raw"
CHUNKS_DIR = DATA_DIR / "chunks"
TRANSCRIPTS_DIR = DATA_DIR / "transcripts"

TG_API_ID = int(os.environ.get("TG_API_ID") or 0)
TG_API_HASH = os.environ.get("TG_API_HASH", "")
TG_BOT_TOKEN = os.environ.get("TG_BOT_TOKEN", "").strip()
TG_BOT_SESSION = os.environ.get("TG_BOT_SESSION", "/secrets/bot")
# Optional comma-separated Telegram user ids allowed to send files; empty = anyone who finds the bot.
TG_ALLOWED_USER_IDS = {int(x) for x in os.environ.get("TG_ALLOWED_USER_IDS", "").replace(" ", "").split(",") if x}

CHUNK_SECONDS = int(os.environ.get("CHUNK_SECONDS") or 300)

WHISPER_MODEL = os.environ.get("WHISPER_MODEL") or "medium"
WHISPER_COMPUTE_TYPE = os.environ.get("WHISPER_COMPUTE_TYPE") or "int8"
WHISPER_CPU_THREADS = int(os.environ.get("WHISPER_CPU_THREADS") or 8)
WHISPER_LANGUAGE = os.environ.get("WHISPER_LANGUAGE") or None
WHISPER_BEAM_SIZE = int(os.environ.get("WHISPER_BEAM_SIZE") or 5)
WHISPER_INITIAL_PROMPT = os.environ.get("WHISPER_INITIAL_PROMPT") or None
WHISPER_MODELS_DIR = os.environ.get("WHISPER_MODELS_DIR", "/models")

MAX_ATTEMPTS = 3
# A claim older than this is assumed to belong to a crashed worker and is picked up again.
STALE_CLAIM_SECONDS = 30 * 60

MEDIA_EXTS = {
    ".mp3", ".m4a", ".aac", ".wav", ".ogg", ".oga", ".opus", ".flac", ".wma", ".amr",
    ".mp4", ".mov", ".mkv", ".webm", ".avi", ".3gp",
}
