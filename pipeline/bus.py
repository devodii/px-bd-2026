"""Redis "doorbells" that wake workers up when new work lands.

Postgres is the source of truth for what needs doing; a ring only says "go look".
Workers also wake on a timeout, so a lost ring just delays work rather than losing it.
"""
import logging
import signal
import sys
from typing import Callable

import redis

from . import config

CHUNK = "px:doorbell:chunk"
TRANSCRIBE = "px:doorbell:transcribe"

_client: redis.Redis | None = None


def client() -> redis.Redis:
    global _client
    if _client is None:
        _client = redis.Redis.from_url(config.REDIS_URL)
    return _client


def ring(name: str) -> None:
    client().lpush(name, "1")


def setup_logging() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")


def run_worker(doorbell: str, process_next: Callable[[], bool], idle_timeout: int = 60) -> None:
    """Drain all claimable work, then sleep until the doorbell rings (or the timeout passes)."""
    # Turn `docker stop` into SystemExit so in-flight claims are released instead of going stale.
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
    r = client()
    while True:
        while process_next():
            pass
        if r.brpop([doorbell], timeout=idle_timeout):
            # Collapse any extra rings; the drain above will see everything they announced.
            r.delete(doorbell)
