import express, { type Express } from 'express';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import { AnswerController } from './controllers/answer.controller.js';
import { HealthController } from './controllers/health.controller.js';
import { IngestionController } from './controllers/ingestion.controller.js';
import { SearchController } from './controllers/search.controller.js';
import { SermonController } from './controllers/sermon.controller.js';
import type { Container } from './container.js';
import { requireApiKey } from './middleware/auth.js';
import { errorHandler, notFoundHandler } from './middleware/error-handler.js';
import { createRateLimiter } from './middleware/rate-limit.js';
import { requestId } from './middleware/request-id.js';
import { answerRoutes } from './routes/answer.routes.js';
import { healthRoutes } from './routes/health.routes.js';
import { ingestionRoutes } from './routes/ingestion.routes.js';
import { searchRoutes } from './routes/search.routes.js';
import { sermonRoutes } from './routes/sermon.routes.js';
import type { Logger } from './utils/logger.js';

export interface AppOptions {
  container: Pick<Container, 'providers' | 'services' | 'checkDatabase'>;
  logger: Logger;
  ingestionApiKey: string | undefined;
  rateLimitPerMinute: number;
  ingestionRateLimitPerMinute: number;
  corsOrigins?: string | undefined;
}

export function createApp(opts: AppOptions): Express {
  const { container: c } = opts;
  const app = express();
  app.disable('x-powered-by');

  app.use(requestId);
  app.use(
    pinoHttp({
      logger: opts.logger,
      genReqId: (req) => String(req.id),
      // The default serializer would log the raw query string; keep logs to path + method + status.
      serializers: {
        req: (req: { id: unknown; method: string; url: string }) => ({
          id: req.id,
          method: req.method,
          url: req.url.split('?')[0],
        }),
      },
    }),
  );
  app.use(helmet());
  app.use(cors(opts.corsOrigins));

  app.use(
    '/api/health',
    healthRoutes(new HealthController({ checkDatabase: c.checkDatabase, providers: c.providers })),
  );

  // Ingestion: API key first, then a tight rate limit, then its own (larger) JSON body parser.
  app.use(
    '/api/ingestion',
    requireApiKey(opts.ingestionApiKey),
    createRateLimiter(opts.ingestionRateLimitPerMinute),
    ingestionRoutes(new IngestionController(c.services.ingestion, c.services.reindex)),
  );

  // Public read endpoints: small bodies, general rate limit.
  app.use(express.json({ limit: '50kb' }));
  app.use(
    '/api/search',
    createRateLimiter(opts.rateLimitPerMinute),
    searchRoutes(new SearchController(c.services.search)),
  );
  app.use(
    '/api/sermons',
    createRateLimiter(opts.rateLimitPerMinute),
    sermonRoutes(new SermonController(c.services.sermons, c.services.related)),
  );
  // The answer endpoint costs an LLM call per request, so it gets a stricter limit.
  app.use(
    '/api/answer',
    createRateLimiter(Math.max(5, Math.floor(opts.rateLimitPerMinute / 4))),
    answerRoutes(new AnswerController(c.services.ask)),
  );

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

/** Minimal CORS: only the origins listed in CORS_ORIGINS (none = same-origin only). */
function cors(origins: string | undefined): express.RequestHandler {
  const allowed = new Set(
    (origins ?? '')
      .split(',')
      .map((o) => o.trim())
      .filter(Boolean),
  );
  return (req, res, next) => {
    const origin = req.header('origin');
    if (origin && allowed.has(origin)) {
      res.setHeader('access-control-allow-origin', origin);
      res.setHeader('vary', 'Origin');
      res.setHeader(
        'access-control-allow-headers',
        'content-type, x-api-key, authorization, x-request-id',
      );
      res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
      if (req.method === 'OPTIONS') {
        res.status(204).end();
        return;
      }
    }
    next();
  };
}
