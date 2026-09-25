import type { AnswerRequest } from '../../schemas/answer.schema.js';
import type { Logger } from '../../utils/logger.js';
import type { SearchService } from '../search/search.service.js';
import type { AnswerResult, AnswerService } from './answer.service.js';
import type { EvidenceChunk } from './answer.prompt.js';

export interface AskResponse extends AnswerResult {
  query: string;
  meta: { evidence: number; searchType: string };
}

/**
 * The only place search and answering meet: retrieve evidence, then hand it to AnswerService.
 * AnswerService itself never imports or calls search.
 */
export class AskService {
  constructor(
    private readonly search: SearchService,
    private readonly answers: AnswerService,
  ) {}

  async ask(req: AnswerRequest, log?: Logger): Promise<AskResponse> {
    const found = await this.search.search(
      {
        query: req.query,
        limit: req.evidenceLimit,
        sermonId: req.sermonId,
        speaker: req.speaker,
        dateFrom: req.dateFrom,
        dateTo: req.dateTo,
      },
      { log },
    );
    const evidence: EvidenceChunk[] = found.results.map((r) => ({
      sermonId: r.sermon.id,
      sermonTitle: r.sermon.title,
      sermonDate: r.sermon.date,
      speaker: r.sermon.speaker,
      chunkId: r.chunk.id,
      startTime: r.chunk.startTime,
      endTime: r.chunk.endTime,
      text: r.chunk.text,
    }));
    const result = await this.answers.answer(found.query, evidence);
    return {
      query: found.query,
      ...result,
      meta: { evidence: evidence.length, searchType: found.meta.searchType },
    };
  }
}
