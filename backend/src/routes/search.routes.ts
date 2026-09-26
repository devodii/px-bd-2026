import { Router } from 'express';
import type { SearchController } from '../controllers/search.controller.js';

export function searchRoutes(c: SearchController): Router {
  const r = Router();
  r.get('/', c.get);
  r.post('/', c.post);
  return r;
}
