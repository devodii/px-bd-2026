import type { Request, Response } from 'express';

export interface HealthDeps {
  checkDatabase: () => Promise<boolean>;
  providers: {
    embeddings: { name: string; isConfigured: () => boolean };
    jev: { name: string; isConfigured: () => boolean };
    llm: { name: string; isConfigured: () => boolean };
  };
}

/** Reports what is configured, never the values of any key. */
export class HealthController {
  constructor(private readonly deps: HealthDeps) {}

  get = async (_req: Request, res: Response): Promise<void> => {
    const database = await this.deps.checkDatabase().catch(() => false);
    const { embeddings, jev, llm } = this.deps.providers;
    res.status(database ? 200 : 503).json({
      status: database ? 'ok' : 'degraded',
      database: database ? 'up' : 'down',
      providers: {
        embeddings: { name: embeddings.name, configured: embeddings.isConfigured() },
        jev: { name: jev.name, configured: jev.isConfigured() },
        llm: { name: llm.name, configured: llm.isConfigured() },
      },
    });
  };
}
