import { z } from 'zod';

export const MAX_BATCH = 500;

// Items are validated per row by the normalizer so one bad row doesn't reject the batch.
const rows = z
  .array(z.unknown())
  .min(1, 'Provide at least one item')
  .max(MAX_BATCH, `At most ${MAX_BATCH} items per request`);

export const ingestSermonsSchema = z.object({ sermons: rows });

export const ingestChunksSchema = z.object({ chunks: rows });

export const reindexSchema = z.object({
  /** Regenerate embeddings. */
  embeddings: z.boolean().default(true),
  /** Rebuild full-text search vectors. */
  searchVectors: z.boolean().default(false),
  /** true: re-embed every chunk (e.g. after switching model). false: only chunks with no vector / a different model. */
  force: z.boolean().default(false),
  sermonId: z.string().trim().min(1).max(100).optional(),
  batchSize: z.number().int().min(1).max(500).optional(),
});

export type ReindexOptions = z.infer<typeof reindexSchema>;
