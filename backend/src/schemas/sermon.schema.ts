import { z } from 'zod';

export const sermonParamsSchema = z.object({ id: z.string().trim().min(1).max(100) });

/** GET /api/sermons/:id/chunks — `from`/`to` are seconds and select chunks overlapping that window. */
export const chunksQuerySchema = z
  .object({
    from: z.coerce.number().nonnegative().optional(),
    to: z.coerce.number().nonnegative().optional(),
    limit: z.coerce.number().int().min(1).max(500).default(100),
    offset: z.coerce.number().int().min(0).default(0),
  })
  .refine((v) => v.from === undefined || v.to === undefined || v.from <= v.to, {
    message: 'from must be <= to',
    path: ['from'],
  });

/** GET /api/sermons/:id/related */
export const relatedQuerySchema = z.object({
  chunkId: z.string().trim().min(1).max(100).optional(),
  limit: z.coerce.number().int().min(1).max(20).default(5),
});
