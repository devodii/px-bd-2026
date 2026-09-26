import type { Request, Response } from 'express';
import {
  ingestChunksSchema,
  ingestSermonsSchema,
  reindexSchema,
} from '../schemas/ingestion.schema.js';
import type { IngestionService } from '../services/ingestion/ingestion.service.js';
import type { ReindexService } from '../services/ingestion/reindex.service.js';

export class IngestionController {
  constructor(
    private readonly ingestion: IngestionService,
    private readonly reindex: ReindexService,
  ) {}

  sermons = async (req: Request, res: Response): Promise<void> => {
    const { sermons } = ingestSermonsSchema.parse(req.body);
    res.json(await this.ingestion.ingestSermons(sermons));
  };

  chunks = async (req: Request, res: Response): Promise<void> => {
    const { chunks } = ingestChunksSchema.parse(req.body);
    res.json(await this.ingestion.ingestChunks(chunks));
  };

  /** Reindexing can take a long time, so it runs in the background; poll GET /reindex for progress. */
  startReindex = (req: Request, res: Response): void => {
    res.status(202).json(this.reindex.start(reindexSchema.parse(req.body ?? {})));
  };

  reindexStatus = (_req: Request, res: Response): void => {
    res.json(this.reindex.getStatus());
  };
}
