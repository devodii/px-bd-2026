/**
 * Regenerate embeddings and/or rebuild full-text vectors, in batches, without touching other data.
 *
 *   npm run reindex                      embed chunks that have no vector from the current EMBEDDING_MODEL
 *   npm run reindex -- --force           re-embed everything (e.g. after switching models)
 *   npm run reindex -- --search-vectors  also rebuild tsvector columns
 *   npm run reindex -- --no-embeddings --search-vectors
 *   npm run reindex -- --sermon <id> --batch 100
 */
import { env } from '../src/config/env.js';
import { createContainer } from '../src/container.js';
import { reindexSchema } from '../src/schemas/ingestion.schema.js';
import { logger } from '../src/utils/logger.js';

function flagValue(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const batch = flagValue(args, '--batch');
  const options = reindexSchema.parse({
    embeddings: !args.includes('--no-embeddings'),
    searchVectors: args.includes('--search-vectors'),
    force: args.includes('--force'),
    sermonId: flagValue(args, '--sermon'),
    ...(batch ? { batchSize: Number(batch) } : {}),
  });

  const container = createContainer(env, logger);
  try {
    const result = await container.services.reindex.run(options);
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await container.close();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
