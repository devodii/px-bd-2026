import type { Env } from '../../config/env.js';
import { LlmError } from '../../utils/errors.js';
import type { LlmProvider, LlmRequest } from './llm.provider.js';

/**
 * PLACEHOLDER adapter: the LLM vendor has not been chosen yet.
 * Search never touches this; only POST /api/answer does, and it answers 503 LLM_UNAVAILABLE until
 * a real provider is registered in createLlmProvider().
 *
 * TODO: implement LlmProvider for the chosen vendor (use LLM_API_KEY / LLM_MODEL), with a request
 * timeout and retry on 429/5xx, throwing LlmError.
 */
export class NotConfiguredLlmProvider implements LlmProvider {
  readonly name = 'not-configured';

  isConfigured(): boolean {
    return false;
  }

  generate(_request: LlmRequest): Promise<string> {
    return Promise.reject(
      new LlmError('No LLM provider is configured. Search still works; answers are unavailable.'),
    );
  }
}

export function createLlmProvider(_env: Pick<Env, 'LLM_API_KEY' | 'LLM_MODEL'>): LlmProvider {
  // TODO: return the real provider when LLM_API_KEY and LLM_MODEL are set.
  return new NotConfiguredLlmProvider();
}
