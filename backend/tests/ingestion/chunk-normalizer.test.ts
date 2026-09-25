import { describe, expect, it } from 'vitest';
import {
  normalizeChunk,
  normalizeChunks,
  parseSeconds,
} from '../../src/services/ingestion/chunk-normalizer.js';
import { rawRow } from '../helpers/fakes.js';

describe('transcript chunk validation', () => {
  it('normalizes the canonical source format', () => {
    const r = normalizeChunk(rawRow());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.item.sermon).toMatchObject({
      externalId: 'sermon_123',
      title: 'Walking By Faith',
      speaker: 'Pastor Name',
      date: '2026-01-12',
    });
    expect(r.item.chunk).toMatchObject({
      externalId: 'chunk_001',
      chunkIndex: 1,
      startTime: 184,
      endTime: 247,
      text: 'Faith does not mean...',
    });
  });

  it('preserves the original timestamps exactly', () => {
    const r = normalizeChunk(rawRow({ startTime: '1:02:03', endTime: '1:03:00' }));
    expect(r.ok && r.item.chunk.startTime).toBe(3723);
    expect(r.ok && r.item.chunk.endTime).toBe(3780);
  });

  it('understands the python pipeline format (start_sec + duration_sec, file_name)', () => {
    const r = normalizeChunk({
      sermonId: 'pipeline:7',
      idx: 2,
      start_sec: 600,
      duration_sec: 300,
      text: ' hello ',
      file_name: '123_Sunday_Service.mp3',
      posted_at: '2026-02-01T09:00:00Z',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.item.chunk).toMatchObject({
      chunkIndex: 2,
      startTime: 600,
      endTime: 900,
      text: 'hello',
      externalId: 'pipeline:7:2',
    });
    expect(r.item.sermon).toMatchObject({ title: 'Sunday Service', date: '2026-02-01' });
  });

  it.each([
    ['missing text', { text: '' }, 'text'],
    ['missing sermon id', { sermonId: undefined }, 'externalId'],
    ['missing title', { title: undefined }, 'title'],
    ['end before start', { startTime: 300, endTime: 100 }, 'endTime'],
    ['negative start', { startTime: -5 }, 'startTime'],
    ['bad audio url', { audioUrl: 'not a url' }, 'audioUrl'],
    ['bad date', { date: 'yesterday' }, 'date'],
  ])('rejects %s', (_name, over, field) => {
    const r = normalizeChunk(rawRow(over));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join(' ')).toContain(field);
  });

  it('rejects non-objects', () => {
    expect(normalizeChunk('nope').ok).toBe(false);
    expect(normalizeChunk(null).ok).toBe(false);
  });

  it('keeps valid rows and reports the invalid ones by index', () => {
    const { items, rejected } = normalizeChunks([
      rawRow(),
      rawRow({ chunkId: 'chunk_002', text: '' }),
      rawRow({ chunkId: 'chunk_003' }),
    ]);
    expect(items).toHaveLength(2);
    expect(rejected).toEqual([{ index: 1, errors: expect.any(Array) }]);
  });

  it('derives stable indexes by start time when none are given', () => {
    const rows = [
      { sermonId: 's', chunkId: 'a', title: 'T', startTime: 60, endTime: 90, text: 'second' },
      { sermonId: 's', chunkId: 'b', title: 'T', startTime: 0, endTime: 60, text: 'first' },
    ];
    const { items } = normalizeChunks(rows);
    expect(items.map((i) => [i.chunk.text, i.chunk.chunkIndex])).toEqual([
      ['second', 1],
      ['first', 0],
    ]);
  });

  it('parses timestamp strings', () => {
    expect(parseSeconds('12.5')).toBe(12.5);
    expect(parseSeconds('03:04')).toBe(184);
    expect(parseSeconds('abc')).toBeUndefined();
  });
});
