export interface LlmMessage {
  role: 'system' | 'user';
  content: string;
}

export interface LlmRequest {
  messages: LlmMessage[];
  /** Ask the model for a JSON object (providers that support it should enforce it). */
  json?: boolean;
  maxTokens?: number;
  temperature?: number;
}

/** Minimal text-generation surface the AnswerService needs. */
export interface LlmProvider {
  readonly name: string;
  isConfigured(): boolean;
  /** Returns the raw model text. Throws LlmError on failure. */
  generate(request: LlmRequest): Promise<string>;
}
