import { Prisma } from './generated/prisma/client.js';
import type { Env } from './config/env.js';
import { createPrismaClient } from './db/prisma.js';
import { createEmbeddingProvider } from './providers/embeddings/embedding.client.js';
import type { EmbeddingProvider } from './providers/embeddings/embedding.provider.js';
import { createJevProvider } from './providers/jev/jev.client.js';
import type { JevProvider } from './providers/jev/jev.provider.js';
import { createLlmProvider } from './providers/llm/llm.client.js';
import type { LlmProvider } from './providers/llm/llm.provider.js';
import { PrismaSearchRepository, type SearchRepository } from './repositories/search.repository.js';
import { PrismaSermonRepository, type SermonRepository } from './repositories/sermon.repository.js';
import {
  PrismaTranscriptRepository,
  type TranscriptRepository,
} from './repositories/transcript.repository.js';
import { AnswerService } from './services/answer/answer.service.js';
import { AskService } from './services/answer/ask.service.js';
import { IngestionService } from './services/ingestion/ingestion.service.js';
import { ReindexService } from './services/ingestion/reindex.service.js';
import { RelatedTeachingService } from './services/related/related-teaching.service.js';
import { HybridSearchService } from './services/search/hybrid-search.service.js';
import { DefaultIntentClassifier } from './services/search/intent-classifier.js';
import { KeywordSearchService } from './services/search/keyword-search.service.js';
import { SearchService } from './services/search/search.service.js';
import { SemanticSearchService } from './services/search/semantic-search.service.js';
import { SermonService } from './services/sermons/sermon.service.js';
import { logger, type Logger } from './utils/logger.js';

export interface Container {
  providers: { embeddings: EmbeddingProvider; jev: JevProvider; llm: LlmProvider };
  repositories: {
    sermons: SermonRepository;
    transcripts: TranscriptRepository;
    search: SearchRepository;
  };
  services: {
    search: SearchService;
    sermons: SermonService;
    related: RelatedTeachingService;
    ingestion: IngestionService;
    reindex: ReindexService;
    answer: AnswerService;
    ask: AskService;
  };
  checkDatabase: () => Promise<boolean>;
  close: () => Promise<void>;
}

/**
 * The composition root: the only place concrete classes are chosen and wired together.
 * Swapping the embedding provider, JEV or the LLM means changing one factory, not the services.
 */
export function createContainer(env: Env, log: Logger = logger): Container {
  const prisma = createPrismaClient(env.DATABASE_URL);

  const embeddings = createEmbeddingProvider(env);
  const jev = createJevProvider(env);
  const llm = createLlmProvider(env);

  const sermons = new PrismaSermonRepository(prisma);
  const transcripts = new PrismaTranscriptRepository(prisma);
  const search = new PrismaSearchRepository(prisma);

  const config = {
    vectorLimit: env.SEARCH_VECTOR_LIMIT,
    keywordLimit: env.SEARCH_KEYWORD_LIMIT,
    mergeLimit: env.SEARCH_MERGE_LIMIT,
    finalLimit: env.SEARCH_FINAL_LIMIT,
    minRelevance: env.SEARCH_MIN_RELEVANCE,
  };

  const semantic = new SemanticSearchService(embeddings, search, env.EMBEDDING_DIMENSIONS ?? null);
  const hybrid = new HybridSearchService(semantic, new KeywordSearchService(search), config);
  const searchService = new SearchService(
    hybrid,
    new DefaultIntentClassifier(jev, env.JEV_TIMEOUT_MS),
    jev,
    config,
    env.MAX_QUERY_LENGTH,
  );
  const answer = new AnswerService(llm, log);

  return {
    providers: { embeddings, jev, llm },
    repositories: { sermons, transcripts, search },
    services: {
      search: searchService,
      sermons: new SermonService(sermons, transcripts),
      related: new RelatedTeachingService(
        sermons,
        transcripts,
        search,
        embeddings,
        env.EMBEDDING_DIMENSIONS ?? null,
      ),
      ingestion: new IngestionService(
        sermons,
        transcripts,
        embeddings,
        env.EMBEDDING_BATCH_SIZE,
        log,
      ),
      reindex: new ReindexService(transcripts, embeddings, env.EMBEDDING_BATCH_SIZE, log),
      answer,
      ask: new AskService(searchService, answer),
    },
    checkDatabase: async () => {
      await prisma.$queryRaw(Prisma.sql`SELECT 1`);
      return true;
    },
    close: () => prisma.$disconnect(),
  };
}
