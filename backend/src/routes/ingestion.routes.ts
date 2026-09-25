import express, { Router } from 'express';
import type { IngestionController } from '../controllers/ingestion.controller.js';

/** Mounted behind requireApiKey; ingestion payloads are large, so it gets its own body limit. */
export function ingestionRoutes(c: IngestionController): Router {
  const r = Router();
  r.use(express.json({ limit: '10mb' }));
  r.post('/sermons', c.sermons);
  r.post('/chunks', c.chunks);
  r.post('/reindex', c.startReindex);
  r.get('/reindex', c.reindexStatus);
  return r;
}
