process.env.NODE_ENV = 'test';
process.env.DATABASE_URL ??= 'postgresql://test:test@localhost:5432/test?schema=search';
process.env.INGESTION_API_KEY = 'test-ingestion-key';
process.env.LOG_LEVEL = 'silent';
