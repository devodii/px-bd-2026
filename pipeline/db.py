import psycopg
from psycopg.rows import dict_row

from . import config

# Sermon lifecycle: downloaded -> chunking -> chunked -> transcribed (or failed)
# Chunk lifecycle:  pending -> processing -> done (or failed after MAX_ATTEMPTS)
# chunks.path is relative to DATA_DIR, which differs between Docker (/data) and the Mac (./data).
SCHEMA = """
CREATE TABLE IF NOT EXISTS sermons (
    id            BIGSERIAL PRIMARY KEY,
    source_key    TEXT NOT NULL UNIQUE,
    tg_chat_id    BIGINT,
    tg_message_id BIGINT,
    file_name     TEXT NOT NULL,
    mime_type     TEXT,
    size_bytes    BIGINT,
    caption       TEXT,
    posted_at     TIMESTAMPTZ,
    raw_path      TEXT NOT NULL,
    duration_sec  DOUBLE PRECISION,
    status        TEXT NOT NULL DEFAULT 'downloaded',
    attempts      INT NOT NULL DEFAULT 0,
    error         TEXT,
    claimed_at    TIMESTAMPTZ,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS chunks (
    id                 BIGSERIAL PRIMARY KEY,
    sermon_id          BIGINT NOT NULL REFERENCES sermons(id) ON DELETE CASCADE,
    idx                INT NOT NULL,
    start_sec          DOUBLE PRECISION NOT NULL,
    duration_sec       DOUBLE PRECISION NOT NULL,
    path               TEXT NOT NULL,
    status             TEXT NOT NULL DEFAULT 'pending',
    attempts           INT NOT NULL DEFAULT 0,
    text               TEXT,
    segments           JSONB,
    language           TEXT,
    model              TEXT,
    transcribe_seconds DOUBLE PRECISION,
    error              TEXT,
    claimed_at         TIMESTAMPTZ,
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (sermon_id, idx)
);

ALTER TABLE chunks ADD COLUMN IF NOT EXISTS flagged_segments INT;

CREATE INDEX IF NOT EXISTS sermons_status_idx ON sermons (status);
CREATE INDEX IF NOT EXISTS chunks_status_idx ON chunks (status);

CREATE OR REPLACE VIEW sermon_transcripts AS
SELECT s.id, s.file_name, s.caption, s.posted_at, s.duration_sec,
       string_agg(c.text, ' ' ORDER BY c.idx) AS transcript
FROM sermons s
JOIN chunks c ON c.sermon_id = s.id
WHERE s.status = 'transcribed'
GROUP BY s.id;
"""


def connect() -> psycopg.Connection:
    conn = psycopg.connect(config.DATABASE_URL, row_factory=dict_row, autocommit=True)
    with conn.transaction():
        # Every service calls this on startup; the lock stops concurrent CREATEs from racing.
        conn.execute("SELECT pg_advisory_xact_lock(20260924)")
        conn.execute(SCHEMA)
    return conn
