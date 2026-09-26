import type { ChunkRecord, SearchIntent, SearchType, SermonSummary } from '../../types/index.js';
import type { SearchFilters } from '../../repositories/search.repository.js';

export interface SearchParams extends SearchFilters {
  query: string;
  limit?: number | undefined;
  searchType?: SearchType | undefined;
}

export interface SearchConfig {
  vectorLimit: number;
  keywordLimit: number;
  /** Upper bound on candidates sent to JEV. */
  mergeLimit: number;
  finalLimit: number;
  /** JEV-judged candidates below this relevance are dropped. */
  minRelevance: number;
}

/** A chunk after retrieval and merging, before/after JEV judgment. */
export interface Candidate {
  chunk: ChunkRecord;
  semanticScore?: number;
  keywordScore?: number;
  /** Weighted reciprocal-rank fusion of the retrieval lists, normalised to 0..1. */
  fusionScore: number;
  /** JEV relevance, when judged. */
  jevScore?: number;
}

export type WarningCode =
  'EMBEDDING_UNAVAILABLE' | 'VECTOR_SEARCH_FAILED' | 'KEYWORD_SEARCH_FAILED' | 'JEV_UNAVAILABLE';

export interface SearchWarning {
  code: WarningCode;
  message: string;
}

export interface SearchResultItem {
  sermon: SermonSummary;
  chunk: { id: string; startTime: number; endTime: number; text: string };
  relevance: { score: number; source: 'jev' | 'retrieval' };
  /** Everything a player needs for "jump to timestamp". */
  audio: { url: string | null; startTime: number };
}

export interface SearchResponse {
  query: string;
  results: SearchResultItem[];
  meta: {
    total: number;
    /** The retrieval mode that actually ran (may differ from the requested one after a fallback). */
    searchType: SearchType;
    intent: SearchIntent;
    jev: 'applied' | 'skipped' | 'failed';
    warnings: SearchWarning[];
  };
}
