import type { JevProvider } from '../../providers/jev/jev.provider.js';
import type { SearchIntent } from '../../types/index.js';
import { ValidationError } from '../../utils/errors.js';
import type { Logger } from '../../utils/logger.js';
import { clamp01 } from '../../utils/scoring.js';
import type { HybridSearchService } from './hybrid-search.service.js';
import type { IntentClassifier } from './intent-classifier.js';
import type {
  Candidate,
  SearchConfig,
  SearchParams,
  SearchResponse,
  SearchResultItem,
  SearchWarning,
} from './search.types.js';

/** JEV's judgment counts for most of the final score; retrieval keeps a say as a tie-breaker. */
const JEV_WEIGHT = 0.75;
/** Stand-in for a candidate JEV could not judge: neither promoted nor buried relative to judged ones. */
const NEUTRAL_JEV = 0.5;

const round = (n: number): number => Math.round(n * 1000) / 1000;

export interface SearchContext {
  log?: Logger;
}

/**
 * Orchestrates one search: intent + retrieval (parallel) -> merge -> JEV judgment -> final ranking.
 * JEV is strictly an enhancement: any JEV failure leaves the retrieval ranking in place.
 */
export class SearchService {
  constructor(
    private readonly retrieval: HybridSearchService,
    private readonly intents: IntentClassifier,
    private readonly jev: JevProvider,
    private readonly config: SearchConfig,
    private readonly maxQueryLength: number,
  ) {}

  async search(params: SearchParams, ctx: SearchContext = {}): Promise<SearchResponse> {
    const started = Date.now();
    const log = ctx.log;

    const query = params.query.replace(/\s+/g, ' ').trim();
    if (!query) throw new ValidationError('Query must not be empty');
    if (query.length > this.maxQueryLength) {
      throw new ValidationError(`Query must be at most ${this.maxQueryLength} characters`);
    }

    const limit = Math.min(params.limit ?? this.config.finalLimit, 50);
    const requested = params.searchType ?? 'hybrid';
    const filters = {
      sermonId: params.sermonId,
      speaker: params.speaker,
      dateFrom: params.dateFrom,
      dateTo: params.dateTo,
    };

    // Intent only influences how lists are weighted when merging, so it runs alongside retrieval.
    const [intent, retrieved] = await Promise.all([
      this.intents.classify(query, log),
      this.retrieval.retrieve(query, filters, requested, log),
    ]);

    const candidates = this.retrieval.merge(retrieved, intent.intent);
    const warnings: SearchWarning[] = [...retrieved.warnings];

    const jevOutcome = await this.applyJev(query, intent.intent, candidates, warnings, log);
    const ranked = this.rank(candidates, jevOutcome.applied);
    const results = ranked.slice(0, limit).map((c) => toResult(c));

    log?.info(
      {
        event: 'search',
        query,
        searchType: retrieved.effectiveType,
        intent: intent.intent,
        intentSource: intent.source,
        vectorCandidates: retrieved.semantic.length,
        keywordCandidates: retrieved.keyword.length,
        mergedCandidates: candidates.length,
        jev: jevOutcome.status,
        jevLatencyMs: jevOutcome.latencyMs,
        jevFailures: jevOutcome.failures,
        results: results.length,
        durationMs: Date.now() - started,
      },
      'search completed',
    );

    return {
      query,
      results,
      meta: {
        total: results.length,
        searchType: retrieved.effectiveType,
        intent: intent.intent,
        jev: jevOutcome.status,
        warnings,
      },
    };
  }

  private async applyJev(
    query: string,
    intent: SearchIntent,
    candidates: Candidate[],
    warnings: SearchWarning[],
    log?: Logger,
  ): Promise<{
    status: 'applied' | 'skipped' | 'failed';
    applied: boolean;
    latencyMs?: number;
    failures: number;
  }> {
    if (candidates.length === 0 || !this.jev.isConfigured()) {
      return { status: 'skipped', applied: false, failures: 0 };
    }
    const started = Date.now();
    try {
      // Bounded: `candidates` is already capped at mergeLimit by the merge step.
      const result = await this.jev.evaluateRelevance({
        query,
        intent,
        candidates: candidates.map((c) => ({
          id: c.chunk.chunkId,
          text: c.chunk.text,
          sermonTitle: c.chunk.sermon.title,
        })),
      });
      const byId = new Map(result.scores.map((s) => [s.id, s.relevance]));
      for (const c of candidates) {
        const score = byId.get(c.chunk.chunkId);
        if (score !== undefined) c.jevScore = clamp01(score);
      }
      return {
        status: 'applied',
        applied: true,
        latencyMs: result.latencyMs,
        failures: result.failed,
      };
    } catch (err) {
      // JEV is not a single point of failure: keep the retrieval order.
      log?.warn(
        {
          err: err instanceof Error ? err.message : String(err),
          jevLatencyMs: Date.now() - started,
        },
        'jev evaluation failed; using retrieval ranking',
      );
      warnings.push({
        code: 'JEV_UNAVAILABLE',
        message: 'Relevance judging is unavailable; results use retrieval ranking',
      });
      return {
        status: 'failed',
        applied: false,
        latencyMs: Date.now() - started,
        failures: candidates.length,
      };
    }
  }

  /** Blends JEV with retrieval, drops what JEV judged irrelevant, and sorts best-first. */
  private rank(
    candidates: Candidate[],
    jevApplied: boolean,
  ): (Candidate & { finalScore: number })[] {
    const scored = candidates.map((c) => ({
      ...c,
      finalScore: jevApplied
        ? JEV_WEIGHT * (c.jevScore ?? NEUTRAL_JEV) + (1 - JEV_WEIGHT) * c.fusionScore
        : c.fusionScore,
    }));
    const kept = jevApplied
      ? scored.filter((c) => c.jevScore === undefined || c.jevScore >= this.config.minRelevance)
      : scored;
    return kept.sort((a, b) => b.finalScore - a.finalScore);
  }
}

function toResult(c: Candidate & { finalScore: number }): SearchResultItem {
  const { chunk } = c;
  return {
    sermon: {
      id: chunk.sermon.id,
      title: chunk.sermon.title,
      date: chunk.sermon.date,
      speaker: chunk.sermon.speaker,
    },
    chunk: {
      id: chunk.chunkId,
      startTime: chunk.startTime,
      endTime: chunk.endTime,
      text: chunk.text,
    },
    relevance: {
      score: round(clamp01(c.finalScore)),
      source: c.jevScore !== undefined ? 'jev' : 'retrieval',
    },
    audio: { url: chunk.sermon.audioUrl, startTime: chunk.startTime },
  };
}
