import type { IntentInput, IntentResult, RelevanceInput, RelevanceResult } from './jev.types.js';

/**
 * The only JEV surface the rest of the app may use. JEV is a judge, not an embedding model: it
 * scores/classifies text it is given. It must never be required for search to work; callers
 * treat any thrown JevError as "skip the JEV step".
 *
 * To replace JEV: implement this interface and register it in createJevProvider() (jev.client.ts).
 */
export interface JevProvider {
  readonly name: string;
  isConfigured(): boolean;
  /** Classify what kind of search the query is. Throws JevError. */
  classifyIntent(input: IntentInput): Promise<IntentResult>;
  /** Judge how relevant each candidate is to the query. Throws JevError if nothing could be judged. */
  evaluateRelevance(input: RelevanceInput): Promise<RelevanceResult>;
}
