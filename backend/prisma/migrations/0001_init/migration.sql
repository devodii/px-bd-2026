-- pgvector must be available in the database (the docker-compose image ships it).
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE "sermons" (
    "id" TEXT NOT NULL,
    "external_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "speaker" TEXT,
    "date" DATE,
    "description" TEXT,
    "audio_url" TEXT,
    "duration" DOUBLE PRECISION,
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sermons_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "transcript_chunks" (
    "id" TEXT NOT NULL,
    "external_id" TEXT NOT NULL,
    "sermon_id" TEXT NOT NULL,
    "chunk_index" INTEGER NOT NULL,
    "start_time" DOUBLE PRECISION NOT NULL,
    "end_time" DOUBLE PRECISION NOT NULL,
    "text" TEXT NOT NULL,
    -- No dimension on purpose: it is decided by the embedding provider (see `npm run vector-index`).
    "embedding" vector,
    "embedding_model" TEXT,
    "search_vector" tsvector,
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "transcript_chunks_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "sermons_external_id_key" ON "sermons"("external_id");
CREATE UNIQUE INDEX "sermons_slug_key" ON "sermons"("slug");
CREATE INDEX "sermons_date_idx" ON "sermons"("date");
CREATE INDEX "sermons_speaker_idx" ON "sermons"("speaker");

CREATE UNIQUE INDEX "transcript_chunks_sermon_id_external_id_key" ON "transcript_chunks"("sermon_id", "external_id");
CREATE UNIQUE INDEX "transcript_chunks_sermon_id_chunk_index_key" ON "transcript_chunks"("sermon_id", "chunk_index");
CREATE INDEX "transcript_chunks_sermon_id_start_time_idx" ON "transcript_chunks"("sermon_id", "start_time");

ALTER TABLE "transcript_chunks"
  ADD CONSTRAINT "transcript_chunks_sermon_id_fkey"
  FOREIGN KEY ("sermon_id") REFERENCES "sermons"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Full-text search (maintained by the app: ingestion + reindex write search_vector).
CREATE INDEX "transcript_chunks_search_vector_idx" ON "transcript_chunks" USING GIN ("search_vector");

-- Trigram index for fuzzy sermon/speaker lookup and exact-ish phrase matching such as "Romans 8:28".
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX "transcript_chunks_text_trgm_idx" ON "transcript_chunks" USING GIN ("text" gin_trgm_ops);
CREATE INDEX "sermons_title_trgm_idx" ON "sermons" USING GIN ("title" gin_trgm_ops);
