import { Router } from 'express';
import type { HealthController } from '../controllers/health.controller.js';

export function healthRoutes(c: HealthController): Router {
  const r = Router();
  r.get('/', c.get);
  return r;
}
