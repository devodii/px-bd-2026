import type { EmbeddingProvider } from '../../providers/embeddings/embedding.provider.js';
import type { SermonRepository } from '../../repositories/sermon.repository.js';
import type { ChunkText, TranscriptRepository } from '../../repositories/transcript.repository.js';
import type { NormalizedChunk, NormalizedSermon } from '../../schemas/transcript.schema.js';
import type { Logger } from '../../utils/logger.js';
import { ValidationError } from '../../utils/errors.js';
import { batches } from '../../utils/scoring.js';
import { normalizeChunks, normalizeSermon, type NormalizeIssue } from './chunk-normalizer.js';

export interface EmbeddingOutcome {
  /** `skipped`: no provider configured yet. `failed`: the provider errored (data is still stored; run reindex). */
  status: 'complete' | 'skipped' | 'failed' | 'not-needed';
  generated: number;
  model: string | null;
  error?: string;
}

export interface IngestChunksStats {
  received: number;
  accepted: number;
  rejected: NormalizeIssue[];
  sermons: { created: number; updated: number };
  chunks: { created: number; updated: number; unchanged: number; duplicatesInBatch: number };
  embeddings: EmbeddingOutcome;
  durationMs: number;
}

export interface IngestSermonsStats {
  received: number;
  created: number;
  updated: number;
  rejected: NormalizeIssue[];
  durationMs: number;
}

/** First defined value wins per field, so a batch's chunks can complete each other's sermon data. */
function mergeSermon(base: NormalizedSermon, next: NormalizedSermon): NormalizedSermon {
  return {
    ...next,
    ...Object.fromEntries(Object.entries(base).filter(([, v]) => v !== undefined)),
  } as NormalizedSermon;
}

export class IngestionService {
  constructor(
    private readonly sermons: SermonRepository,
    private readonly transcripts: TranscriptRepository,
    private readonly embeddings: EmbeddingProvider,
    private readonly embeddingBatchSize: number,
    private readonly log?: Logger,
  ) {}

  async ingestSermons(rows: readonly unknown[]): Promise<IngestSermonsStats> {
    const started = Date.now();
    const rejected: NormalizeIssue[] = [];
    let created = 0;
    let updated = 0;
    const seen = new Set<string>();

    for (const [index, row] of rows.entries()) {
      const result = normalizeSermon(row);
      if (!result.ok) {
        rejected.push({ index, errors: result.errors });
        continue;
      }
      if (seen.has(result.sermon.externalId)) continue;
      seen.add(result.sermon.externalId);
      const { created: wasCreated } = await this.sermons.upsert(result.sermon);
      if (wasCreated) created++;
      else updated++;
    }
    if (created + updated === 0)
      throw new ValidationError('No valid sermons in request', { rejected });
    return { received: rows.length, created, updated, rejected, durationMs: Date.now() - started };
  }

  async ingestChunks(rows: readonly unknown[]): Promise<IngestChunksStats> {
    const started = Date.now();
    const { items, rejected } = normalizeChunks(rows);
    if (items.length === 0) throw new ValidationError('No valid chunks in request', { rejected });

    // Group by sermon: one sermon upsert, one chunk upsert and one embedding pass per sermon.
    const groups = new Map<
      string,
      { sermon: NormalizedSermon; chunks: Map<string, NormalizedChunk> }
    >();
    let duplicatesInBatch = 0;
    for (const { sermon, chunk } of items) {
      const group = groups.get(sermon.externalId) ?? { sermon, chunks: new Map() };
      group.sermon = mergeSermon(group.sermon, sermon);
      if (group.chunks.has(chunk.externalId)) duplicatesInBatch++;
      group.chunks.set(chunk.externalId, chunk); // last occurrence wins
      groups.set(sermon.externalId, group);
    }

    const stats = {
      sermons: { created: 0, updated: 0 },
      chunks: { created: 0, updated: 0, unchanged: 0, duplicatesInBatch },
    };
    const needEmbedding: ChunkText[] = [];

    for (const group of groups.values()) {
      const { sermon, created } = await this.sermons.upsert(group.sermon);
      if (created) stats.sermons.created++;
      else stats.sermons.updated++;

      const result = await this.transcripts.upsertChunks(sermon.id, [...group.chunks.values()]);
      stats.chunks.created += result.created;
      stats.chunks.updated += result.updated;
      stats.chunks.unchanged += result.unchanged;

      if (this.embeddings.isConfigured() && this.embeddings.model) {
        needEmbedding.push(
          ...(await this.transcripts.findChunksNeedingEmbedding(sermon.id, this.embeddings.model)),
        );
      }
    }

    const embeddings = await this.embedPending(needEmbedding);
    this.log?.info(
      {
        event: 'ingest.chunks',
        accepted: items.length,
        rejected: rejected.length,
        ...stats,
        embeddings: embeddings.status,
      },
      'chunk ingestion finished',
    );

    return {
      received: rows.length,
      accepted: items.length,
      rejected,
      ...stats,
      embeddings,
      durationMs: Date.now() - started,
    };
  }

  /** Embeds in provider-sized batches. Failure never rolls back the stored text; reindex can finish the job. */
  private async embedPending(pending: ChunkText[]): Promise<EmbeddingOutcome> {
    const model = this.embeddings.model;
    if (!this.embeddings.isConfigured() || !model) {
      return {
        status: 'skipped',
        generated: 0,
        model: null,
        error: 'No embedding provider configured; run reindex once one is available',
      };
    }
    if (pending.length === 0) return { status: 'not-needed', generated: 0, model };

    let generated = 0;
    try {
      for (const batch of batches(pending, this.embeddingBatchSize)) {
        const vectors = await this.embeddings.embedTexts(batch.map((c) => c.text));
        if (vectors.length !== batch.length)
          throw new Error('Embedding provider returned a different number of vectors than inputs');
        await this.transcripts.setEmbeddings(
          batch.map((c, i) => ({ id: c.id, vector: vectors[i] as number[] })),
          model,
        );
        generated += batch.length;
      }
      return { status: 'complete', generated, model };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log?.error(
        { err: message, generated },
        'embedding failed during ingestion; chunks stored without vectors',
      );
      return { status: 'failed', generated, model, error: message };
    }
  }
}
