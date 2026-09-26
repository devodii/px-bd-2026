import {
  normalizedChunkSchema,
  normalizedSermonSchema,
  type NormalizedItem,
  type NormalizedSermon,
} from '../../schemas/transcript.schema.js';

/**
 * Adapter between the existing transcript data and our internal schema.
 *
 * Handles the canonical shape
 *   { sermonId, chunkId, title, date, speaker, audioUrl, startTime, endTime, text }
 * and common variants (snake_case, `start_sec` + `duration_sec` as written by the Python
 * pipeline, "mm:ss" timestamps, ...). If the source format changes, extend ALIASES here only.
 */
type Raw = Record<string, unknown>;

const ALIASES = {
  sermonId: ['sermonId', 'sermon_id', 'sermonExternalId'],
  chunkId: ['chunkId', 'chunk_id', 'id'],
  chunkIndex: ['chunkIndex', 'chunk_index', 'idx', 'index'],
  startTime: ['startTime', 'start_time', 'start', 'start_sec', 'startSec'],
  endTime: ['endTime', 'end_time', 'end', 'end_sec', 'endSec'],
  chunkDuration: ['chunkDuration', 'duration_sec', 'durationSec', 'length'],
  text: ['text', 'transcript'],
  title: ['title', 'sermonTitle', 'sermon_title'],
  fileName: ['file_name', 'fileName'],
  caption: ['caption'],
  date: ['date', 'posted_at', 'postedAt', 'recordedAt', 'recorded_at'],
  speaker: ['speaker', 'pastor', 'preacher'],
  audioUrl: ['audioUrl', 'audio_url', 'audio'],
  sermonDuration: ['sermonDuration', 'sermon_duration', 'sermon_duration_sec'],
  description: ['description'],
  metadata: ['metadata'],
} as const;

function pick(raw: Raw, key: keyof typeof ALIASES): unknown {
  for (const alias of ALIASES[key]) {
    const v = raw[alias];
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return undefined;
}

/** Accepts seconds (number / numeric string) or "mm:ss" / "hh:mm:ss". */
export function parseSeconds(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value !== 'string') return undefined;
  const s = value.trim();
  if (/^\d+(\.\d+)?$/.test(s)) return Number(s);
  const m = /^(?:(\d+):)?(\d{1,2}):(\d{2}(?:\.\d+)?)$/.exec(s);
  if (!m) return undefined;
  return Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

function toDateString(value: unknown): string | undefined {
  if (value instanceof Date)
    return Number.isNaN(value.getTime()) ? undefined : value.toISOString().slice(0, 10);
  if (typeof value !== 'string') return undefined;
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(value.trim());
  // An unparseable date is passed through so validation rejects it, rather than silently dropping it.
  return m?.[1] ?? value;
}

function str(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  return undefined;
}

function titleFromFileName(name: string): string {
  return name
    .replace(/\.[a-z0-9]{2,4}$/i, '')
    .replace(/^\d+_/, '')
    .replace(/[_-]+/g, ' ')
    .trim();
}

export interface NormalizeIssue {
  index: number;
  errors: string[];
}

export interface NormalizeResult {
  items: NormalizedItem[];
  rejected: NormalizeIssue[];
}

function isRecord(v: unknown): v is Raw {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Turns one source row into the internal sermon + chunk, or returns validation errors. */
export function normalizeChunk(
  raw: unknown,
  fallbackIndex?: number,
): { ok: true; item: NormalizedItem } | { ok: false; errors: string[] } {
  if (!isRecord(raw)) return { ok: false, errors: ['Chunk must be an object'] };

  const sermonExternalId = str(pick(raw, 'sermonId'));
  const start = parseSeconds(pick(raw, 'startTime'));
  const explicitEnd = parseSeconds(pick(raw, 'endTime'));
  const chunkDuration = parseSeconds(pick(raw, 'chunkDuration'));
  const endTime =
    explicitEnd ??
    (start !== undefined && chunkDuration !== undefined ? start + chunkDuration : undefined);

  const chunkId = str(pick(raw, 'chunkId'));
  const suffix = chunkId ? /(\d+)$/.exec(chunkId)?.[1] : undefined;
  const chunkIndex =
    (typeof pick(raw, 'chunkIndex') === 'number'
      ? (pick(raw, 'chunkIndex') as number)
      : undefined) ??
    (suffix !== undefined ? Number(suffix) : undefined) ??
    fallbackIndex;

  const fileName = str(pick(raw, 'fileName'));
  const title =
    str(pick(raw, 'title')) ??
    (fileName ? titleFromFileName(fileName) : undefined) ??
    str(pick(raw, 'caption'));

  const errors: string[] = [];
  const sermon = normalizedSermonSchema.safeParse({
    externalId: sermonExternalId,
    title,
    speaker: str(pick(raw, 'speaker')),
    date: toDateString(pick(raw, 'date')),
    description: str(pick(raw, 'description')),
    audioUrl: str(pick(raw, 'audioUrl')),
    duration: parseSeconds(pick(raw, 'sermonDuration')),
    metadata: isRecord(raw.sermonMetadata) ? raw.sermonMetadata : undefined,
  });
  if (!sermon.success)
    errors.push(...sermon.error.issues.map((i) => `sermon.${i.path.join('.')}: ${i.message}`));

  const chunk = normalizedChunkSchema.safeParse({
    externalId:
      chunkId ??
      (sermonExternalId && chunkIndex !== undefined
        ? `${sermonExternalId}:${chunkIndex}`
        : undefined),
    sermonExternalId,
    chunkIndex,
    startTime: start,
    endTime,
    text: str(pick(raw, 'text')),
    metadata: isRecord(pick(raw, 'metadata')) ? (pick(raw, 'metadata') as Raw) : undefined,
  });
  if (!chunk.success)
    errors.push(...chunk.error.issues.map((i) => `chunk.${i.path.join('.')}: ${i.message}`));

  if (!sermon.success || !chunk.success) return { ok: false, errors };
  return { ok: true, item: { sermon: sermon.data, chunk: chunk.data } };
}

/**
 * Normalizes a batch. Rows without an explicit index/`chunkId` suffix get one from their
 * position by start time within their sermon in this batch (send whole sermons, or explicit
 * indexes, for stable results across batches).
 */
export function normalizeChunks(rows: readonly unknown[]): NormalizeResult {
  const fallbackIndexes = new Map<number, number>();
  const bySermon = new Map<string, { row: number; start: number }[]>();
  rows.forEach((row, i) => {
    if (!isRecord(row)) return;
    const sid = str(pick(row, 'sermonId'));
    const start = parseSeconds(pick(row, 'startTime'));
    if (!sid || start === undefined) return;
    const list = bySermon.get(sid) ?? [];
    list.push({ row: i, start });
    bySermon.set(sid, list);
  });
  for (const list of bySermon.values()) {
    list
      .sort((a, b) => a.start - b.start)
      .forEach((entry, position) => fallbackIndexes.set(entry.row, position));
  }

  const items: NormalizedItem[] = [];
  const rejected: NormalizeIssue[] = [];
  rows.forEach((row, index) => {
    const result = normalizeChunk(row, fallbackIndexes.get(index));
    if (result.ok) items.push(result.item);
    else rejected.push({ index, errors: result.errors });
  });
  return { items, rejected };
}

/** Normalizes explicit sermon records (POST /ingestion/sermons). */
export function normalizeSermon(
  raw: unknown,
): { ok: true; sermon: NormalizedSermon } | { ok: false; errors: string[] } {
  if (!isRecord(raw)) return { ok: false, errors: ['Sermon must be an object'] };
  const parsed = normalizedSermonSchema.safeParse({
    externalId: str(pick(raw, 'sermonId')) ?? str(raw.externalId) ?? str(raw.id),
    title:
      str(pick(raw, 'title')) ??
      (str(pick(raw, 'fileName')) ? titleFromFileName(str(pick(raw, 'fileName'))!) : undefined),
    speaker: str(pick(raw, 'speaker')),
    date: toDateString(pick(raw, 'date')),
    description: str(pick(raw, 'description')),
    audioUrl: str(pick(raw, 'audioUrl')),
    duration: parseSeconds(pick(raw, 'sermonDuration') ?? raw.duration),
    metadata: isRecord(raw.metadata) ? raw.metadata : undefined,
  });
  return parsed.success
    ? { ok: true, sermon: parsed.data }
    : { ok: false, errors: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) };
}
