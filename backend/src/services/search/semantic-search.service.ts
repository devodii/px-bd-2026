import type { EmbeddingProvider } from '../../providers/embeddings/embedding.provider.js';
import type {
  ScoredChunk,
  SearchFilters,
  SearchRepository,
} from '../../repositories/search.repository.js';
import { EmbeddingProviderError } from '../../utils/errors.js';

/** Query embedding + pgvector similarity. Throws EmbeddingProviderError if embedding is unavailable. */
export class SemanticSearchService {
  constructor(
    private readonly embeddings: EmbeddingProvider,
    private readonly repo: SearchRepository,
    private readonly configuredDimensions: number | null,
  ) {}

  isAvailable(): boolean {
    return this.embeddings.isConfigured() && this.embeddings.model !== null;
  }

  async search(query: string, filters: SearchFilters, limit: number): Promise<ScoredChunk[]> {
    const model = this.embeddings.model;
    if (!this.isAvailable() || model === null) {
      throw new EmbeddingProviderError(
        'Semantic search is unavailable: no embedding provider is configured',
      );
    }
    const vector = await this.embeddings.embedText(query);
    const dimensions = this.configuredDimensions ?? this.embeddings.dimensions;
    if (dimensions && vector.length !== dimensions) {
      throw new EmbeddingProviderError(
        `Embedding provider returned ${vector.length} dimensions, expected ${dimensions}`,
      );
    }
    return this.repo.vectorSearch({
      vector,
      model,
      dimensions: dimensions ?? null,
      limit,
      filters,
    });
  }
}
