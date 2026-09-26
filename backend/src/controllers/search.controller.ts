import type { Request, Response } from 'express';
import { searchBodySchema, searchQuerySchema } from '../schemas/search.schema.js';
import type { SearchService } from '../services/search/search.service.js';

export class SearchController {
  constructor(private readonly search: SearchService) {}

  /** GET /api/search?q=faith+during+difficult+seasons&limit=10 */
  get = async (req: Request, res: Response): Promise<void> => {
    const { q, type, ...rest } = searchQuerySchema.parse(req.query);
    res.json(await this.search.search({ query: q, searchType: type, ...rest }, { log: req.log }));
  };

  /** POST /api/search with structured filters. */
  post = async (req: Request, res: Response): Promise<void> => {
    res.json(await this.search.search(searchBodySchema.parse(req.body), { log: req.log }));
  };
}
