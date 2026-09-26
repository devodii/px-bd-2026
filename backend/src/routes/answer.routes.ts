import { Router } from 'express';
import type { AnswerController } from '../controllers/answer.controller.js';

export function answerRoutes(c: AnswerController): Router {
  const r = Router();
  r.post('/', c.post);
  return r;
}
