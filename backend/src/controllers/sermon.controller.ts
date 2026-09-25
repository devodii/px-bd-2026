import type { Request, Response } from 'express';
import {
  chunksQuerySchema,
  relatedQuerySchema,
  sermonParamsSchema,
} from '../schemas/sermon.schema.js';
import type { RelatedTeachingService } from '../services/related/related-teaching.service.js';
import type { SermonService } from '../services/sermons/sermon.service.js';

export class SermonController {
  constructor(
    private readonly sermons: SermonService,
    private readonly related: RelatedTeachingService,
  ) {}

  get = async (req: Request, res: Response): Promise<void> => {
    const { id } = sermonParamsSchema.parse(req.params);
    res.json({ sermon: await this.sermons.get(id) });
  };

  chunks = async (req: Request, res: Response): Promise<void> => {
    const { id } = sermonParamsSchema.parse(req.params);
    res.json(await this.sermons.listChunks(id, chunksQuerySchema.parse(req.query)));
  };

  relatedTeachings = async (req: Request, res: Response): Promise<void> => {
    const { id } = sermonParamsSchema.parse(req.params);
    const { chunkId, limit } = relatedQuerySchema.parse(req.query);
    res.json(await this.related.findRelated({ sermonId: id, chunkId, limit }));
  };
}
