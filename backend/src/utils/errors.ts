export type ErrorCode =
  | 'VALIDATION_ERROR'
  | 'UNAUTHORIZED'
  | 'NOT_FOUND'
  | 'RATE_LIMITED'
  | 'EMBEDDING_UNAVAILABLE'
  | 'JEV_UNAVAILABLE'
  | 'LLM_UNAVAILABLE'
  | 'SEARCH_FAILED'
  | 'INTERNAL_ERROR';

export class AppError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly status: number,
    public readonly details?: unknown,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class ValidationError extends AppError {
  constructor(message: string, details?: unknown) {
    super('VALIDATION_ERROR', message, 400, details);
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'Missing or invalid API key') {
    super('UNAUTHORIZED', message, 401);
  }
}

export class NotFoundError extends AppError {
  constructor(what: string) {
    super('NOT_FOUND', `${what} not found`, 404);
  }
}

/** Base for failures of an external provider (embedding, JEV, LLM). */
export class ProviderError extends AppError {
  constructor(
    code: ErrorCode,
    public readonly provider: string,
    message: string,
    public readonly retryable = false,
    options?: { cause?: unknown },
  ) {
    super(code, message, 503, undefined, options);
  }
}

export class EmbeddingProviderError extends ProviderError {
  constructor(message: string, retryable = false, options?: { cause?: unknown }) {
    super('EMBEDDING_UNAVAILABLE', 'embedding', message, retryable, options);
  }
}

export class JevError extends ProviderError {
  constructor(message: string, retryable = false, options?: { cause?: unknown }) {
    super('JEV_UNAVAILABLE', 'jev', message, retryable, options);
  }
}

export class LlmError extends ProviderError {
  constructor(message: string, retryable = false, options?: { cause?: unknown }) {
    super('LLM_UNAVAILABLE', 'llm', message, retryable, options);
  }
}
