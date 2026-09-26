import { z } from 'zod';
import { env } from '../config/env.js';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected date as YYYY-MM-DD');

const text = (max: number) =>
  z
    .string()
    .transform((s) => s.replace(/\s+/g, ' ').trim())
    .pipe(z.string().min(1, 'Must not be empty').max(max, `Must be at most ${max} characters`));

export const searchTypeSchema = z.enum(['semantic', 'keyword', 'hybrid']);

const filters = {
  sermonId: z.string().trim().min(1).max(100).optional(),
  speaker: z.string().trim().min(1).max(200).optional(),
  dateFrom: isoDate.optional(),
  dateTo: isoDate.optional(),
};

const dateOrder = (v: { dateFrom?: string | undefined; dateTo?: string | undefined }) =>
  !v.dateFrom || !v.dateTo || v.dateFrom <= v.dateTo;

const dateOrderIssue = { message: 'dateFrom must be on or before dateTo', path: ['dateFrom'] };

/** POST /api/search body. */
export const searchBodySchema = z
  .object({
    query: text(env.MAX_QUERY_LENGTH),
    limit: z.number().int().min(1).max(50).optional(),
    searchType: searchTypeSchema.optional(),
    ...filters,
  })
  .refine(dateOrder, dateOrderIssue);

/** GET /api/search?q=...&limit=... query string. */
export const searchQuerySchema = z
  .object({
    q: text(env.MAX_QUERY_LENGTH),
    limit: z.coerce.number().int().min(1).max(50).optional(),
    type: searchTypeSchema.optional(),
    ...filters,
  })
  .refine(dateOrder, dateOrderIssue);

export type SearchRequest = z.infer<typeof searchBodySchema>;
