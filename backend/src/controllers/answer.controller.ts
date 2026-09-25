import type { Request, Response } from 'express';
import { answerBodySchema } from '../schemas/answer.schema.js';
import type { AskService } from '../services/answer/ask.service.js';

export class AnswerController {
  constructor(private readonly ask: AskService) {}

  post = async (req: Request, res: Response): Promise<void> => {
    res.json(await this.ask.ask(answerBodySchema.parse(req.body), req.log));
  };
}
