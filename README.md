# px-bd-2026

Sermon transcription pipeline: Telegram bot → ffmpeg chunks → Whisper → Postgres + text files.
Postgres, Redis, the bot and the chunker run in Docker. Transcription runs natively on a Mac's GPU.

```
telegram bot ──ingest──▶ data/raw ──chunker──▶ data/chunks (5-min FLAC) ──transcriber──▶ postgres + data/transcripts/*.txt
                               ▲                          redis doorbells wake each stage
                 data/inbox ───┘ (import-local)
```

## Setup

```sh
cp .env.example .env    # fill in TG_API_ID / TG_API_HASH (https://my.telegram.org) and TG_BOT_TOKEN (@BotFather)
docker compose up -d --build
```

Then open the bot in Telegram and send or forward the sermon audio/video files to it. It replies
"Saved ..." for each file, and chunking starts right away. The bot uses MTProto instead of the HTTP
Bot API, which can't download files over 20 MB. After editing `.env`, run `docker compose up -d` again
so the containers pick up the change.

No Telegram? Drop audio/video files into `data/inbox/` and run `docker compose run --rm ingest import-local`.

## Transcribing (Mac, Apple Silicon)

```sh
./scripts/transcribe-mac.sh    # first run creates .venv and downloads whisper-large-v3-turbo (~1.6 GB)
```

It runs on the GPU through MLX at about 20x realtime on an M1 Pro, and keeps the Mac awake while it works.
Without a Mac, `docker compose --profile docker-cpu up -d transcriber` runs a CPU version in Docker, which is much slower.

Lines Whisper was unsure about (low confidence, repetition loops, likely no speech) are flagged in
`chunks.segments[].flags` and marked `[?]` in the transcript files.

## Day to day

```sh
docker compose logs -f ingest chunker                          # bot downloads and chunking
docker compose exec chunker python -m pipeline.status          # counts, speed, ETA, failures
docker compose exec chunker python -m pipeline.status retry    # re-queue failed items
docker compose restart ingest chunker                          # after editing pipeline/*.py
```

Transcripts land in `data/transcripts/` as timestamped text, and in Postgres
(`localhost:54329`, database `px`, user `px`, password `POSTGRES_PASSWORD` from `.env`) in the
`chunks` table and the `sermon_transcripts` view.

To share the database: set strong `POSTGRES_PASSWORD` / `POSTGRES_READER_PASSWORD` values, set
`POSTGRES_BIND=0.0.0.0`, run `docker compose up -d` and `./scripts/create-reader.sh`, then give people
the read-only `pxreader` login.

## Search API

`backend/` is a separate Node/TypeScript service that makes the finished transcripts searchable
(semantic + keyword + JEV relevance judging, related teachings, optional answers). It has its own
Postgres + pgvector container and can read finished chunks from this pipeline's database. See
[`backend/README.md`](backend/README.md).
