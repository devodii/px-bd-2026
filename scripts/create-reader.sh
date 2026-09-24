#!/usr/bin/env bash
# Creates (or resets) the read-only `pxreader` login using POSTGRES_READER_PASSWORD from .env.
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; source .env; set +a
: "${POSTGRES_READER_PASSWORD:?set POSTGRES_READER_PASSWORD in .env}"
docker compose exec -T postgres psql -U px -d px -v ON_ERROR_STOP=1 -q -v pw="$POSTGRES_READER_PASSWORD" <<'SQL'
SELECT NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'pxreader') AS missing \gset
\if :missing
  CREATE ROLE pxreader LOGIN;
\endif
ALTER ROLE pxreader PASSWORD :'pw';
GRANT CONNECT ON DATABASE px TO pxreader;
GRANT USAGE ON SCHEMA public TO pxreader;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO pxreader;
ALTER DEFAULT PRIVILEGES FOR ROLE px IN SCHEMA public GRANT SELECT ON TABLES TO pxreader;
SQL
echo "pxreader ready (read-only)"
