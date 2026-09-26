import { z } from 'zod';

export const MAX_CHUNK_TEXT_LENGTH = 20_000;

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected date as YYYY-MM-DD');
const metadata = z.record(z.string(), z.unknown());

/** The internal sermon shape every source format is normalized into. */
export const normalizedSermonSchema = z.object({
  externalId: z.string().trim().min(1).max(200),
  title: z.string().trim().min(1).max(500),
  speaker: z.string().trim().min(1).max(200).optional(),
  date: isoDate.optional(),
  description: z.string().trim().max(5000).optional(),
  audioUrl: z.string().trim().url().max(2000).optional(),
  /** Seconds. */
  duration: z.number().nonnegative().finite().optional(),
  metadata: metadata.optional(),
});
export type NormalizedSermon = z.infer<typeof normalizedSermonSchema>;

/** The internal chunk shape. `startTime`/`endTime` are seconds from the start of the sermon audio. */
export const normalizedChunkSchema = z
  .object({
    externalId: z.string().trim().min(1).max(200),
    sermonExternalId: z.string().trim().min(1).max(200),
    chunkIndex: z.number().int().nonnegative(),
    startTime: z.number().nonnegative().finite(),
    endTime: z.number().nonnegative().finite(),
    text: z.string().trim().min(1).max(MAX_CHUNK_TEXT_LENGTH),
    metadata: metadata.optional(),
  })
  .refine((c) => c.endTime >= c.startTime, {
    message: 'endTime must be >= startTime',
    path: ['endTime'],
  });
export type NormalizedChunk = z.infer<typeof normalizedChunkSchema>;

/** A chunk together with the sermon it belongs to (as found in the existing transcript data). */
export interface NormalizedItem {
  sermon: NormalizedSermon;
  chunk: NormalizedChunk;
}
