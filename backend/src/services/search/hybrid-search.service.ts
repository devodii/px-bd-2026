import type { ScoredChunk, SearchFilters } from '../../repositories/search.repository.js';
import type { SearchIntent, SearchType } from '../../types/index.js';
import { AppError, EmbeddingProviderError } from '../../utils/errors.js';
import type { Logger } from '../../utils/logger.js';
import { rrf } from '../../utils/scoring.js';
import type { KeywordSearchService } from './keyword-search.service.js';
import type { SemanticSearchService } from './semantic-search.service.js';
import type { Candidate, SearchConfig, SearchWarning } from './search.types.js';

export interface RetrievalResult {
  semantic: ScoredChunk[];
  keyword: ScoredChunk[];
  /** What actually ran, after any fallback. */
  effectiveType: SearchType;
  warnings: SearchWarning[];
}

/** How much each retrieval list counts for a given intent. */
const WEIGHTS: Record<SearchIntent, { semantic: number; keyword: number }> = {
  BIBLE_REFERENCE: { semantic: 0.5, keyword: 1.5 },
  SERMON_LOOKUP: { semantic: 0.8, keyword: 1.2 },
  PERSON_LOOKUP: { semantic: 0.8, keyword: 1.2 },
  TOPIC_SEARCH: { semantic: 1.2, keyword: 0.8 },
  TEACHING_QUESTION: { semantic: 1.2, keyword: 0.8 },
  GENERAL_SEARCH: { semantic: 1, keyword: 1 },
};

const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * Retrieval stage: runs semantic and keyword search, degrades gracefully, and merges the lists.
 *
 * Fallback rules
 *  - hybrid: if either side fails, the other side's results are returned with a warning;
 *    only if both fail does the search fail.
 *  - semantic: an unavailable embedding provider is a structured 503 (the caller asked for
 *    vectors specifically); a failing vector query falls back to keyword search.
 *  - keyword: no dependency on embeddings at all.
 */
export class HybridSearchService {
  constructor(
    private readonly semantic: SemanticSearchService,
    private readonly keyword: KeywordSearchService,
    private readonly config: Pick<SearchConfig, 'vectorLimit' | 'keywordLimit' | 'mergeLimit'>,
  ) {}

  async retrieve(
    query: string,
    filters: SearchFilters,
    requested: SearchType,
    log?: Logger,
  ): Promise<RetrievalResult> {
    const warnings: SearchWarning[] = [];
    const { vectorLimit, keywordLimit } = this.config;

    if (requested === 'keyword') {
      const keyword = await this.keyword.search(query, filters, keywordLimit);
      return { semantic: [], keyword, effectiveType: 'keyword', warnings };
    }

    const [sem, kw] = await Promise.allSettled([
      this.semantic.search(query, filters, vectorLimit),
      // Semantic-only requests still get keyword results as a safety net, used only if vectors fail.
      this.keyword.search(query, filters, keywordLimit),
    ]);

    if (requested === 'semantic') {
      if (sem.status === 'fulfilled')
        return { semantic: sem.value, keyword: [], effectiveType: 'semantic', warnings };
      if (sem.reason instanceof EmbeddingProviderError) throw sem.reason;
      warnings.push({
        code: 'VECTOR_SEARCH_FAILED',
        message: 'Vector search failed; showing keyword results instead',
      });
      log?.error(
        { err: errorMessage(sem.reason) },
        'vector search failed; falling back to keyword',
      );
      if (kw.status === 'fulfilled')
        return { semantic: [], keyword: kw.value, effectiveType: 'keyword', warnings };
      throw new AppError('SEARCH_FAILED', 'Search failed', 500, undefined, { cause: kw.reason });
    }

    // hybrid
    if (sem.status === 'fulfilled' && kw.status === 'fulfilled') {
      return { semantic: sem.value, keyword: kw.value, effectiveType: 'hybrid', warnings };
    }
    if (sem.status === 'rejected') {
      const unavailable = sem.reason instanceof EmbeddingProviderError;
      warnings.push({
        code: unavailable ? 'EMBEDDING_UNAVAILABLE' : 'VECTOR_SEARCH_FAILED',
        message: unavailable
          ? 'Semantic search is unavailable; results are keyword-only'
          : 'Vector search failed; results are keyword-only',
      });
      log?.warn(
        { err: errorMessage(sem.reason), unavailable },
        'semantic retrieval unavailable; keyword-only',
      );
    }
    if (kw.status === 'rejected') {
      warnings.push({
        code: 'KEYWORD_SEARCH_FAILED',
        message: 'Keyword search failed; results are semantic-only',
      });
      log?.error({ err: errorMessage(kw.reason) }, 'keyword retrieval failed');
    }
    if (sem.status === 'fulfilled')
      return { semantic: sem.value, keyword: [], effectiveType: 'semantic', warnings };
    if (kw.status === 'fulfilled')
      return { semantic: [], keyword: kw.value, effectiveType: 'keyword', warnings };
    throw new AppError('SEARCH_FAILED', 'Search failed', 500, undefined, { cause: kw.reason });
  }

  /**
   * Weighted Reciprocal Rank Fusion. Removes duplicates (same chunk, or identical text) and
   * caps the result at `mergeLimit`, which is what gets sent to JEV.
   */
  merge(
    retrieval: Pick<RetrievalResult, 'semantic' | 'keyword'>,
    intent: SearchIntent,
  ): Candidate[] {
    const w = WEIGHTS[intent];
    const active =
      (retrieval.semantic.length ? w.semantic : 0) + (retrieval.keyword.length ? w.keyword : 0);
    if (active === 0) return [];
    const best = active * rrf(1); // a chunk ranked #1 in every active list scores 1.0

    const byChunk = new Map<string, Candidate>();
    const add = (hits: ScoredChunk[], weight: number, kind: 'semanticScore' | 'keywordScore') => {
      hits.forEach((hit, i) => {
        const existing = byChunk.get(hit.chunk.chunkId) ?? { chunk: hit.chunk, fusionScore: 0 };
        existing[kind] = hit.score;
        existing.fusionScore += (weight * rrf(i + 1)) / best;
        byChunk.set(hit.chunk.chunkId, existing);
      });
    };
    add(retrieval.semantic, w.semantic, 'semanticScore');
    add(retrieval.keyword, w.keyword, 'keywordScore');

    const seenText = new Set<string>();
    const merged: Candidate[] = [];
    for (const c of [...byChunk.values()].sort((a, b) => b.fusionScore - a.fusionScore)) {
      const key = c.chunk.text.trim().toLowerCase();
      if (seenText.has(key)) continue;
      seenText.add(key);
      merged.push(c);
      if (merged.length >= this.config.mergeLimit) break;
    }
    return merged;
  }
}
