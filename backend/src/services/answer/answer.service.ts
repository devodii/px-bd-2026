import { z } from 'zod';
import type { LlmProvider } from '../../providers/llm/llm.provider.js';
import { LlmError } from '../../utils/errors.js';
import type { Logger } from '../../utils/logger.js';
import { buildMessages, type EvidenceChunk } from './answer.prompt.js';

export interface AnswerSource {
  sermonId: string;
  chunkId: string;
  startTime: number;
  endTime: number;
  sermonTitle: string;
}

export interface AnswerResult {
  answer: string;
  /** false when the evidence did not support an answer; `sources` is then empty. */
  answered: boolean;
  sources: AnswerSource[];
}

export const NO_ANSWER = "I couldn't find teaching in the archive that answers this question.";

const modelOutput = z.object({
  answer: z.string(),
  used: z.array(z.string()).optional(),
});

const CITATION = /\[(S\d+)\]/g;

/**
 * Generates an answer strictly from supplied evidence. Independent of search: it is handed chunks
 * and never fetches any. Traceability is enforced in code, not trusted to the model: citations
 * are mapped back to real chunks, unknown refs are stripped, and an answer with no valid citation
 * is discarded.
 */
export class AnswerService {
  constructor(
    private readonly llm: LlmProvider,
    private readonly log?: Logger,
  ) {}

  async answer(query: string, evidence: EvidenceChunk[]): Promise<AnswerResult> {
    if (evidence.length === 0) return { answer: NO_ANSWER, answered: false, sources: [] };

    const { messages, refs } = buildMessages(query, evidence);
    const raw = await this.llm.generate({ messages, json: true, temperature: 0 });
    const parsed = parseModelOutput(raw);

    const cited = new Set<string>();
    for (const m of parsed.answer.matchAll(CITATION)) if (m[1] && refs.has(m[1])) cited.add(m[1]);
    for (const ref of parsed.used ?? []) if (refs.has(ref)) cited.add(ref);

    // Drop refs the model invented; they would point at nothing.
    const answer = parsed.answer
      .replace(CITATION, (whole, ref: string) => (refs.has(ref) ? whole : ''))
      .trim();

    if (!answer || cited.size === 0) {
      this.log?.info(
        { event: 'answer.unsupported', evidence: evidence.length },
        'no supported answer',
      );
      return { answer: NO_ANSWER, answered: false, sources: [] };
    }

    const sources = [...cited]
      .sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)))
      .map((ref) => refs.get(ref) as EvidenceChunk)
      .map((e) => ({
        sermonId: e.sermonId,
        chunkId: e.chunkId,
        startTime: e.startTime,
        endTime: e.endTime,
        sermonTitle: e.sermonTitle,
      }));
    return { answer, answered: true, sources };
  }
}

function parseModelOutput(raw: string): z.infer<typeof modelOutput> {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end <= start) throw new LlmError('LLM returned a malformed answer', true);
  try {
    return modelOutput.parse(JSON.parse(raw.slice(start, end + 1)));
  } catch (err) {
    throw new LlmError('LLM returned a malformed answer', true, { cause: err });
  }
}
