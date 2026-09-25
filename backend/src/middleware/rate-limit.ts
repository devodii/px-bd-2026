import { rateLimit } from 'express-rate-limit';
import type { ErrorBody } from './error-handler.js';

export function createRateLimiter(perMinute: number) {
  return rateLimit({
    windowMs: 60_000,
    limit: perMinute,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    handler: (req, res) => {
      const body: ErrorBody = {
        error: {
          code: 'RATE_LIMITED',
          message: 'Too many requests, slow down',
          requestId: String(req.id),
        },
      };
      res.status(429).json(body);
    },
  });
}
