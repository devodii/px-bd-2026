import type { JevProvider } from '../../providers/jev/jev.provider.js';
import type { Logger } from '../../utils/logger.js';
import type { SearchIntent } from '../../types/index.js';
import { looksLikeBibleReference, looksLikeQuestion } from './query-patterns.js';

export interface IntentClassification {
  intent: SearchIntent;
  source: 'heuristic' | 'jev' | 'fallback';
}

/** Replaceable: SearchService only needs `classify`, which must never throw. */
export interface IntentClassifier {
  classify(query: string, log?: Logger): Promise<IntentClassification>;
}

function heuristic(query: string): SearchIntent {
  if (looksLikeBibleReference(query)) return 'BIBLE_REFERENCE';
  return looksLikeQuestion(query) ? 'TEACHING_QUESTION' : 'GENERAL_SEARCH';
}

/**
 * Cheap rules first (a Bible reference needs no model), JEV for the rest, and a rule-based
 * answer if JEV is missing, slow or failing, so intent can never block a search.
 */
export class DefaultIntentClassifier implements IntentClassifier {
  constructor(
    private readonly jev: JevProvider,
    private readonly timeoutMs: number,
  ) {}

  async classify(query: string, log?: Logger): Promise<IntentClassification> {
    if (looksLikeBibleReference(query)) return { intent: 'BIBLE_REFERENCE', source: 'heuristic' };
    if (!this.jev.isConfigured()) return { intent: heuristic(query), source: 'fallback' };

    let timer: NodeJS.Timeout | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('intent classification timed out')),
          this.timeoutMs,
        );
      });
      const result = await Promise.race([this.jev.classifyIntent({ query }), timeout]);
      log?.debug(
        { intent: result.intent, confidence: result.confidence, latencyMs: result.latencyMs },
        'intent classified',
      );
      return { intent: result.intent, source: 'jev' };
    } catch (err) {
      log?.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'jev intent classification failed; using heuristic',
      );
      return { intent: heuristic(query), source: 'fallback' };
    } finally {
      clearTimeout(timer);
    }
  }
}
