import type { EmbeddingProvider } from '../../providers/embeddings/embedding.provider.js';
import type { SearchRepository } from '../../repositories/search.repository.js';
import type { SermonRepository } from '../../repositories/sermon.repository.js';
import type { TranscriptRepository } from '../../repositories/transcript.repository.js';
import type { SermonSummary } from '../../types/index.js';
import { NotFoundError } from '../../utils/errors.js';

export interface RelatedTeaching {
  sermon: SermonSummary;
  /** Best chunk similarity for this sermon, 0..1. */
  similarity: number;
  /** The most similar passages in that sermon, best first. */
  chunks: { id: string; startTime: number; endTime: number; text: string; similarity: number }[];
  audio: { url: string | null; startTime: number };
}

export interface RelatedResponse {
  sermonId: string;
  basis: 'chunk' | 'sermon';
  related: RelatedTeaching[];
  warnings: string[];
}

const CHUNKS_PER_SERMON = 3;
/** Over-fetch chunks so that, after grouping, enough distinct sermons remain. */
const OVERFETCH = 8;

/**
 * Finds teachings similar to a sermon (its mean chunk vector) or to one chunk, using vectors that
 * are already stored: no embedding API call is needed. Results are grouped per sermon and never
 * include the source sermon itself.
 */
export class RelatedTeachingService {
  constructor(
    private readonly sermons: SermonRepository,
    private readonly transcripts: TranscriptRepository,
    private readonly search: SearchRepository,
    private readonly embeddings: EmbeddingProvider,
    private readonly dimensions: number | null,
  ) {}

  async findRelated(params: {
    sermonId: string;
    chunkId?: string | undefined;
    limit: number;
  }): Promise<RelatedResponse> {
    const sermon = await this.sermons.find(params.sermonId);
    if (!sermon) throw new NotFoundError('Sermon');

    const basis = params.chunkId ? 'chunk' : 'sermon';
    const base: RelatedResponse = { sermonId: sermon.id, basis, related: [], warnings: [] };

    const model = this.embeddings.model;
    if (!model) {
      return {
        ...base,
        warnings: ['No embedding provider is configured, so related teachings are unavailable'],
      };
    }

    let vector: number[] | null;
    if (params.chunkId) {
      const chunk = await this.transcripts.getChunk(params.chunkId);
      if (!chunk || chunk.sermonId !== sermon.id) throw new NotFoundError('Chunk');
      vector = await this.transcripts.getChunkEmbedding(chunk.chunkId, model);
    } else {
      vector = await this.transcripts.getSermonCentroid(sermon.id, model);
    }
    if (!vector) return { ...base, warnings: ['This sermon has no embeddings yet; run reindex'] };

    const hits = await this.search.vectorSearch({
      vector,
      model,
      dimensions: this.dimensions ?? this.embeddings.dimensions,
      limit: params.limit * OVERFETCH,
      excludeSermonId: sermon.id,
    });

    const bySermon = new Map<string, RelatedTeaching>();
    for (const { chunk, score } of hits) {
      // hits arrive best-first, so the first chunk seen for a sermon is its best.
      const entry = bySermon.get(chunk.sermonId) ?? {
        sermon: {
          id: chunk.sermon.id,
          title: chunk.sermon.title,
          date: chunk.sermon.date,
          speaker: chunk.sermon.speaker,
        },
        similarity: score,
        chunks: [],
        audio: { url: chunk.sermon.audioUrl, startTime: chunk.startTime },
      };
      if (entry.chunks.length < CHUNKS_PER_SERMON) {
        entry.chunks.push({
          id: chunk.chunkId,
          startTime: chunk.startTime,
          endTime: chunk.endTime,
          text: chunk.text,
          similarity: score,
        });
      }
      bySermon.set(chunk.sermonId, entry);
    }

    const related = [...bySermon.values()]
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, params.limit);
    return { ...base, related };
  }
}
