import pino from 'pino';
import { env } from '../config/env.js';

export const logger = pino({
  level: env.LOG_LEVEL,
  // Never let credentials reach the logs, whatever gets logged.
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers["x-api-key"]',
      '*.apiKey',
      '*.api_key',
      'apiKey',
      'EMBEDDING_API_KEY',
      'JEV_API_KEY',
      'LLM_API_KEY',
    ],
    censor: '[redacted]',
  },
  ...(env.NODE_ENV === 'development'
    ? { transport: { target: 'pino-pretty', options: { colorize: true } } }
    : {}),
});

export type Logger = pino.Logger;
