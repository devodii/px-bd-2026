import { Prisma, type PrismaClient } from '../generated/prisma/client.js';
import type { ChunkRecord } from '../types/index.js';
import { distanceToSimilarity } from '../utils/scoring.js';
import { toVectorLiteral } from '../providers/embeddings/embedding.provider.js';

export interface SearchFilters {
  sermonId?: string | undefined;
  speaker?: string | undefined;
  dateFrom?: string | undefined;
  dateTo?: string | undefined;
}

/** A retrieved chunk. `score` is cosine similarity (0..1) for vector hits, raw rank for keyword hits. */
export interface ScoredChunk {
  chunk: ChunkRecord;
  score: number;
}

export interface VectorSearchParams {
  vector: number[];
  /** Only vectors produced by this model are compared (vectors from different models are incomparable). */
  model: string;
  /** When known, queries use the dimension-cast expression that the HNSW index (npm run vector-index) covers. */
  dimensions: number | null;
  limit: number;
  filters?: SearchFilters;
  excludeSermonId?: string;
}

export interface KeywordSearchParams {
  /** Prebuilt tsquery text (see keyword-search.service). null = no usable terms; only the phrase match applies. */
  tsQuery: string | null;
  /** The raw phrase, matched case-insensitively as a substring (drives exact matches like "Romans 8:28"). */
  phrase: string;
  limit: number;
  filters?: SearchFilters;
}

export interface SearchRepository {
  vectorSearch(params: VectorSearchParams): Promise<ScoredChunk[]>;
  keywordSearch(params: KeywordSearchParams): Promise<ScoredChunk[]>;
}

interface Row {
  chunk_id: string;
  sermon_id: string;
  chunk_index: number;
  start_time: number;
  end_time: number;
  text: string;
  title: string;
  speaker: string | null;
  date: string | null;
  audio_url: string | null;
  score: number;
}

const SELECT_COLUMNS = Prisma.sql`
  c.id AS chunk_id, c.sermon_id, c.chunk_index, c.start_time, c.end_time, c.text,
  s.title, s.speaker, to_char(s.date, 'YYYY-MM-DD') AS date, s.audio_url`;

function toChunk(r: Row): ChunkRecord {
  return {
    chunkId: r.chunk_id,
    sermonId: r.sermon_id,
    chunkIndex: r.chunk_index,
    startTime: r.start_time,
    endTime: r.end_time,
    text: r.text,
    sermon: {
      id: r.sermon_id,
      title: r.title,
      date: r.date,
      speaker: r.speaker,
      audioUrl: r.audio_url,
    },
  };
}

function filterConditions(filters: SearchFilters = {}, excludeSermonId?: string): Prisma.Sql[] {
  const c: Prisma.Sql[] = [];
  if (filters.sermonId) c.push(Prisma.sql`c.sermon_id = ${filters.sermonId}`);
  if (excludeSermonId) c.push(Prisma.sql`c.sermon_id <> ${excludeSermonId}`);
  if (filters.speaker) c.push(Prisma.sql`lower(s.speaker) = lower(${filters.speaker})`);
  if (filters.dateFrom) c.push(Prisma.sql`s.date >= ${filters.dateFrom}::date`);
  if (filters.dateTo) c.push(Prisma.sql`s.date <= ${filters.dateTo}::date`);
  return c;
}

/** Escapes LIKE wildcards so user input is matched literally. */
export function toLikePattern(phrase: string): string {
  return `%${phrase.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
}

export class PrismaSearchRepository implements SearchRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async vectorSearch(p: VectorSearchParams): Promise<ScoredChunk[]> {
    const literal = toVectorLiteral(p.vector);
    // With a known dimension, use the exact expression the expression-index is built on.
    const dims = p.dimensions ? Prisma.raw(String(Math.trunc(p.dimensions))) : null;
    const column = dims ? Prisma.sql`(c.embedding::vector(${dims}))` : Prisma.sql`c.embedding`;
    const query = dims ? Prisma.sql`${literal}::vector(${dims})` : Prisma.sql`${literal}::vector`;
    const conditions = [
      Prisma.sql`c.embedding IS NOT NULL`,
      Prisma.sql`c.embedding_model = ${p.model}`,
      ...filterConditions(p.filters, p.excludeSermonId),
    ];

    const rows = await this.prisma.$queryRaw<(Row & { distance: number })[]>(Prisma.sql`
      SELECT ${SELECT_COLUMNS}, (${column} <=> ${query}) AS distance
      FROM transcript_chunks c JOIN sermons s ON s.id = c.sermon_id
      WHERE ${Prisma.join(conditions, ' AND ')}
      ORDER BY ${column} <=> ${query}
      LIMIT ${p.limit}
    `);
    return rows.map((r) => ({ chunk: toChunk(r), score: distanceToSimilarity(r.distance) }));
  }

  async keywordSearch(p: KeywordSearchParams): Promise<ScoredChunk[]> {
    const pattern = toLikePattern(p.phrase);
    const conditions = [
      Prisma.sql`(c.search_vector @@ q.tsq OR c.text ILIKE ${pattern})`,
      ...filterConditions(p.filters),
    ];

    // Exact phrase hits get +1 so "Romans 8:28" outranks chunks that merely share some of its words.
    const rows = await this.prisma.$queryRaw<Row[]>(Prisma.sql`
      WITH q AS (SELECT to_tsquery('english', ${p.tsQuery}::text) AS tsq)
      SELECT ${SELECT_COLUMNS},
             (COALESCE(ts_rank_cd(c.search_vector, q.tsq, 32), 0)
              + CASE WHEN c.text ILIKE ${pattern} THEN 1 ELSE 0 END)::float8 AS score
      FROM transcript_chunks c JOIN sermons s ON s.id = c.sermon_id, q
      WHERE ${Prisma.join(conditions, ' AND ')}
      ORDER BY score DESC, c.id
      LIMIT ${p.limit}
    `);
    return rows.map((r) => ({ chunk: toChunk(r), score: r.score }));
  }
}
