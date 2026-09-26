/**
 * Ingest existing transcript chunks.
 *
 *   npm run ingest -- path/to/chunks.json            JSON array, {"chunks": [...]}, or JSONL
 *   npm run ingest -- --sermons path/to/sermons.json  sermon records only
 *   npm run ingest -- --from-pipeline                 read finished chunks straight from the Python
 *                                                     pipeline's Postgres (PIPELINE_DATABASE_URL)
 *
 * Idempotent: running it again updates what changed and skips the rest.
 */
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { env } from '../src/config/env.js';
import { createContainer } from '../src/container.js';
import { batches } from '../src/utils/scoring.js';
import { logger } from '../src/utils/logger.js';

const BATCH = 200;

async function readRows(path: string): Promise<unknown[]> {
  const text = (await readFile(path, 'utf8')).trim();
  if (text.startsWith('[')) return JSON.parse(text) as unknown[];
  if (text.startsWith('{') && !text.includes('\n{')) {
    const obj = JSON.parse(text) as { chunks?: unknown[]; sermons?: unknown[] };
    return obj.chunks ?? obj.sermons ?? [obj];
  }
  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as unknown); // JSONL
}

/**
 * Rows from the Python pipeline (`chunks` joined to `sermons`). Field names match the
 * normalizer's aliases, so no mapping logic lives here beyond building stable ids.
 */
async function readPipeline(): Promise<unknown[]> {
  const url = process.env.PIPELINE_DATABASE_URL ?? 'postgresql://px:px@localhost:54329/px';
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    const { rows } = await client.query(`
      SELECT c.sermon_id, c.idx, c.start_sec, c.duration_sec, c.text,
             s.file_name, s.caption, s.posted_at, s.duration_sec AS sermon_duration_sec
      FROM chunks c JOIN sermons s ON s.id = c.sermon_id
      WHERE c.status = 'done' AND c.text IS NOT NULL AND btrim(c.text) <> ''
      ORDER BY c.sermon_id, c.idx`);
    return rows.map((r) => ({
      sermonId: `pipeline:${r.sermon_id}`,
      chunkId: `pipeline:${r.sermon_id}:${r.idx}`,
      chunkIndex: r.idx,
      start_sec: r.start_sec,
      duration_sec: r.duration_sec,
      text: r.text,
      file_name: r.file_name,
      caption: r.caption,
      posted_at: r.posted_at,
      sermon_duration_sec: r.sermon_duration_sec,
    }));
  } finally {
    await client.end();
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const sermonsOnly = args.includes('--sermons');
  const fromPipeline = args.includes('--from-pipeline');
  const path = args.find((a) => !a.startsWith('--'));
  if (!fromPipeline && !path) {
    console.error('Usage: npm run ingest -- <file.json|file.jsonl> [--sermons] | --from-pipeline');
    process.exit(1);
  }

  const container = createContainer(env, logger);
  try {
    const rows = fromPipeline ? await readPipeline() : await readRows(path as string);
    logger.info({ rows: rows.length }, 'ingesting');

    const totals = { created: 0, updated: 0, unchanged: 0, rejected: 0, embeddingsGenerated: 0 };
    let embeddingStatus = 'not-needed';
    for (const [i, batch] of batches(rows, BATCH).entries()) {
      if (sermonsOnly) {
        const r = await container.services.ingestion.ingestSermons(batch);
        totals.created += r.created;
        totals.updated += r.updated;
        totals.rejected += r.rejected.length;
      } else {
        const r = await container.services.ingestion.ingestChunks(batch);
        totals.created += r.chunks.created;
        totals.updated += r.chunks.updated;
        totals.unchanged += r.chunks.unchanged;
        totals.rejected += r.rejected.length;
        totals.embeddingsGenerated += r.embeddings.generated;
        embeddingStatus = r.embeddings.status;
        for (const bad of r.rejected) logger.warn({ batch: i, ...bad }, 'rejected row');
      }
      logger.info({ batch: i + 1, of: Math.ceil(rows.length / BATCH) }, 'batch done');
    }
    console.log(JSON.stringify({ ...totals, embeddingStatus }, null, 2));
  } finally {
    await container.close();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
