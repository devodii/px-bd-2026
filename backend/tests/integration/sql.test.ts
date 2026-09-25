// Runs the real migration and the real repository SQL against PGlite (WASM Postgres with pgvector and
// pg_trgm), so the raw queries are verified without Docker. Prisma is replaced by a thin executor.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite/vector';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import type { Prisma } from '../../src/generated/prisma/client.js';
import { PrismaSearchRepository } from '../../src/repositories/search.repository.js';
import { PrismaTranscriptRepository } from '../../src/repositories/transcript.repository.js';

describe('repository SQL against real Postgres + pgvector (PGlite)', () => {
  it('migration, upserts, vector search, keyword search, filters, related and reindex all behave', async () => {
    const db = new PGlite({ extensions: { vector, pg_trgm } });
    const check = (name: string, ok: boolean, extra?: unknown) => {
      expect(ok, `${name} -> ${JSON.stringify(extra)}`).toBe(true);
    };

    await db.exec('CREATE SCHEMA search; SET search_path = search;');
    await db.exec(readFileSync('prisma/migrations/0001_init/migration.sql', 'utf8'));
    check('migration applies (vector + tsvector + trigram + FK)', true);

    const fake = {
      $queryRaw: async (s: Prisma.Sql) => (await db.query(s.text, s.values as unknown[])).rows,
      $executeRaw: async (s: Prisma.Sql) =>
        (await db.query(s.text, s.values as unknown[])).affectedRows ?? 0,
    };
    const transcripts = new PrismaTranscriptRepository(fake as never);
    const search = new PrismaSearchRepository(fake as never);

    await db.exec(`
      INSERT INTO sermons (id, external_id, title, slug, speaker, date, audio_url, updated_at) VALUES
       ('s1','ext1','Walking By Faith','walking-1','Pastor Chris','2026-01-12','https://a/1.mp3', now()),
       ('s2','ext2','Grace Abounds','grace-2','Pastor Chris','2026-03-01','https://a/2.mp3', now()),
       ('s3','ext3','Guest Message','guest-3','Guest Speaker','2025-06-01', NULL, now());
    `);

    const mk = (i: number, text: string) => ({
      externalId: `c${i}`,
      sermonExternalId: 'x',
      chunkIndex: i,
      startTime: i * 60,
      endTime: i * 60 + 60,
      text,
    });
    const s1 = [
      mk(0, 'Faith carries you through difficult seasons when you cannot see the way.'),
      mk(1, 'As Paul wrote in Romans 8:28 all things work together for good.'),
      mk(2, 'Walking by faith and not by sight is a daily decision.'),
    ];
    let r = await transcripts.upsertChunks('s1', s1);
    check('upsert: 3 created', r.created === 3 && r.updated === 0 && r.unchanged === 0, r);
    r = await transcripts.upsertChunks('s1', s1);
    check(
      'upsert again: idempotent (3 unchanged)',
      r.created === 0 && r.updated === 0 && r.unchanged === 3,
      r,
    );
    await transcripts.upsertChunks('s2', [
      mk(0, 'Grace is unmerited favour that abounds in every season.'),
    ]);
    await transcripts.upsertChunks('s3', [mk(0, 'A guest speaker discusses faith and patience.')]);

    const need = await transcripts.findChunksNeedingEmbedding('s1', 'm1');
    check('all 3 chunks need embeddings', need.length === 3, need);

    const vecs: Record<string, number[]> = {
      'Faith carries': [1, 0, 0],
      'As Paul': [0.9, 0.1, 0],
      'Walking by': [0.8, 0.2, 0],
      'Grace is': [0, 1, 0],
      'A guest': [0.7, 0.3, 0],
    };
    const all = (
      await db.query<{ id: string; text: string }>('SELECT id, text FROM search.transcript_chunks')
    ).rows;
    const n = await transcripts.setEmbeddings(
      all.map((c) => ({
        id: c.id,
        vector: Object.entries(vecs).find(([k]) => c.text.startsWith(k))![1],
      })),
      'm1',
    );
    check('setEmbeddings updated 5 rows', n === 5, n);

    // change text of one chunk => embedding must be reset, others untouched
    r = await transcripts.upsertChunks('s1', [
      s1[0]!,
      { ...s1[1]!, text: 'Romans 8:28 says all things work together for good.' },
      s1[2]!,
    ]);
    check('changed text: 1 updated, 2 unchanged', r.updated === 1 && r.unchanged === 2, r);
    const stale = await transcripts.findChunksNeedingEmbedding('s1', 'm1');
    check(
      'only the edited chunk lost its vector',
      stale.length === 1 && stale[0]!.text.startsWith('Romans 8:28 says'),
      stale,
    );
    await transcripts.setEmbeddings([{ id: stale[0]!.id, vector: [0.9, 0.1, 0] }], 'm1');

    // --- vector search
    let hits = await search.vectorSearch({
      vector: [1, 0, 0],
      model: 'm1',
      dimensions: null,
      limit: 3,
    });
    check(
      'vector search (no dims): nearest first',
      hits[0]!.chunk.text.startsWith('Faith carries') && hits[0]!.score > 0.99,
      hits.map((h) => [h.chunk.text.slice(0, 12), h.score]),
    );
    hits = await search.vectorSearch({ vector: [1, 0, 0], model: 'm1', dimensions: 3, limit: 10 });
    check(
      'vector search (dims cast): 5 hits, scores 0..1 descending',
      hits.length === 5 &&
        hits.every(
          (h, i) => h.score >= 0 && h.score <= 1 && (i === 0 || hits[i - 1]!.score >= h.score),
        ),
      hits.map((h) => h.score),
    );
    check(
      'vector hit carries sermon + timestamps',
      hits[0]!.chunk.sermon.title === 'Walking By Faith' &&
        hits[0]!.chunk.startTime === 0 &&
        hits[0]!.chunk.sermon.audioUrl === 'https://a/1.mp3' &&
        hits[0]!.chunk.sermon.date === '2026-01-12',
      hits[0],
    );
    hits = await search.vectorSearch({
      vector: [1, 0, 0],
      model: 'other-model',
      dimensions: 3,
      limit: 10,
    });
    check('vectors from another model are ignored', hits.length === 0, hits.length);
    hits = await search.vectorSearch({
      vector: [1, 0, 0],
      model: 'm1',
      dimensions: 3,
      limit: 10,
      filters: { speaker: 'guest speaker' },
    });
    check(
      'filter: speaker (case-insensitive)',
      hits.length === 1 && hits[0]!.chunk.sermonId === 's3',
      hits.length,
    );
    hits = await search.vectorSearch({
      vector: [1, 0, 0],
      model: 'm1',
      dimensions: 3,
      limit: 10,
      filters: { dateFrom: '2026-01-01', dateTo: '2026-02-01' },
    });
    check(
      'filter: date range',
      hits.length === 3 && hits.every((h) => h.chunk.sermonId === 's1'),
      hits.length,
    );
    hits = await search.vectorSearch({
      vector: [1, 0, 0],
      model: 'm1',
      dimensions: 3,
      limit: 10,
      filters: { sermonId: 's2' },
    });
    check('filter: sermonId', hits.length === 1 && hits[0]!.chunk.sermonId === 's2', hits.length);
    hits = await search.vectorSearch({
      vector: [1, 0, 0],
      model: 'm1',
      dimensions: 3,
      limit: 10,
      excludeSermonId: 's1',
    });
    check(
      'excludeSermonId (related teachings)',
      hits.length === 2 && hits.every((h) => h.chunk.sermonId !== 's1'),
      hits.length,
    );

    // --- keyword search
    let kw = await search.keywordSearch({
      tsQuery: 'faith | difficult | seasons',
      phrase: 'faith during difficult seasons',
      limit: 10,
    });
    check(
      'keyword (natural language OR): ranks the best chunk first',
      kw[0]?.chunk.text.startsWith('Faith carries') === true,
      kw.map((k) => [k.chunk.text.slice(0, 15), k.score]),
    );
    check(
      'keyword: stemming matches "season" for "seasons"',
      kw.some((k) => k.chunk.sermonId === 's2'),
      kw.map((k) => k.chunk.sermonId),
    );
    kw = await search.keywordSearch({
      tsQuery: 'romans <-> 8 <-> 28',
      phrase: 'Romans 8:28',
      limit: 10,
    });
    check(
      'keyword: "Romans 8:28" finds the exact reference first',
      kw[0]?.chunk.text.includes('Romans 8:28') === true && kw[0]!.score >= 1,
      kw.map((k) => [k.chunk.text.slice(0, 20), k.score]),
    );
    kw = await search.keywordSearch({ tsQuery: null, phrase: '100%_literal', limit: 10 });
    check(
      'keyword: null tsquery + LIKE wildcards are safe (no match, no error)',
      kw.length === 0,
      kw.length,
    );
    kw = await search.keywordSearch({
      tsQuery: 'faith',
      phrase: 'faith',
      limit: 10,
      filters: { speaker: 'Guest Speaker' },
    });
    check('keyword filter: speaker', kw.length === 1 && kw[0]!.chunk.sermonId === 's3', kw.length);
    kw = await search.keywordSearch({ tsQuery: 'faith', phrase: 'faith', limit: 1 });
    check('keyword: limit respected', kw.length === 1, kw.length);

    // --- related/centroid
    const centroid = await transcripts.getSermonCentroid('s1', 'm1');
    check(
      'sermon centroid is a 3-d vector',
      Array.isArray(centroid) && centroid!.length === 3 && Math.abs(centroid![0]! - 0.9) < 0.01,
      centroid,
    );
    check(
      'centroid is null for an unknown model',
      (await transcripts.getSermonCentroid('s1', 'zzz')) === null,
    );
    const ce = await transcripts.getChunkEmbedding(all[0]!.id, 'm1');
    check('chunk embedding round-trips', Array.isArray(ce) && ce!.length === 3, ce);

    // --- reindex batching
    let after: string | null = null;
    let seen = 0;
    for (;;) {
      const b = await transcripts.nextEmbeddingBatch({
        afterId: after,
        limit: 2,
        model: 'm2',
        force: false,
      });
      if (b.length === 0) break;
      seen += b.length;
      after = b[b.length - 1]!.id;
    }
    check('reindex: keyset batches cover all 5 chunks for a new model', seen === 5, seen);
    check(
      'reindex: nothing stale for the current model',
      (
        await transcripts.nextEmbeddingBatch({
          afterId: null,
          limit: 10,
          model: 'm1',
          force: false,
        })
      ).length === 0,
    );
    check(
      'reindex: force returns everything',
      (await transcripts.nextEmbeddingBatch({ afterId: null, limit: 10, model: 'm1', force: true }))
        .length === 5,
    );
    let sv = 0;
    after = null;
    for (;;) {
      const b = await transcripts.rebuildSearchVectorBatch(after, 2);
      if (b.count === 0) break;
      sv += b.count;
      after = b.lastId;
    }
    check('reindex: search vectors rebuilt in batches (5)', sv === 5, sv);

    // --- HNSW expression index used by dimension-cast queries
    await db.exec(
      'CREATE INDEX transcript_chunks_embedding_hnsw_3 ON transcript_chunks USING hnsw ((embedding::vector(3)) vector_cosine_ops) WHERE embedding IS NOT NULL',
    );
    await db.exec('SET enable_seqscan = off');
    const plan = (
      await db.query<{ 'QUERY PLAN': string }>(
        `EXPLAIN SELECT id FROM transcript_chunks c WHERE c.embedding IS NOT NULL AND c.embedding_model = 'm1' ORDER BY (c.embedding::vector(3)) <=> '[1,0,0]'::vector(3) LIMIT 5`,
      )
    ).rows
      .map((x) => x['QUERY PLAN'])
      .join('\n');
    check('HNSW expression index is used by the dimension-cast query', /hnsw_3/.test(plan), plan);
  }, 120_000);
});
