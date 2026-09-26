# Sermon search API

Semantic + keyword search over transcribed sermon chunks, with optional JEV judging and an
optional "ask" layer. Node 20+, TypeScript, Express, PostgreSQL + pgvector, Prisma 7, Zod, Pino, Vitest.

It sits next to the Python transcription pipeline in this repo and never modifies it: it has its own
database (own container, own `search` schema) and can read finished chunks from the pipeline's
Postgres with `npm run ingest -- --from-pipeline`.

```
transcript chunks ─▶ normalize ─▶ store ─▶ embed ─▶ Postgres + pgvector
                                                          │
query ─▶ intent (heuristic / JEV) ┐                       │
      ─▶ embed ─▶ vector search ──┼─▶ merge (RRF, dedupe, ≤50) ─▶ JEV relevance ─▶ top 10
      ─▶ full-text + phrase ──────┘                       (optional)
                                                          └─▶ AnswerService (optional, separate)
```

## Status: what is real and what is a placeholder

| Piece                                                              | State                                                                                                                                                                                                     |
| ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ingestion, storage, full-text + phrase search, filters, timestamps | Working                                                                                                                                                                                                   |
| Vector search, related teachings, reindex                          | Working, **waiting for an embedding provider**                                                                                                                                                            |
| **Embedding provider**                                             | **Placeholder** (someone else is implementing it, see [below](#configure-embeddings)). Until then ingestion stores chunks without vectors and search runs keyword-only, with a warning in `meta.warnings` |
| JEV                                                                | Working through `@typesafe-ai/sdk`. Needs `JEV_API_KEY`; without it search skips JEV                                                                                                                      |
| LLM (`POST /api/answer`)                                           | Service, prompt and source-attribution enforcement are done and tested; the **vendor adapter is a placeholder** and the endpoint answers `503 LLM_UNAVAILABLE` until one is added                         |

## Quick start

```sh
cd backend
npm install                       # also generates the Prisma client (src/generated/prisma, git-ignored)
cp .env.example .env              # set INGESTION_API_KEY (openssl rand -hex 32) and, later, JEV_API_KEY
docker compose up -d              # Postgres 16 + pgvector on localhost:54330 (separate from the pipeline's DB)
npm run prisma:migrate            # applies prisma/migrations
npm run dev                       # http://localhost:4000
```

`curl localhost:4000/api/health` shows the database state and which providers are configured (never keys).

### Ingest existing chunks

```sh
# a JSON array, {"chunks": [...]}, or JSONL
npm run ingest -- path/to/chunks.json

# or straight from the Python pipeline's Postgres (PIPELINE_DATABASE_URL, default localhost:54329)
npm run ingest -- --from-pipeline
```

or over HTTP (up to 500 rows per request, key required):

```sh
curl -X POST localhost:4000/api/ingestion/chunks \
  -H "x-api-key: $INGESTION_API_KEY" -H 'content-type: application/json' \
  -d '{"chunks":[{"sermonId":"sermon_123","chunkId":"chunk_001","title":"Walking By Faith",
       "date":"2026-01-12","speaker":"Pastor Name","audioUrl":"https://…","startTime":184,"endTime":247,
       "text":"Faith does not mean..."}]}'
```

Ingestion is idempotent: sermons are keyed by `sermonId`, chunks by `(sermon, chunkId)`. Re-sending the
same data changes nothing and re-embeds nothing; changed text updates the chunk and drops its stale
vector. Invalid rows are reported (`rejected: [{index, errors}]`) while valid ones go through. The
response carries statistics, including `embeddings.status` (`complete | skipped | failed | not-needed`).
A failed or skipped embedding never loses the text; `reindex` completes the job later.

The source format is flexible. `src/services/ingestion/chunk-normalizer.ts` is the only place that
knows it, and already accepts the canonical shape, snake_case, `start_sec` + `duration_sec`,
`file_name`/`posted_at` (the Python pipeline's columns) and `mm:ss` / `hh:mm:ss` timestamps. If the
real export differs, extend its `ALIASES` table.

### Reindex

```sh
npm run reindex                          # embed chunks with no vector from the current EMBEDDING_MODEL
npm run reindex -- --force               # re-embed everything
npm run reindex -- --search-vectors      # also rebuild the tsvector columns
npm run reindex -- --no-embeddings --search-vectors
npm run reindex -- --sermon <id> --batch 100
```

Works in keyset-paginated batches (`EMBEDDING_BATCH_SIZE`), retries retryable provider errors with
backoff, and never deletes data. Over HTTP: `POST /api/ingestion/reindex` (returns `202`, runs in the
background, one at a time) and `GET /api/ingestion/reindex` for progress.

**Migrating to a different embedding model:** set the new `EMBEDDING_MODEL` (and `EMBEDDING_DIMENSIONS`),
run `npm run reindex`. Every vector is stored with the model that produced it, searches only compare
vectors from the current model, and chunks embedded by another model count as stale, so old and new
vectors are never mixed. If the dimension changed, also run `npm run vector-index`.

### Tests

```sh
npm test            # unit + API tests with all providers mocked, plus real-SQL tests (see below)
npm run typecheck && npm run lint
```

No test makes a real JEV, embedding or LLM call. `tests/integration/sql.test.ts` runs the actual
migration and repository SQL against [PGlite](https://pglite.dev) (WASM Postgres with pgvector and
pg_trgm), so the raw queries are verified without Docker.

## API

| Method | Path                                               | Notes                                                                   |
| ------ | -------------------------------------------------- | ----------------------------------------------------------------------- |
| GET    | `/api/search?q=…&limit=10&type=hybrid`             | filters: `sermonId`, `speaker`, `dateFrom`, `dateTo`                    |
| POST   | `/api/search`                                      | `{query, limit?, searchType?, sermonId?, speaker?, dateFrom?, dateTo?}` |
| GET    | `/api/sermons/:id`                                 | `:id` is the id, slug, or your source `sermonId`                        |
| GET    | `/api/sermons/:id/chunks?from=&to=&limit=&offset=` | `from`/`to` in seconds: chunks overlapping that window                  |
| GET    | `/api/sermons/:id/related?limit=5&chunkId=`        | similar sermons with timestamps, one entry per sermon                   |
| POST   | `/api/answer`                                      | `{query, evidenceLimit?, …filters}` → `{answer, answered, sources[]}`   |
| POST   | `/api/ingestion/sermons`, `/chunks`, `/reindex`    | `x-api-key` (or `Authorization: Bearer`) required                       |
| GET    | `/api/ingestion/reindex`                           | reindex progress                                                        |
| GET    | `/api/health`                                      | database + which providers are configured                               |

Search response (`searchType` is what actually ran, which can differ from the request after a fallback):

```json
{
  "query": "faith during difficult seasons",
  "results": [
    {
      "sermon": {
        "id": "…",
        "title": "Walking By Faith",
        "date": "2026-01-12",
        "speaker": "Pastor Name"
      },
      "chunk": { "id": "…", "startTime": 184, "endTime": 247, "text": "…" },
      "relevance": { "score": 0.94, "source": "jev" },
      "audio": { "url": "https://…", "startTime": 184 }
    }
  ],
  "meta": {
    "total": 10,
    "searchType": "hybrid",
    "intent": "TOPIC_SEARCH",
    "jev": "applied",
    "warnings": []
  }
}
```

`audio` is everything a player needs for "jump to timestamp". `relevance.source` is `jev` when JEV judged
the chunk, `retrieval` otherwise. Errors always look like `{"error": {"code", "message", "requestId", "details?"}}`.

## Failure behaviour

| What fails                               | What happens                                                                                                                                    |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| JEV (down, slow, rate-limited, no key)   | Retrieval ranking is returned; `meta.jev: "failed"` + a warning. Intent falls back to rules. Individual judgments that fail get a neutral score |
| Embedding provider, `hybrid` (default)   | Keyword-only results + `EMBEDDING_UNAVAILABLE` warning                                                                                          |
| Embedding provider, `semantic` requested | `503 EMBEDDING_UNAVAILABLE`                                                                                                                     |
| Vector query errors                      | Falls back to keyword search + warning                                                                                                          |
| Both retrieval paths fail                | `500 SEARCH_FAILED`                                                                                                                             |
| LLM                                      | Only `/api/answer` is affected (`503 LLM_UNAVAILABLE`)                                                                                          |

## How JEV fits in

JEV (TypeSafe System One) is a **judge, not an embedding model**. It never sees the database and never
produces vectors. Retrieval finds a bounded candidate set (`vector 30 + keyword 20`, merged and
de-duplicated to at most `SEARCH_MERGE_LIMIT=50`), and JEV then scores each candidate for relevance to
the query:

- one **Noul** ("does this passage directly address what the query is looking for?") per candidate,
  run in parallel up to `JEV_CONCURRENCY`, bounded by an overall deadline;
- one **Choice** over the six `SearchIntent`s for the query (skipped for obvious Bible references,
  which are detected by rule);
- final score = `0.75 × JEV + 0.25 × retrieval`; candidates below `SEARCH_MIN_RELEVANCE` are dropped.

Transcript text is untrusted: it is sanitized, length-capped and sent only as a field of `state`, never
spliced into instructions, and the question tells JEV to ignore instructions inside the passage.

All JEV code lives in `src/providers/jev/` and uses `@typesafe-ai/sdk`. The SDK is configured with
`JEV_API_KEY`, optional `JEV_BASE_URL` (SDK default if empty) and `JEV_MODEL` (SDK default `jev-latest`
if empty). Only `TypeSafeJevProvider` imports the SDK. Keep the API key server-side.

### Replace JEV

Implement `JevProvider` (`src/providers/jev/jev.provider.ts`: `classifyIntent`, `evaluateRelevance`,
`isConfigured`) and return it from `createJevProvider()` in `jev.client.ts`. Throw `JevError` on failure.
Nothing else changes; `SearchService` only sees the interface. To drop JEV entirely, unset
`JEV_API_KEY`.

## Configure embeddings

**Placeholder for now.** `EMBEDDING_PROVIDER=placeholder` selects `PlaceholderEmbeddingProvider`, which
reports itself as unconfigured and throws `EmbeddingProviderError` when called. No dimension is
hard-coded anywhere: the `embedding` column is a dimension-less `vector`.

### Replace the embedding provider (for whoever picks this up)

1. Implement `EmbeddingProvider` (`src/providers/embeddings/embedding.provider.ts`):
   `embedText`, `embedTexts` (batch), `isConfigured()`, plus `model` (stored next to every vector) and
   `dimensions`. Apply a timeout, back off on rate limits, and throw `EmbeddingProviderError`
   (`retryable = true` for 429/5xx/timeouts).
2. Register it in `createEmbeddingProvider()` in `embedding.client.ts` under a new `EMBEDDING_PROVIDER` name.
3. Set `EMBEDDING_PROVIDER`, `EMBEDDING_API_KEY`, `EMBEDDING_MODEL`, `EMBEDDING_DIMENSIONS`.
4. `npm run reindex` to embed everything already ingested, then `npm run vector-index` to create the HNSW index.
   Queries already use the matching `embedding::vector(N)` expression, so no code change is needed.
5. Vectors should be comparable with cosine distance (search uses `<=>`).

Controllers never call an embedding API; only `SemanticSearchService`, `IngestionService`,
`ReindexService` and `RelatedTeachingService` use the provider interface.

## Layout

```
src/
  app.ts  server.ts  container.ts     app factory, entrypoint, composition root (the only place classes are wired)
  config/env.ts                       Zod-validated env
  controllers/ routes/                thin: parse → call service → respond
  services/{search,ingestion,sermons,related,answer}   business logic
  repositories/                       all SQL (Prisma + raw SQL for pgvector/tsvector)
  providers/{embeddings,jev,llm}      third-party integrations behind interfaces
  schemas/ middleware/ utils/ types/
prisma/  schema.prisma, migrations/   hand-written migration (Prisma can't model vector/tsvector)
scripts/ ingest.ts reindex.ts vector-index.ts
tests/   search/ ingestion/ providers/ related/ answer/ integration/
```

## Security notes

API key on all ingestion/reindex routes (constant-time comparison; with no `INGESTION_API_KEY` set they
answer `503` instead of being open), Zod validation everywhere, body size limits, query length limit
(`MAX_QUERY_LENGTH`), Helmet, per-route rate limits (`RATE_LIMIT_PER_MINUTE`, stricter for ingestion and
answers), CORS only for `CORS_ORIGINS`, centralized error handler that never returns stack traces, SQL
or provider payloads, Pino redaction of credentials, and untrusted-text handling for JEV/LLM.
If deployed behind a reverse proxy, set Express `trust proxy` so rate limiting sees client IPs.

## Known limits

- Bible-reference search is text-based: `Romans 8:28` matches transcripts that say it that way. Spoken
  forms ("Romans chapter eight, verse twenty-eight") need JEV/semantic search or a normalizer, which is
  not built yet.
- `reindex` progress is in memory (one API process); the CLI is the robust path for very large runs.
- The vector query filters by model but the HNSW index is per dimension: if you switch to a different
  dimension, re-embed with `--force` before running `vector-index`.
