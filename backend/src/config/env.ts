import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';

loadDotenv({ quiet: true });

const optionalString = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() !== '' ? v.trim() : undefined));

const optionalInt = (min: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v && v.trim() !== '' ? Number(v) : undefined))
    .pipe(z.number().int().min(min).optional());

const int = (fallback: number, min = 1) =>
  z
    .string()
    .optional()
    .transform((v) => (v && v.trim() !== '' ? Number(v) : fallback))
    .pipe(z.number().int().min(min));

const float01 = (fallback: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v && v.trim() !== '' ? Number(v) : fallback))
    .pipe(z.number().min(0).max(1));

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: int(4000),
  LOG_LEVEL: z.string().default('info'),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  INGESTION_API_KEY: optionalString,
  CORS_ORIGINS: optionalString,

  EMBEDDING_PROVIDER: z.string().default('placeholder'),
  EMBEDDING_API_KEY: optionalString,
  EMBEDDING_MODEL: optionalString,
  EMBEDDING_DIMENSIONS: optionalInt(1),
  EMBEDDING_BATCH_SIZE: int(64),

  JEV_API_KEY: optionalString,
  JEV_BASE_URL: optionalString,
  JEV_MODEL: optionalString,
  JEV_TIMEOUT_MS: int(8000, 100),
  JEV_CONCURRENCY: int(8),

  LLM_API_KEY: optionalString,
  LLM_MODEL: optionalString,

  SEARCH_VECTOR_LIMIT: int(30),
  SEARCH_KEYWORD_LIMIT: int(20),
  SEARCH_MERGE_LIMIT: int(50),
  SEARCH_FINAL_LIMIT: int(10),
  SEARCH_MIN_RELEVANCE: float01(0.15),

  RATE_LIMIT_PER_MINUTE: int(60),
  INGESTION_RATE_LIMIT_PER_MINUTE: int(20),
  MAX_QUERY_LENGTH: int(500),
});

export type Env = z.infer<typeof schema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid environment configuration: ${issues}`);
  }
  return parsed.data;
}

export const env: Env = loadEnv();
