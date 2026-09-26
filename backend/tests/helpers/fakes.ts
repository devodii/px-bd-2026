import { vi } from 'vitest';
import type { EmbeddingProvider } from '../../src/providers/embeddings/embedding.provider.js';
import type { JevProvider } from '../../src/providers/jev/jev.provider.js';
import type { RelevanceInput } from '../../src/providers/jev/jev.types.js';
import type { LlmProvider } from '../../src/providers/llm/llm.provider.js';
import type {
  KeywordSearchParams,
  ScoredChunk,
  SearchRepository,
  VectorSearchParams,
} from '../../src/repositories/search.repository.js';
import type { SermonRecord, SermonRepository } from '../../src/repositories/sermon.repository.js';
import type {
  ChunkListItem,
  ChunkText,
  TranscriptRepository,
  UpsertChunksResult,
} from '../../src/repositories/transcript.repository.js';
import type { NormalizedChunk, NormalizedSermon } from '../../src/schemas/transcript.schema.js';
import type { ChunkRecord } from '../../src/types/index.js';
import { EmbeddingProviderError, JevError, LlmError } from '../../src/utils/errors.js';
import { makeSlug } from '../../src/repositories/sermon.repository.js';

// --- data builders ------------------------------------------------------------------------------

export function makeChunk(
  id: string,
  over: Partial<ChunkRecord> = {},
  sermonOver: Partial<ChunkRecord['sermon']> = {},
): ChunkRecord {
  return {
    chunkId: id,
    sermonId: 'sermon_1',
    chunkIndex: 0,
    startTime: 184,
    endTime: 247,
    text: `text of ${id}`,
    sermon: {
      id: 'sermon_1',
      title: 'Walking By Faith',
      date: '2026-01-12',
      speaker: 'Pastor Name',
      audioUrl: 'https://audio.example/walking.mp3',
      ...sermonOver,
    },
    ...over,
  };
}

export const hit = (chunk: ChunkRecord, score = 0.5): ScoredChunk => ({ chunk, score });

/** A source row in the "existing transcript data" shape from the brief. */
export function rawRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sermonId: 'sermon_123',
    chunkId: 'chunk_001',
    title: 'Walking By Faith',
    date: '2026-01-12',
    speaker: 'Pastor Name',
    audioUrl: 'https://example.com/a.mp3',
    startTime: 184,
    endTime: 247,
    text: 'Faith does not mean...',
    ...over,
  };
}

// --- providers ----------------------------------------------------------------------------------

export function fakeEmbeddings(over: Partial<EmbeddingProvider> = {}): EmbeddingProvider & {
  embedText: ReturnType<typeof vi.fn>;
  embedTexts: ReturnType<typeof vi.fn>;
} {
  return {
    name: 'fake',
    model: 'fake-model',
    dimensions: 3,
    isConfigured: () => true,
    embedText: vi.fn(async () => [0.1, 0.2, 0.3]),
    embedTexts: vi.fn(async (texts: string[]) => texts.map(() => [0.1, 0.2, 0.3])),
    ...over,
  } as never;
}

export function unavailableEmbeddings(): EmbeddingProvider {
  const fail = () => Promise.reject(new EmbeddingProviderError('no provider'));
  return {
    name: 'placeholder',
    model: null,
    dimensions: null,
    isConfigured: () => false,
    embedText: fail,
    embedTexts: fail,
  };
}

export function fakeJev(over: Partial<JevProvider> = {}): JevProvider {
  return {
    name: 'fake-jev',
    isConfigured: () => true,
    classifyIntent: vi.fn(async () => ({
      intent: 'TOPIC_SEARCH' as const,
      confidence: 0.9,
      latencyMs: 1,
    })),
    evaluateRelevance: vi.fn(async ({ candidates }: RelevanceInput) => ({
      scores: candidates.map((c) => ({ id: c.id, relevance: 0.5 })),
      failed: 0,
      latencyMs: 1,
    })),
    ...over,
  };
}

export function failingJev(): JevProvider {
  return fakeJev({
    classifyIntent: vi.fn(() => Promise.reject(new JevError('jev down', true))),
    evaluateRelevance: vi.fn(() => Promise.reject(new JevError('jev down', true))),
  });
}

export function fakeLlm(
  reply: string | Error,
): LlmProvider & { generate: ReturnType<typeof vi.fn> } {
  return {
    name: 'fake-llm',
    isConfigured: () => true,
    generate: vi.fn(async () => {
      if (reply instanceof Error) throw reply;
      return reply;
    }),
  } as never;
}

export { LlmError };

// --- repositories -------------------------------------------------------------------------------

export function fakeSearchRepo(
  over: { vector?: ScoredChunk[] | Error; keyword?: ScoredChunk[] | Error } = {},
) {
  const run = (v: ScoredChunk[] | Error | undefined) => async () => {
    if (v instanceof Error) throw v;
    return v ?? [];
  };
  return {
    vectorSearch: vi.fn<(p: VectorSearchParams) => Promise<ScoredChunk[]>>(run(over.vector)),
    keywordSearch: vi.fn<(p: KeywordSearchParams) => Promise<ScoredChunk[]>>(run(over.keyword)),
  } satisfies SearchRepository;
}

/** In-memory repositories that mimic the SQL upsert semantics (idempotent, change-detecting). */
export function memoryRepos() {
  const sermons = new Map<string, SermonRecord>();
  interface StoredChunk extends NormalizedChunk {
    id: string;
    sermonId: string;
    embedding: number[] | null;
    embeddingModel: string | null;
  }
  const chunks = new Map<string, StoredChunk>(); // key: sermonId|externalId
  let seq = 0;

  const sermonRepo: SermonRepository = {
    async upsert(input: NormalizedSermon) {
      const existing = [...sermons.values()].find((s) => s.externalId === input.externalId);
      if (existing) {
        Object.assign(
          existing,
          Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined)),
        );
        return { sermon: existing, created: false };
      }
      const record: SermonRecord = {
        id: `s${++seq}`,
        externalId: input.externalId,
        title: input.title,
        slug: makeSlug(input.title, input.externalId),
        speaker: input.speaker ?? null,
        date: input.date ?? null,
        description: input.description ?? null,
        audioUrl: input.audioUrl ?? null,
        duration: input.duration ?? null,
        metadata: input.metadata ?? null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      sermons.set(record.id, record);
      return { sermon: record, created: true };
    },
    async find(idOrSlug: string) {
      return (
        [...sermons.values()].find(
          (s) => s.id === idOrSlug || s.slug === idOrSlug || s.externalId === idOrSlug,
        ) ?? null
      );
    },
  };

  const transcriptRepo: TranscriptRepository = {
    async upsertChunks(sermonId, list): Promise<UpsertChunksResult> {
      const r = { created: 0, updated: 0, unchanged: 0 };
      for (const c of list) {
        const key = `${sermonId}|${c.externalId}`;
        const prev = chunks.get(key);
        if (!prev) {
          chunks.set(key, {
            ...c,
            id: `c${++seq}`,
            sermonId,
            embedding: null,
            embeddingModel: null,
          });
          r.created++;
        } else if (
          prev.text !== c.text ||
          prev.startTime !== c.startTime ||
          prev.endTime !== c.endTime ||
          prev.chunkIndex !== c.chunkIndex
        ) {
          const textChanged = prev.text !== c.text;
          chunks.set(key, {
            ...prev,
            ...c,
            embedding: textChanged ? null : prev.embedding,
            embeddingModel: textChanged ? null : prev.embeddingModel,
          });
          r.updated++;
        } else r.unchanged++;
      }
      return r;
    },
    async findChunksNeedingEmbedding(sermonId, model): Promise<ChunkText[]> {
      return [...chunks.values()]
        .filter(
          (c) => c.sermonId === sermonId && (c.embedding === null || c.embeddingModel !== model),
        )
        .map((c) => ({ id: c.id, text: c.text }));
    },
    async setEmbeddings(rows, model) {
      for (const row of rows) {
        const c = [...chunks.values()].find((x) => x.id === row.id);
        if (c) Object.assign(c, { embedding: row.vector, embeddingModel: model });
      }
      return rows.length;
    },
    async listBySermon(sermonId, opts): Promise<{ chunks: ChunkListItem[]; total: number }> {
      const all = [...chunks.values()]
        .filter((c) => c.sermonId === sermonId)
        .sort((a, b) => a.startTime - b.startTime);
      return { chunks: all.slice(opts.offset, opts.offset + opts.limit), total: all.length };
    },
    async getChunk() {
      return null;
    },
    async getChunkEmbedding() {
      return null;
    },
    async getSermonCentroid() {
      return null;
    },
    async nextEmbeddingBatch(q) {
      return [...chunks.values()]
        .filter(
          (c) =>
            (!q.afterId || c.id > q.afterId) &&
            (q.force || c.embedding === null || c.embeddingModel !== q.model),
        )
        .sort((a, b) => a.id.localeCompare(b.id))
        .slice(0, q.limit)
        .map((c) => ({ id: c.id, text: c.text }));
    },
    async rebuildSearchVectorBatch() {
      return { count: 0, lastId: null };
    },
  };

  return { sermons, chunks, sermonRepo, transcriptRepo };
}
