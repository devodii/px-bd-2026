import { describe, expect, it, vi } from 'vitest';
import type { EmbeddingProvider } from '../../src/providers/embeddings/embedding.provider.js';
import { IngestionService } from '../../src/services/ingestion/ingestion.service.js';
import { ReindexService } from '../../src/services/ingestion/reindex.service.js';
import { EmbeddingProviderError } from '../../src/utils/errors.js';
import { fakeEmbeddings, memoryRepos, rawRow, unavailableEmbeddings } from '../helpers/fakes.js';

function setup(provider: EmbeddingProvider = fakeEmbeddings(), batchSize = 64) {
  const embeddings = provider as ReturnType<typeof fakeEmbeddings>;
  const repos = memoryRepos();
  const service = new IngestionService(
    repos.sermonRepo,
    repos.transcriptRepo,
    embeddings,
    batchSize,
  );
  return { ...repos, service, embeddings };
}

const chunk = (n: number, sermonId = 'sermon_123') =>
  rawRow({
    sermonId,
    chunkId: `chunk_${String(n).padStart(3, '0')}`,
    startTime: n * 60,
    endTime: n * 60 + 60,
    text: `passage ${n}`,
  });

describe('duplicate ingestion', () => {
  it('is idempotent: the same input twice creates nothing new', async () => {
    const { service, sermons, chunks } = setup();
    const rows = [chunk(1), chunk(2), chunk(3)];

    const first = await service.ingestChunks(rows);
    expect(first.sermons).toEqual({ created: 1, updated: 0 });
    expect(first.chunks).toMatchObject({ created: 3, updated: 0, unchanged: 0 });

    const second = await service.ingestChunks(rows);
    expect(second.sermons).toEqual({ created: 0, updated: 1 });
    expect(second.chunks).toMatchObject({ created: 0, updated: 0, unchanged: 3 });
    expect(sermons.size).toBe(1);
    expect(chunks.size).toBe(3);
  });

  it('does not re-embed unchanged chunks', async () => {
    const { service, embeddings } = setup();
    await service.ingestChunks([chunk(1), chunk(2)]);
    embeddings.embedTexts.mockClear();
    const again = await service.ingestChunks([chunk(1), chunk(2)]);
    expect(embeddings.embedTexts).not.toHaveBeenCalled();
    expect(again.embeddings.status).toBe('not-needed');
  });

  it('updates changed text and re-embeds only that chunk', async () => {
    const { service, embeddings, chunks } = setup();
    await service.ingestChunks([chunk(1), chunk(2)]);
    embeddings.embedTexts.mockClear();

    const r = await service.ingestChunks([
      chunk(1),
      rawRow({ ...chunk(2), text: 'edited passage' }),
    ]);
    expect(r.chunks).toMatchObject({ created: 0, updated: 1, unchanged: 1 });
    expect(embeddings.embedTexts).toHaveBeenCalledWith(['edited passage']);
    expect([...chunks.values()].every((c) => c.embedding !== null)).toBe(true);
  });

  it('collapses duplicates inside one batch (last wins)', async () => {
    const { service, chunks } = setup();
    const r = await service.ingestChunks([chunk(1), rawRow({ ...chunk(1), text: 'newer' })]);
    expect(r.chunks.duplicatesInBatch).toBe(1);
    expect(chunks.size).toBe(1);
    expect([...chunks.values()][0]?.text).toBe('newer');
  });
});

describe('batch ingestion', () => {
  it('ingests several sermons in one request and reports statistics', async () => {
    const { service, sermons, chunks } = setup();
    const r = await service.ingestChunks([
      chunk(1, 'a'),
      chunk(2, 'a'),
      chunk(1, 'b'),
      rawRow({ sermonId: 'b', text: '' }),
    ]);
    expect(r).toMatchObject({
      received: 4,
      accepted: 3,
      sermons: { created: 2 },
      chunks: { created: 3 },
    });
    expect(r.rejected).toHaveLength(1);
    expect(sermons.size).toBe(2);
    expect(chunks.size).toBe(3);
  });

  it('embeds with batched provider calls, not one call per chunk', async () => {
    const { service, embeddings } = setup(fakeEmbeddings(), 4);
    const rows = Array.from({ length: 10 }, (_, i) => chunk(i + 1));
    const r = await service.ingestChunks(rows);
    expect(r.embeddings).toMatchObject({ status: 'complete', generated: 10, model: 'fake-model' });
    expect(embeddings.embedTexts).toHaveBeenCalledTimes(3); // 4 + 4 + 2
    expect(embeddings.embedText).not.toHaveBeenCalled();
  });

  it('rejects a request where nothing is valid', async () => {
    const { service } = setup();
    await expect(service.ingestChunks([{ nope: true }])).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
  });

  it("merges sermon details across a sermon's chunks without erasing known fields", async () => {
    const { service, sermons } = setup();
    await service.ingestChunks([chunk(1), chunk(2)]);
    await service.ingestSermons([
      { sermonId: 'sermon_123', title: 'Walking By Faith', description: 'A study' },
    ]);
    const s = [...sermons.values()][0];
    expect(s).toMatchObject({ speaker: 'Pastor Name', description: 'A study' });
  });
});

describe('embedding failure during ingestion', () => {
  it('still stores the chunks (searchable by keyword) and reports the failure', async () => {
    const embeddings = fakeEmbeddings({
      embedTexts: vi.fn(() => Promise.reject(new EmbeddingProviderError('rate limited', true))),
    });
    const { service, chunks } = setup(embeddings);
    const r = await service.ingestChunks([chunk(1), chunk(2)]);
    expect(chunks.size).toBe(2);
    expect(r.embeddings).toMatchObject({ status: 'failed', generated: 0, error: 'rate limited' });
  });

  it('with the placeholder provider, skips embeddings instead of failing', async () => {
    const { service, chunks } = setup(unavailableEmbeddings());
    const r = await service.ingestChunks([chunk(1)]);
    expect(chunks.size).toBe(1);
    expect(r.embeddings.status).toBe('skipped');
  });
});

describe('reindex', () => {
  it('fills missing vectors in batches and can be re-run safely', async () => {
    const repos = memoryRepos();
    // ingest with no provider => no vectors
    await new IngestionService(
      repos.sermonRepo,
      repos.transcriptRepo,
      unavailableEmbeddings(),
      64,
    ).ingestChunks(Array.from({ length: 5 }, (_, i) => chunk(i + 1)));
    const embeddings = fakeEmbeddings();
    const reindex = new ReindexService(repos.transcriptRepo, embeddings, 2, undefined, 0);

    const result = await reindex.run({ embeddings: true, searchVectors: false, force: false });
    expect(result.embeddingsGenerated).toBe(5);
    expect(embeddings.embedTexts).toHaveBeenCalledTimes(3);
    expect([...repos.chunks.values()].every((c) => c.embeddingModel === 'fake-model')).toBe(true);

    expect(
      (await reindex.run({ embeddings: true, searchVectors: false, force: false }))
        .embeddingsGenerated,
    ).toBe(0);
  });

  it('migrates to a new model: force re-embeds everything', async () => {
    const repos = memoryRepos();
    const ingest = new IngestionService(
      repos.sermonRepo,
      repos.transcriptRepo,
      fakeEmbeddings(),
      64,
    );
    await ingest.ingestChunks([chunk(1), chunk(2)]);

    const newModel = fakeEmbeddings({ model: 'fake-model-v2' });
    const reindex = new ReindexService(repos.transcriptRepo, newModel, 10, undefined, 0);
    // chunks embedded by another model are stale even without --force
    expect(
      (await reindex.run({ embeddings: true, searchVectors: false, force: false }))
        .embeddingsGenerated,
    ).toBe(2);
    expect(
      (await reindex.run({ embeddings: true, searchVectors: false, force: true }))
        .embeddingsGenerated,
    ).toBe(2);
  });

  it('retries retryable provider errors and refuses to run without a provider', async () => {
    const repos = memoryRepos();
    await new IngestionService(
      repos.sermonRepo,
      repos.transcriptRepo,
      unavailableEmbeddings(),
      64,
    ).ingestChunks([chunk(1)]);
    const flaky = fakeEmbeddings({
      embedTexts: vi
        .fn()
        .mockRejectedValueOnce(new EmbeddingProviderError('429', true))
        .mockResolvedValue([[1, 2, 3]]),
    });
    const r = await new ReindexService(repos.transcriptRepo, flaky, 10, undefined, 0).run({
      embeddings: true,
      searchVectors: false,
      force: false,
    });
    expect(r.embeddingsGenerated).toBe(1);

    await expect(
      new ReindexService(repos.transcriptRepo, unavailableEmbeddings(), 10).run({
        embeddings: true,
        searchVectors: false,
        force: false,
      }),
    ).rejects.toMatchObject({ code: 'EMBEDDING_UNAVAILABLE' });
  });
});
