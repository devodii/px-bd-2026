import type { ErrorRequestHandler, RequestHandler } from 'express';
import { ZodError } from 'zod';
import { AppError, ProviderError } from '../utils/errors.js';

export interface ErrorBody {
  error: { code: string; message: string; requestId?: string; details?: unknown };
}

export const notFoundHandler: RequestHandler = (req, res) => {
  const body: ErrorBody = {
    error: {
      code: 'NOT_FOUND',
      message: `No route for ${req.method} ${req.path}`,
      requestId: String(req.id),
    },
  };
  res.status(404).json(body);
};

/**
 * One place that turns any failure into the same JSON shape. Internal details (stack traces, SQL,
 * provider payloads, keys) are logged, never returned.
 */
export const errorHandler: ErrorRequestHandler = (err: unknown, req, res, _next) => {
  const requestId = String(req.id);
  const send = (status: number, code: string, message: string, details?: unknown) => {
    const body: ErrorBody = {
      error: { code, message, requestId, ...(details !== undefined && { details }) },
    };
    res.status(status).json(body);
  };

  if (err instanceof ZodError) {
    return send(
      400,
      'VALIDATION_ERROR',
      'Invalid request',
      err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    );
  }
  if (err instanceof ProviderError) {
    req.log?.warn(
      { provider: err.provider, err: err.message, retryable: err.retryable },
      'provider error',
    );
    return send(err.status, err.code, err.message, {
      provider: err.provider,
      retryable: err.retryable,
    });
  }
  if (err instanceof AppError) {
    if (err.status >= 500) req.log?.error({ err }, 'request failed');
    return send(err.status, err.code, err.message, err.details);
  }

  // body-parser errors carry a status/type of their own
  const parserError = err as { type?: string; status?: number };
  if (parserError.type === 'entity.parse.failed')
    return send(400, 'VALIDATION_ERROR', 'Request body is not valid JSON');
  if (parserError.type === 'entity.too.large')
    return send(413, 'VALIDATION_ERROR', 'Request body is too large');

  req.log?.error({ err }, 'unhandled error');
  return send(500, 'INTERNAL_ERROR', 'Something went wrong');
};
