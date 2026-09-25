import pg from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client.js';
import { env } from '../config/env.js';

export { PrismaClient };

/**
 * DATABASE_URL carries `?schema=search` (the Python pipeline owns `public`). The `pg` driver
 * does not understand that Prisma-specific param, so it is split off and applied as the
 * connection's search_path, which raw pgvector queries (unqualified names/operators) rely on.
 */
export function parseDatabaseUrl(url: string): { connectionString: string; schema: string } {
  const u = new URL(url);
  const schema = u.searchParams.get('schema') ?? 'public';
  u.searchParams.delete('schema');
  return { connectionString: u.toString(), schema };
}

export function createPrismaClient(databaseUrl: string = env.DATABASE_URL): PrismaClient {
  const { connectionString, schema } = parseDatabaseUrl(databaseUrl);
  const pool = new pg.Pool({ connectionString, options: `-c search_path=${schema}` });
  return new PrismaClient({ adapter: new PrismaPg(pool, { schema }) });
}
