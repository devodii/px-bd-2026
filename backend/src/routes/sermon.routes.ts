import { Router } from 'express';
import type { SermonController } from '../controllers/sermon.controller.js';

export function sermonRoutes(c: SermonController): Router {
  const r = Router();
  r.get('/:id', c.get);
  r.get('/:id/chunks', c.chunks);
  r.get('/:id/related', c.relatedTeachings);
  return r;
}
