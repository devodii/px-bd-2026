import type { Env } from '../../config/env.js';
import { EmbeddingProviderError } from '../../utils/errors.js';
import type { EmbeddingProvider } from './embedding.provider.js';

/**
 * PLACEHOLDER. Another teammate owns the real embedding integration.
 *
 * Behaviour while this is active (all intentional, so the rest of the system is exercised):
 *  - ingestion stores chunks + full-text data and leaves `embedding` NULL (reported in the stats)
 *  - hybrid search degrades to keyword-only and says so in `meta.warnings`
 *  - semantic-only search returns a structured EMBEDDING_UNAVAILABLE error
 *  - `npm run reindex` fills the vectors in later, once a real provider exists
 */
export class PlaceholderEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'placeholder';
  readonly model = null;
  readonly dimensions = null;

  isConfigured(): boolean {
    return false;
  }

  embedText(): Promise<number[]> {
    return Promise.reject(this.notImplemented());
  }

  embedTexts(): Promise<number[][]> {
    return Promise.reject(this.notImplemented());
  }

  private notImplemented(): EmbeddingProviderError {
    return new EmbeddingProviderError(
      'No embedding provider is configured yet (placeholder in use). ' +
        'Implement EmbeddingProvider in src/providers/embeddings/ and register it in createEmbeddingProvider().',
    );
  }
}

/**
 * The single place that picks an embedding implementation from EMBEDDING_PROVIDER.
 *
 * TODO(embeddings owner): add your provider here, e.g.
 *   case 'openai': return new OpenAiEmbeddingProvider({ apiKey: env.EMBEDDING_API_KEY, model: env.EMBEDDING_MODEL, ... });
 * A real provider must: batch requests, apply a timeout, back off on 429s, throw EmbeddingProviderError
 * (retryable = true for 429/5xx/timeouts), and expose `model` so vectors are tagged with it.
 */
export function createEmbeddingProvider(
  env: Pick<
    Env,
    'EMBEDDING_PROVIDER' | 'EMBEDDING_API_KEY' | 'EMBEDDING_MODEL' | 'EMBEDDING_DIMENSIONS'
  >,
): EmbeddingProvider {
  switch (env.EMBEDDING_PROVIDER) {
    case 'placeholder':
      return new PlaceholderEmbeddingProvider();
    default:
      throw new Error(
        `Unknown EMBEDDING_PROVIDER "${env.EMBEDDING_PROVIDER}". Register it in createEmbeddingProvider().`,
      );
  }
}
