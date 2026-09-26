import type { SermonRecord, SermonRepository } from '../../repositories/sermon.repository.js';
import type {
  ChunkListItem,
  TranscriptRepository,
} from '../../repositories/transcript.repository.js';
import { NotFoundError } from '../../utils/errors.js';

export class SermonService {
  constructor(
    private readonly sermons: SermonRepository,
    private readonly transcripts: TranscriptRepository,
  ) {}

  /** `idOrSlug` may be the internal id, the slug or the source system's id. */
  async get(idOrSlug: string): Promise<SermonRecord> {
    const sermon = await this.sermons.find(idOrSlug);
    if (!sermon) throw new NotFoundError('Sermon');
    return sermon;
  }

  async listChunks(
    idOrSlug: string,
    opts: { from?: number | undefined; to?: number | undefined; limit: number; offset: number },
  ): Promise<{
    sermonId: string;
    chunks: (ChunkListItem & { audio: { url: string | null; startTime: number } })[];
    total: number;
  }> {
    const sermon = await this.get(idOrSlug);
    const { chunks, total } = await this.transcripts.listBySermon(sermon.id, opts);
    return {
      sermonId: sermon.id,
      total,
      chunks: chunks.map((c) => ({
        ...c,
        audio: { url: sermon.audioUrl, startTime: c.startTime },
      })),
    };
  }
}
