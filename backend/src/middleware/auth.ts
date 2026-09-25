import { timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { AppError, UnauthorizedError } from '../utils/errors.js';

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

/**
 * Protects write/maintenance endpoints with a shared key sent as `x-api-key`
 * (or `Authorization: Bearer <key>`). With no key configured the endpoints are disabled
 * rather than left open.
 */
export function requireApiKey(expected: string | undefined) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!expected) {
      return next(
        new AppError(
          'UNAUTHORIZED',
          'Ingestion is disabled: INGESTION_API_KEY is not configured',
          503,
        ),
      );
    }
    const bearer = req.header('authorization')?.replace(/^Bearer\s+/i, '');
    const provided = req.header('x-api-key') ?? bearer;
    if (!provided || !safeEqual(provided, expected)) return next(new UnauthorizedError());
    next();
  };
}
