import type { EmbeddingProvider } from '../../providers/embeddings/embedding.provider.js';
import { embedInBatches } from '../../providers/embeddings/embedding.provider.js';
import type { TranscriptRepository } from '../../repositories/transcript.repository.js';
import type { ReindexOptions } from '../../schemas/ingestion.schema.js';
import { AppError, EmbeddingProviderError } from '../../utils/errors.js';
import type { Logger } from '../../utils/logger.js';

export interface ReindexStats {
  embeddingsGenerated: number;
  searchVectorsRebuilt: number;
  model: string | null;
  durationMs: number;
}

export interface ReindexStatus {
  state: 'idle' | 'running' | 'completed' | 'failed';
  options?: ReindexOptions;
  progress: { embeddings: number; searchVectors: number };
  startedAt?: string;
  finishedAt?: string;
  result?: ReindexStats;
  error?: string;
}

const MAX_ATTEMPTS = 3;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Re-embeds / rebuilds search data in keyset-paginated batches, so any number of chunks can be
 * processed without deleting anything. Switching embedding models = point EMBEDDING_MODEL at the
 * new one and run a reindex; chunks whose vector came from another model are picked up
 * automatically (or pass `force` to redo everything).
 */
export class ReindexService {
  private status: ReindexStatus = { state: 'idle', progress: { embeddings: 0, searchVectors: 0 } };

  constructor(
    private readonly transcripts: TranscriptRepository,
    private readonly embeddings: EmbeddingProvider,
    private readonly defaultBatchSize: number,
    private readonly log?: Logger,
    /** Backoff base for retryable provider errors; tests set it to 0. */
    private readonly retryDelayMs = 1000,
  ) {}

  getStatus(): ReindexStatus {
    return this.status;
  }

  /** Starts a run in the background (HTTP path). Only one run at a time. */
  start(options: ReindexOptions): ReindexStatus {
    if (this.status.state === 'running')
      throw new AppError('VALIDATION_ERROR', 'A reindex is already running', 409);
    this.assertCanRun(options);
    this.status = {
      state: 'running',
      options,
      progress: { embeddings: 0, searchVectors: 0 },
      startedAt: new Date().toISOString(),
    };
    void this.execute(options).then(
      (result) => {
        this.status = {
          ...this.status,
          state: 'completed',
          result,
          finishedAt: new Date().toISOString(),
        };
      },
      (err: unknown) => {
        this.log?.error(
          { err: err instanceof Error ? err.message : String(err) },
          'reindex failed',
        );
        this.status = {
          ...this.status,
          state: 'failed',
          error: err instanceof Error ? err.message : String(err),
          finishedAt: new Date().toISOString(),
        };
      },
    );
    return this.status;
  }

  /** Runs to completion (CLI path). */
  async run(options: ReindexOptions): Promise<ReindexStats> {
    this.assertCanRun(options);
    return this.execute(options);
  }

  private assertCanRun(options: ReindexOptions): void {
    if (options.embeddings && !(this.embeddings.isConfigured() && this.embeddings.model)) {
      throw new EmbeddingProviderError(
        'Cannot regenerate embeddings: no embedding provider is configured',
      );
    }
  }

  private async execute(options: ReindexOptions): Promise<ReindexStats> {
    const started = Date.now();
    const batchSize = options.batchSize ?? this.defaultBatchSize;
    const model = this.embeddings.model;
    let embeddingsGenerated = 0;
    let searchVectorsRebuilt = 0;

    if (options.embeddings && model) {
      let afterId: string | null = null;
      for (;;) {
        const batch = await this.transcripts.nextEmbeddingBatch({
          afterId,
          limit: batchSize,
          model,
          force: options.force,
          ...(options.sermonId ? { sermonId: options.sermonId } : {}),
        });
        if (batch.length === 0) break;
        const vectors = await this.withRetry(() =>
          embedInBatches(
            this.embeddings,
            batch.map((c) => c.text),
            batchSize,
          ),
        );
        await this.transcripts.setEmbeddings(
          batch.map((c, i) => ({ id: c.id, vector: vectors[i] as number[] })),
          model,
        );
        embeddingsGenerated += batch.length;
        this.status.progress.embeddings = embeddingsGenerated;
        afterId = batch[batch.length - 1]?.id ?? null;
        this.log?.info({ embeddingsGenerated }, 'reindex: embeddings progress');
      }
    }

    if (options.searchVectors) {
      let afterId: string | null = null;
      for (;;) {
        const { count, lastId } = await this.transcripts.rebuildSearchVectorBatch(
          afterId,
          batchSize,
          options.sermonId,
        );
        if (count === 0) break;
        searchVectorsRebuilt += count;
        this.status.progress.searchVectors = searchVectorsRebuilt;
        afterId = lastId;
        this.log?.info({ searchVectorsRebuilt }, 'reindex: search vector progress');
      }
    }

    return { embeddingsGenerated, searchVectorsRebuilt, model, durationMs: Date.now() - started };
  }

  /** Retries provider failures marked retryable (rate limits, timeouts) with exponential backoff. */
  private async withRetry<T>(fn: () => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await fn();
      } catch (err) {
        const retryable = err instanceof EmbeddingProviderError && err.retryable;
        if (!retryable || attempt >= MAX_ATTEMPTS) throw err;
        this.log?.warn({ attempt }, 'embedding batch failed; retrying');
        await sleep(this.retryDelayMs * 2 ** (attempt - 1));
      }
    }
  }
}
