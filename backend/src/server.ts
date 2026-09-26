import { createApp } from './app.js';
import { env } from './config/env.js';
import { createContainer } from './container.js';
import { logger } from './utils/logger.js';

const container = createContainer(env, logger);
const app = createApp({
  container,
  logger,
  ingestionApiKey: env.INGESTION_API_KEY,
  rateLimitPerMinute: env.RATE_LIMIT_PER_MINUTE,
  ingestionRateLimitPerMinute: env.INGESTION_RATE_LIMIT_PER_MINUTE,
  corsOrigins: env.CORS_ORIGINS,
});

const server = app.listen(env.PORT, () => {
  logger.info(
    {
      port: env.PORT,
      embeddings: container.providers.embeddings.isConfigured()
        ? container.providers.embeddings.name
        : 'placeholder (keyword-only search)',
      jev: container.providers.jev.isConfigured()
        ? 'configured'
        : 'not configured (retrieval ranking only)',
      llm: container.providers.llm.isConfigured()
        ? 'configured'
        : 'not configured (answers disabled)',
    },
    'search api listening',
  );
});

async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, 'shutting down');
  server.close(async () => {
    await container.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
