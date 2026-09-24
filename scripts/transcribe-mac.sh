#!/usr/bin/env bash
# Runs the transcriber natively on Apple Silicon (GPU via MLX) against the Docker postgres/redis.
set -euo pipefail
cd "$(dirname "$0")/.."

if [ ! -x .venv/bin/python ]; then
  python3 -m venv .venv
  .venv/bin/pip install -q --upgrade pip
  .venv/bin/pip install -q mlx-whisper "psycopg[binary]>=3.2,<4" "redis>=5,<6"
fi

set -a; source .env; set +a
export WHISPER_BACKEND=mlx
# Once the model is cached, don't phone home to Hugging Face, so the transcriber also starts offline.
repo="${MLX_WHISPER_MODEL:-mlx-community/whisper-large-v3-turbo}"
[ -d "$HOME/.cache/huggingface/hub/models--${repo//\//--}" ] && export HF_HUB_OFFLINE=1
export DATA_DIR="$PWD/data"
export DATABASE_URL="postgresql://px:px@localhost:${POSTGRES_PORT:-54329}/px"
export REDIS_URL="redis://localhost:${REDIS_PORT:-63790}/0"

# caffeinate keeps the Mac awake for as long as the transcriber runs
exec caffeinate -i .venv/bin/python -m pipeline.transcriber
