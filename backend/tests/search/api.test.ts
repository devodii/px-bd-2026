import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/app.js';
import { logger } from '../../src/utils/logger.js';
import { NotFoundError } from '../../src/utils/errors.js';
import type { SearchResponse } from '../../src/services/search/search.types.js';
import { unavailableEmbeddings, fakeJev, fakeLlm } from '../helpers/fakes.js';

const searchResponse: SearchResponse = {
  query: 'faith during difficult seasons',
  results: [
    {
      sermon: { id: 's1', title: 'Walking By Faith', date: '2026-01-12', speaker: 'Pastor Name' },
      chunk: { id: 'c1', startTime: 184, endTime: 247, text: 'Faith does not mean...' },
      relevance: { score: 0.94, source: 'jev' },
      audio: { url: 'https://audio.example/a.mp3', startTime: 184 },
    },
  ],
  meta: { total: 1, searchType: 'hybrid', intent: 'TOPIC_SEARCH', jev: 'applied', warnings: [] },
};

function build() {
  const services = {
    search: { search: vi.fn(async () => searchResponse) },
    sermons: {
      get: vi.fn(async () => ({ id: 's1' })),
      listChunks: vi.fn(async () => ({ sermonId: 's1', chunks: [], total: 0 })),
    },
    related: {
      findRelated: vi.fn(async () => ({
        sermonId: 's1',
        basis: 'sermon',
        related: [],
        warnings: [],
      })),
    },
    ingestion: {
      ingestChunks: vi.fn(async () => ({ accepted: 1 })),
      ingestSermons: vi.fn(async () => ({ created: 1 })),
    },
    reindex: {
      start: vi.fn(() => ({ state: 'running' })),
      getStatus: vi.fn(() => ({ state: 'idle' })),
    },
    answer: {},
    ask: { ask: vi.fn(async () => ({ answer: 'x', answered: true, sources: [] })) },
  };
  const app = createApp({
    container: {
      providers: { embeddings: unavailableEmbeddings(), jev: fakeJev(), llm: fakeLlm('{}') },
      services: services as never,
      checkDatabase: async () => true,
    },
    logger,
    ingestionApiKey: 'test-ingestion-key',
    rateLimitPerMinute: 1000,
    ingestionRateLimitPerMinute: 1000,
  });
  return { app, services };
}

describe('GET/POST /api/search', () => {
  it('returns the documented result shape for GET ?q=&limit=', async () => {
    const { app, services } = build();
    const res = await request(app)
      .get('/api/search')
      .query({ q: 'faith during difficult seasons', limit: 10 });
    expect(res.status).toBe(200);
    expect(res.body).toEqual(searchResponse);
    expect(services.search.search).toHaveBeenCalledWith(
      { query: 'faith during difficult seasons', limit: 10, searchType: undefined },
      expect.anything(),
    );
    expect(res.headers['x-request-id']).toBeTruthy();
  });

  it('accepts structured filters via POST', async () => {
    const { app, services } = build();
    const body = {
      query: 'grace',
      limit: 5,
      sermonId: 's9',
      speaker: 'Pastor Name',
      dateFrom: '2026-01-01',
      dateTo: '2026-03-01',
      searchType: 'keyword',
    };
    await request(app).post('/api/search').send(body).expect(200);
    expect(services.search.search).toHaveBeenCalledWith(body, expect.anything());
  });

  it.each([
    ['missing q', () => request(build().app).get('/api/search')],
    ['empty query', () => request(build().app).get('/api/search').query({ q: '   ' })],
    [
      'query too long',
      () =>
        request(build().app)
          .get('/api/search')
          .query({ q: 'x'.repeat(501) }),
    ],
    [
      'limit out of range',
      () => request(build().app).get('/api/search').query({ q: 'a', limit: 500 }),
    ],
    [
      'bad date',
      () => request(build().app).post('/api/search').send({ query: 'a', dateFrom: 'soon' }),
    ],
    [
      'reversed dates',
      () =>
        request(build().app)
          .post('/api/search')
          .send({ query: 'a', dateFrom: '2026-05-01', dateTo: '2026-01-01' }),
    ],
    [
      'bad search type',
      () => request(build().app).post('/api/search').send({ query: 'a', searchType: 'magic' }),
    ],
  ])('400s on %s with a structured error', async (_n, run) => {
    const res = await run();
    expect(res.status).toBe(400);
    expect(res.body.error).toMatchObject({
      code: 'VALIDATION_ERROR',
      requestId: expect.any(String),
    });
  });

  it('400s on malformed JSON and 404s unknown routes', async () => {
    const { app } = build();
    expect(
      (await request(app).post('/api/search').set('content-type', 'application/json').send('{oops'))
        .status,
    ).toBe(400);
    expect((await request(app).get('/api/nothing')).body.error.code).toBe('NOT_FOUND');
  });
});

describe('sermon endpoints', () => {
  it('maps NotFoundError to 404', async () => {
    const { app, services } = build();
    services.sermons.get.mockRejectedValueOnce(new NotFoundError('Sermon'));
    const res = await request(app).get('/api/sermons/missing');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('serves chunks with a time window and related teachings', async () => {
    const { app, services } = build();
    await request(app).get('/api/sermons/s1/chunks').query({ from: 60, to: 120 }).expect(200);
    expect(services.sermons.listChunks).toHaveBeenCalledWith('s1', {
      from: 60,
      to: 120,
      limit: 100,
      offset: 0,
    });
    await request(app).get('/api/sermons/s1/related').query({ limit: 3 }).expect(200);
    expect(services.related.findRelated).toHaveBeenCalledWith({
      sermonId: 's1',
      chunkId: undefined,
      limit: 3,
    });
  });
});

describe('ingestion endpoints are protected', () => {
  it('rejects requests without or with a wrong API key', async () => {
    const { app, services } = build();
    expect(
      (
        await request(app)
          .post('/api/ingestion/chunks')
          .send({ chunks: [{}] })
      ).status,
    ).toBe(401);
    expect(
      (
        await request(app)
          .post('/api/ingestion/chunks')
          .set('x-api-key', 'wrong')
          .send({ chunks: [{}] })
      ).status,
    ).toBe(401);
    expect((await request(app).post('/api/ingestion/reindex').send({})).status).toBe(401);
    expect(services.ingestion.ingestChunks).not.toHaveBeenCalled();
  });

  it('accepts the key via x-api-key or Bearer', async () => {
    const { app } = build();
    await request(app)
      .post('/api/ingestion/chunks')
      .set('x-api-key', 'test-ingestion-key')
      .send({ chunks: [{ a: 1 }] })
      .expect(200);
    await request(app)
      .post('/api/ingestion/sermons')
      .set('authorization', 'Bearer test-ingestion-key')
      .send({ sermons: [{ a: 1 }] })
      .expect(200);
    await request(app)
      .post('/api/ingestion/reindex')
      .set('x-api-key', 'test-ingestion-key')
      .send({})
      .expect(202);
    await request(app)
      .get('/api/ingestion/reindex')
      .set('x-api-key', 'test-ingestion-key')
      .expect(200);
  });

  it('validates the batch envelope', async () => {
    const { app } = build();
    const res = await request(app)
      .post('/api/ingestion/chunks')
      .set('x-api-key', 'test-ingestion-key')
      .send({ chunks: [] });
    expect(res.status).toBe(400);
  });

  it('is disabled (503) when no ingestion key is configured', async () => {
    const { app: base } = build();
    void base;
    const app = createApp({
      container: {
        providers: { embeddings: unavailableEmbeddings(), jev: fakeJev(), llm: fakeLlm('{}') },
        services: build().services as never,
        checkDatabase: async () => true,
      },
      logger,
      ingestionApiKey: undefined,
      rateLimitPerMinute: 100,
      ingestionRateLimitPerMinute: 100,
    });
    expect(
      (
        await request(app)
          .post('/api/ingestion/chunks')
          .set('x-api-key', 'anything')
          .send({ chunks: [{}] })
      ).status,
    ).toBe(503);
  });
});

describe('rate limiting', () => {
  it('returns 429 with the standard error shape once the limit is exceeded', async () => {
    const { services } = build();
    const app = createApp({
      container: {
        providers: { embeddings: unavailableEmbeddings(), jev: fakeJev(), llm: fakeLlm('{}') },
        services: services as never,
        checkDatabase: async () => true,
      },
      logger,
      ingestionApiKey: 'k',
      rateLimitPerMinute: 2,
      ingestionRateLimitPerMinute: 2,
    });
    await request(app).get('/api/search').query({ q: 'a' }).expect(200);
    await request(app).get('/api/search').query({ q: 'a' }).expect(200);
    const res = await request(app).get('/api/search').query({ q: 'a' });
    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe('RATE_LIMITED');
  });
});

describe('health and error hygiene', () => {
  it('reports configuration state without exposing keys', async () => {
    process.env.JEV_API_KEY = 'super-secret-value';
    const { app } = build();
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: 'ok',
      database: 'up',
      providers: { embeddings: { configured: false }, jev: { configured: true } },
    });
    expect(JSON.stringify(res.body)).not.toContain('super-secret-value');
    delete process.env.JEV_API_KEY;
  });

  it('hides internals of unexpected errors', async () => {
    const { app, services } = build();
    services.search.search.mockRejectedValueOnce(
      new Error('connection to db at 10.0.0.5 failed: password=hunter2'),
    );
    const res = await request(app).get('/api/search').query({ q: 'a' });
    expect(res.status).toBe(500);
    expect(res.body.error).toMatchObject({
      code: 'INTERNAL_ERROR',
      message: 'Something went wrong',
    });
    expect(JSON.stringify(res.body)).not.toContain('hunter2');
  });

  it('answers with the 503 provider shape when the LLM is unavailable', async () => {
    const { app, services } = build();
    const { LlmError } = await import('../../src/utils/errors.js');
    services.ask.ask.mockRejectedValueOnce(new LlmError('No LLM provider is configured.'));
    const res = await request(app).post('/api/answer').send({ query: 'what is faith?' });
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('LLM_UNAVAILABLE');
  });
});
