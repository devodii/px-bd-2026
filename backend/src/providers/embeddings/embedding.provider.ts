import { batches } from '../../utils/scoring.js';

/**
 * Everything the app knows about turning text into vectors. Controllers and services depend on
 * this interface only; the concrete provider is chosen in embedding.client.ts.
 */
export interface EmbeddingProvider {
  /** Human-readable provider name, for logs. */
  readonly name: string;
  /** Model identifier stored next to each vector so models can be migrated without data loss. `null` when unconfigured. */
  readonly model: string | null;
  /** Vector length if the provider knows it up front (also configurable via EMBEDDING_DIMENSIONS). */
  readonly dimensions: number | null;
  /** False for the placeholder / a provider missing credentials. Callers should degrade gracefully. */
  isConfigured(): boolean;
  /** Throws EmbeddingProviderError on failure. */
  embedText(text: string): Promise<number[]>;
  /** One vector per input, same order. Throws EmbeddingProviderError on failure. */
  embedTexts(texts: string[]): Promise<number[][]>;
}

/** Embeds many texts in provider-sized batches, preserving order. */
export async function embedInBatches(
  provider: EmbeddingProvider,
  texts: string[],
  batchSize: number,
): Promise<number[][]> {
  const out: number[][] = [];
  for (const batch of batches(texts, batchSize)) {
    const vectors = await provider.embedTexts(batch);
    if (vectors.length !== batch.length) {
      throw new Error(
        `Embedding provider returned ${vectors.length} vectors for ${batch.length} inputs`,
      );
    }
    out.push(...vectors);
  }
  return out;
}

/** Serialises a vector as a pgvector literal, e.g. `[0.1,0.2]`. */
export function toVectorLiteral(vector: number[]): string {
  return `[${vector.join(',')}]`;
}
