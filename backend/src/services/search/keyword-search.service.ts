import type {
  ScoredChunk,
  SearchFilters,
  SearchRepository,
} from '../../repositories/search.repository.js';
import { looksLikeBibleReference } from './query-patterns.js';

const MAX_TERMS = 12;

/**
 * Builds the text handed to `to_tsquery('english', ...)`.
 *  - Bible references become a phrase (`romans <-> 8 <-> 28`) so word order matters.
 *  - Everything else is an OR of the terms, ranked by ts_rank_cd (a natural-language query
 *    should not require every word to appear in one chunk).
 * Terms are limited to letters/digits, so user input can never inject tsquery operators.
 */
export function buildTsQuery(query: string): string | null {
  const terms = [
    ...new Set(
      (query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter(
        (t) => t.length > 1 || /\d/.test(t),
      ),
    ),
  ];
  if (terms.length === 0) return null;
  if (looksLikeBibleReference(query)) return terms.join(' <-> ');
  return terms.slice(0, MAX_TERMS).join(' | ');
}

/** PostgreSQL full-text search plus exact-phrase matching. */
export class KeywordSearchService {
  constructor(private readonly repo: SearchRepository) {}

  search(query: string, filters: SearchFilters, limit: number): Promise<ScoredChunk[]> {
    return this.repo.keywordSearch({ tsQuery: buildTsQuery(query), phrase: query, limit, filters });
  }
}
