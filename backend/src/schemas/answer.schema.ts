import { z } from 'zod';
import { env } from '../config/env.js';

export const answerBodySchema = z.object({
  query: z
    .string()
    .transform((s) => s.replace(/\s+/g, ' ').trim())
    .pipe(z.string().min(1).max(env.MAX_QUERY_LENGTH)),
  /** How many top chunks to give the LLM as evidence. */
  evidenceLimit: z.number().int().min(1).max(10).default(5),
  sermonId: z.string().trim().min(1).max(100).optional(),
  speaker: z.string().trim().min(1).max(200).optional(),
  dateFrom: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  dateTo: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
});

export type AnswerRequest = z.infer<typeof answerBodySchema>;
