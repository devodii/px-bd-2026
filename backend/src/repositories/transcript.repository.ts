import { randomUUID } from 'node:crypto';
import { Prisma, type PrismaClient } from '../generated/prisma/client.js';
import type { NormalizedChunk } from '../schemas/transcript.schema.js';
import type { ChunkRecord } from '../types/index.js';
import { toVectorLiteral } from '../providers/embeddings/embedding.provider.js';

export interface UpsertChunksResult {
  created: number;
  updated: number;
  unchanged: number;
}

export interface ChunkText {
  id: string;
  text: string;
}

export interface ChunkListItem {
  id: string;
  chunkIndex: number;
  startTime: number;
  endTime: number;
  text: string;
}

export interface EmbeddingBatchQuery {
  /** Keyset cursor: only chunks with id > afterId. */
  afterId: string | null;
  limit: number;
  /** Only chunks missing a vector or embedded by a different model, unless `force`. */
  model: string;
  force: boolean;
  sermonId?: string;
}

export interface TranscriptRepository {
  upsertChunks(sermonId: string, chunks: NormalizedChunk[]): Promise<UpsertChunksResult>;
  /** Chunks of a sermon that have no vector from `model` yet. */
  findChunksNeedingEmbedding(sermonId: string, model: string): Promise<ChunkText[]>;
  setEmbeddings(rows: { id: string; vector: number[] }[], model: string): Promise<number>;
  listBySermon(
    sermonId: string,
    opts: { from?: number; to?: number; limit: number; offset: number },
  ): Promise<{ chunks: ChunkListItem[]; total: number }>;
  getChunk(chunkId: string): Promise<ChunkRecord | null>;
  getChunkEmbedding(chunkId: string, model: string): Promise<number[] | null>;
  /** Mean vector of a sermon's chunks, or null if none are embedded with `model`. */
  getSermonCentroid(sermonId: string, model: string): Promise<number[] | null>;
  // --- reindexing ---
  nextEmbeddingBatch(query: EmbeddingBatchQuery): Promise<ChunkText[]>;
  rebuildSearchVectorBatch(
    afterId: string | null,
    limit: number,
    sermonId?: string,
  ): Promise<{ count: number; lastId: string | null }>;
}

export class PrismaTranscriptRepository implements TranscriptRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async upsertChunks(sermonId: string, chunks: NormalizedChunk[]): Promise<UpsertChunksResult> {
    if (chunks.length === 0) return { created: 0, updated: 0, unchanged: 0 };

    // Rewritten rows lose their vector when the text changed (it no longer describes the text);
    // rows whose content is identical are skipped entirely, which makes re-ingestion a no-op.
    const rows = await this.prisma.$queryRaw<{ inserted: boolean }[]>(Prisma.sql`
      INSERT INTO transcript_chunks
        (id, external_id, sermon_id, chunk_index, start_time, end_time, text, metadata, search_vector, created_at, updated_at)
      SELECT v.id, v.external_id, ${sermonId}::text, v.chunk_index, v.start_time, v.end_time, v.text,
             v.metadata::jsonb, to_tsvector('english', v.text), now(), now()
      FROM unnest(
        ${chunks.map(() => randomUUID())}::text[],
        ${chunks.map((c) => c.externalId)}::text[],
        ${chunks.map((c) => c.chunkIndex)}::int[],
        ${chunks.map((c) => c.startTime)}::float8[],
        ${chunks.map((c) => c.endTime)}::float8[],
        ${chunks.map((c) => c.text)}::text[],
        ${chunks.map((c) => (c.metadata ? JSON.stringify(c.metadata) : null))}::text[]
      ) AS v(id, external_id, chunk_index, start_time, end_time, text, metadata)
      ON CONFLICT (sermon_id, external_id) DO UPDATE SET
        chunk_index = EXCLUDED.chunk_index,
        start_time = EXCLUDED.start_time,
        end_time = EXCLUDED.end_time,
        metadata = EXCLUDED.metadata,
        search_vector = EXCLUDED.search_vector,
        embedding = CASE WHEN transcript_chunks.text = EXCLUDED.text THEN transcript_chunks.embedding END,
        embedding_model = CASE WHEN transcript_chunks.text = EXCLUDED.text THEN transcript_chunks.embedding_model END,
        text = EXCLUDED.text,
        updated_at = now()
      WHERE transcript_chunks.text IS DISTINCT FROM EXCLUDED.text
         OR transcript_chunks.chunk_index IS DISTINCT FROM EXCLUDED.chunk_index
         OR transcript_chunks.start_time IS DISTINCT FROM EXCLUDED.start_time
         OR transcript_chunks.end_time IS DISTINCT FROM EXCLUDED.end_time
         OR transcript_chunks.metadata IS DISTINCT FROM EXCLUDED.metadata
      RETURNING (xmax = 0) AS inserted
    `);

    const created = rows.filter((r) => r.inserted).length;
    return { created, updated: rows.length - created, unchanged: chunks.length - rows.length };
  }

  findChunksNeedingEmbedding(sermonId: string, model: string): Promise<ChunkText[]> {
    return this.prisma.$queryRaw<ChunkText[]>(Prisma.sql`
      SELECT id, text FROM transcript_chunks
      WHERE sermon_id = ${sermonId} AND (embedding IS NULL OR embedding_model IS DISTINCT FROM ${model})
      ORDER BY chunk_index
    `);
  }

  async setEmbeddings(rows: { id: string; vector: number[] }[], model: string): Promise<number> {
    if (rows.length === 0) return 0;
    return this.prisma.$executeRaw(Prisma.sql`
      UPDATE transcript_chunks c
      SET embedding = v.emb::vector, embedding_model = ${model}, updated_at = now()
      FROM unnest(${rows.map((r) => r.id)}::text[], ${rows.map((r) => toVectorLiteral(r.vector))}::text[]) AS v(id, emb)
      WHERE c.id = v.id
    `);
  }

  async listBySermon(
    sermonId: string,
    opts: { from?: number; to?: number; limit: number; offset: number },
  ): Promise<{ chunks: ChunkListItem[]; total: number }> {
    // A chunk is included when it overlaps [from, to].
    const where: Prisma.TranscriptChunkWhereInput = {
      sermonId,
      ...(opts.from !== undefined && { endTime: { gte: opts.from } }),
      ...(opts.to !== undefined && { startTime: { lte: opts.to } }),
    };
    const [chunks, total] = await Promise.all([
      this.prisma.transcriptChunk.findMany({
        where,
        orderBy: { startTime: 'asc' },
        skip: opts.offset,
        take: opts.limit,
        select: { id: true, chunkIndex: true, startTime: true, endTime: true, text: true },
      }),
      this.prisma.transcriptChunk.count({ where }),
    ]);
    return { chunks, total };
  }

  async getChunk(chunkId: string): Promise<ChunkRecord | null> {
    const row = await this.prisma.transcriptChunk.findUnique({
      where: { id: chunkId },
      include: { sermon: true },
    });
    if (!row) return null;
    return {
      chunkId: row.id,
      sermonId: row.sermonId,
      chunkIndex: row.chunkIndex,
      startTime: row.startTime,
      endTime: row.endTime,
      text: row.text,
      sermon: {
        id: row.sermon.id,
        title: row.sermon.title,
        date: row.sermon.date ? row.sermon.date.toISOString().slice(0, 10) : null,
        speaker: row.sermon.speaker,
        audioUrl: row.sermon.audioUrl,
      },
    };
  }

  async getChunkEmbedding(chunkId: string, model: string): Promise<number[] | null> {
    const rows = await this.prisma.$queryRaw<{ v: string }[]>(Prisma.sql`
      SELECT embedding::text AS v FROM transcript_chunks
      WHERE id = ${chunkId} AND embedding IS NOT NULL AND embedding_model = ${model}
    `);
    return rows[0] ? (JSON.parse(rows[0].v) as number[]) : null;
  }

  async getSermonCentroid(sermonId: string, model: string): Promise<number[] | null> {
    const rows = await this.prisma.$queryRaw<{ v: string | null }[]>(Prisma.sql`
      SELECT avg(embedding)::text AS v FROM transcript_chunks
      WHERE sermon_id = ${sermonId} AND embedding IS NOT NULL AND embedding_model = ${model}
    `);
    return rows[0]?.v ? (JSON.parse(rows[0].v) as number[]) : null;
  }

  nextEmbeddingBatch(q: EmbeddingBatchQuery): Promise<ChunkText[]> {
    const conditions: Prisma.Sql[] = [];
    if (q.afterId) conditions.push(Prisma.sql`id > ${q.afterId}`);
    if (q.sermonId) conditions.push(Prisma.sql`sermon_id = ${q.sermonId}`);
    if (!q.force)
      conditions.push(
        Prisma.sql`(embedding IS NULL OR embedding_model IS DISTINCT FROM ${q.model})`,
      );
    const where = conditions.length
      ? Prisma.sql`WHERE ${Prisma.join(conditions, ' AND ')}`
      : Prisma.empty;
    return this.prisma.$queryRaw<ChunkText[]>(Prisma.sql`
      SELECT id, text FROM transcript_chunks ${where} ORDER BY id LIMIT ${q.limit}
    `);
  }

  async rebuildSearchVectorBatch(
    afterId: string | null,
    limit: number,
    sermonId?: string,
  ): Promise<{ count: number; lastId: string | null }> {
    const conditions: Prisma.Sql[] = [];
    if (afterId) conditions.push(Prisma.sql`id > ${afterId}`);
    if (sermonId) conditions.push(Prisma.sql`sermon_id = ${sermonId}`);
    const where = conditions.length
      ? Prisma.sql`WHERE ${Prisma.join(conditions, ' AND ')}`
      : Prisma.empty;
    const rows = await this.prisma.$queryRaw<
      { count: number; last_id: string | null }[]
    >(Prisma.sql`
      WITH batch AS (SELECT id FROM transcript_chunks ${where} ORDER BY id LIMIT ${limit}),
      upd AS (
        UPDATE transcript_chunks c SET search_vector = to_tsvector('english', c.text)
        FROM batch WHERE c.id = batch.id RETURNING c.id
      )
      SELECT count(*)::int AS count, max(id) AS last_id FROM upd
    `);
    return { count: rows[0]?.count ?? 0, lastId: rows[0]?.last_id ?? null };
  }
}
