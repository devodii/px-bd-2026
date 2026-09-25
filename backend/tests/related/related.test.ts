import { describe, expect, it, vi } from 'vitest';
import { RelatedTeachingService } from '../../src/services/related/related-teaching.service.js';
import type { SermonRecord } from '../../src/repositories/sermon.repository.js';
import type { TranscriptRepository } from '../../src/repositories/transcript.repository.js';
import {
  fakeEmbeddings,
  fakeSearchRepo,
  hit,
  makeChunk,
  memoryRepos,
  unavailableEmbeddings,
} from '../helpers/fakes.js';

const sermon = (id: string): SermonRecord => ({
  id,
  externalId: id,
  title: id,
  slug: id,
  speaker: null,
  date: null,
  description: null,
  audioUrl: null,
  duration: null,
  metadata: null,
  createdAt: new Date(),
  updatedAt: new Date(),
});

function setup(
  opts: {
    hits?: ReturnType<typeof hit>[];
    centroid?: number[] | null;
    embeddings?: ReturnType<typeof fakeEmbeddings> | ReturnType<typeof unavailableEmbeddings>;
  } = {},
) {
  const repos = memoryRepos();
  repos.sermons.set('src', sermon('src'));
  const transcripts: TranscriptRepository = {
    ...repos.transcriptRepo,
    getSermonCentroid: vi.fn(async () =>
      opts.centroid === undefined ? [0.1, 0.2, 0.3] : opts.centroid,
    ),
    getChunk: vi.fn(async (id: string) =>
      id === 'mine'
        ? makeChunk('mine', { sermonId: 'src' })
        : id === 'foreign'
          ? makeChunk('foreign', { sermonId: 'other' })
          : null,
    ),
    getChunkEmbedding: vi.fn(async () => [0.3, 0.2, 0.1]),
  };
  const search = fakeSearchRepo({ vector: opts.hits ?? [] });
  const service = new RelatedTeachingService(
    repos.sermonRepo,
    transcripts,
    search,
    opts.embeddings ?? fakeEmbeddings(),
    3,
  );
  return { service, search, transcripts };
}

const inSermon = (id: string, sermonId: string, start: number) =>
  makeChunk(
    id,
    { sermonId, startTime: start, endTime: start + 60 },
    { id: sermonId, title: `Sermon ${sermonId}` },
  );

describe('related teachings', () => {
  it('groups similar chunks by sermon, best sermon first, with timestamps', async () => {
    const { service } = setup({
      hits: [
        hit(inSermon('x1', 'x', 100), 0.95),
        hit(inSermon('y1', 'y', 30), 0.9),
        hit(inSermon('x2', 'x', 400), 0.88),
        hit(inSermon('z1', 'z', 0), 0.7),
      ],
    });

    const res = await service.findRelated({ sermonId: 'src', limit: 5 });

    expect(res.basis).toBe('sermon');
    expect(res.related.map((r) => r.sermon.id)).toEqual(['x', 'y', 'z']);
    expect(res.related[0]).toMatchObject({ similarity: 0.95, audio: { startTime: 100 } });
    expect(res.related[0]?.chunks.map((c) => [c.id, c.startTime, c.endTime])).toEqual([
      ['x1', 100, 160],
      ['x2', 400, 460],
    ]);
  });

  it('excludes the source sermon from the search and caps the number of sermons', async () => {
    const hits = ['a', 'b', 'c', 'd'].map((s, i) => hit(inSermon(`${s}1`, s, 0), 0.9 - i * 0.1));
    const { service, search } = setup({ hits });
    const res = await service.findRelated({ sermonId: 'src', limit: 2 });
    expect(search.vectorSearch).toHaveBeenCalledWith(
      expect.objectContaining({ excludeSermonId: 'src', model: 'fake-model' }),
    );
    expect(res.related).toHaveLength(2);
    expect(res.related.every((r) => r.sermon.id !== 'src')).toBe(true);
  });

  it('can be based on a single chunk of the sermon', async () => {
    const { service, transcripts } = setup({ hits: [hit(inSermon('x1', 'x', 0), 0.9)] });
    const res = await service.findRelated({ sermonId: 'src', chunkId: 'mine', limit: 3 });
    expect(res.basis).toBe('chunk');
    expect(transcripts.getChunkEmbedding).toHaveBeenCalledWith('mine', 'fake-model');
    expect(transcripts.getSermonCentroid).not.toHaveBeenCalled();
  });

  it('404s for unknown sermons and for chunks belonging to another sermon', async () => {
    const { service } = setup();
    await expect(service.findRelated({ sermonId: 'nope', limit: 3 })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(
      service.findRelated({ sermonId: 'src', chunkId: 'foreign', limit: 3 }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('explains itself when nothing is embedded yet, or no provider exists', async () => {
    const empty = await setup({ centroid: null }).service.findRelated({
      sermonId: 'src',
      limit: 3,
    });
    expect(empty.related).toEqual([]);
    expect(empty.warnings[0]).toMatch(/reindex/);

    const none = await setup({ embeddings: unavailableEmbeddings() }).service.findRelated({
      sermonId: 'src',
      limit: 3,
    });
    expect(none.related).toEqual([]);
    expect(none.warnings).toHaveLength(1);
  });
});
