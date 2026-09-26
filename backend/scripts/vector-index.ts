/**
 * Creates the pgvector HNSW index once the embedding dimension is known (EMBEDDING_DIMENSIONS).
 * The column itself is dimension-less, so nothing is hard-coded in migrations; the index is an
 * expression index on `embedding::vector(N)`, which is exactly what the search queries use.
 *
 * Changing models with a different dimension: set the new EMBEDDING_DIMENSIONS, re-run reindex
 * with --force, then run this again (it drops indexes for other dimensions).
 */
import { Prisma } from '../src/generated/prisma/client.js';
import { env } from '../src/config/env.js';
import { createPrismaClient } from '../src/db/prisma.js';

async function main(): Promise<void> {
  const dims = env.EMBEDDING_DIMENSIONS;
  if (!dims) {
    console.error('Set EMBEDDING_DIMENSIONS (the vector length of your embedding model) first.');
    process.exit(1);
  }
  const prisma = createPrismaClient();
  try {
    const name = `transcript_chunks_embedding_hnsw_${dims}`;
    const old = await prisma.$queryRaw<{ indexname: string }[]>(Prisma.sql`
      SELECT indexname FROM pg_indexes
      WHERE tablename = 'transcript_chunks' AND indexname LIKE 'transcript_chunks_embedding_hnsw_%' AND indexname <> ${name}
    `);
    for (const { indexname } of old) {
      await prisma.$executeRawUnsafe(`DROP INDEX IF EXISTS "${indexname.replace(/"/g, '')}"`);
      console.log(`dropped ${indexname}`);
    }
    // `dims` is a validated integer, so interpolating it is safe.
    await prisma.$executeRawUnsafe(
      `CREATE INDEX IF NOT EXISTS "${name}" ON transcript_chunks USING hnsw ((embedding::vector(${Number(dims)})) vector_cosine_ops) WHERE embedding IS NOT NULL`,
    );
    console.log(`ready: ${name}`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
