# px-bd-2026

Sermon transcription pipeline: Telegram group → ffmpeg chunks → faster-whisper → Postgres + text files.
Everything runs in Docker; the only thing you need installed is Docker Desktop.

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

## Day to day

```sh
docker compose logs -f transcriber                        # watch progress
docker compose exec transcriber python -m pipeline.status # counts, speed, ETA, failures
docker compose exec transcriber python -m pipeline.status retry   # re-queue failed items
docker compose restart chunker transcriber                # after editing pipeline/*.py
```

Transcripts land in `data/transcripts/` as timestamped text, and in Postgres
(`localhost:54329`, user/password/db `px`) in the `chunks` table and the `sermon_transcripts` view.

## Speed

Docker on macOS can't use the Apple GPU, so Whisper runs on CPU. Give Docker Desktop as many CPUs as you
can spare (Settings → Resources) and match `WHISPER_CPU_THREADS` to that. `WHISPER_MODEL` trades accuracy
for speed: `small` is fast, `medium` is the default, `large-v3` is the most accurate and the slowest.
