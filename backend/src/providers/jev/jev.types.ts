import type { SearchIntent } from '../../types/index.js';

export interface RelevanceCandidate {
  /** Chunk id; echoed back so results can be joined to candidates. */
  id: string;
  /** Untrusted transcript text. */
  text: string;
  sermonTitle?: string;
}

export interface RelevanceInput {
  query: string;
  intent?: SearchIntent;
  candidates: RelevanceCandidate[];
}

export interface RelevanceScore {
  id: string;
  /** Probability-like relevance in 0..1 (JEV Noul: "does this passage answer/address the query?"). */
  relevance: number;
}

export interface RelevanceResult {
  /** May be a subset of the candidates if some individual judgments failed. */
  scores: RelevanceScore[];
  /** How many candidates could not be judged. */
  failed: number;
  latencyMs: number;
}

export interface IntentInput {
  query: string;
}

export interface IntentResult {
  intent: SearchIntent;
  /** 0..1 concentration of JEV's probability on the chosen intent. */
  confidence: number;
  latencyMs: number;
}

export interface JevClientOptions {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  /** Timeout per attempt, ms. */
  timeoutMs: number;
  /** Max simultaneous requests when judging many candidates. */
  concurrency: number;
}
