import { createHash } from 'node:crypto';
import { Prisma, type PrismaClient } from '../generated/prisma/client.js';
import type { NormalizedSermon } from '../schemas/transcript.schema.js';
import { slugify } from '../utils/scoring.js';

export interface SermonRecord {
  id: string;
  externalId: string;
  title: string;
  slug: string;
  speaker: string | null;
  date: string | null;
  description: string | null;
  audioUrl: string | null;
  duration: number | null;
  metadata: unknown;
  createdAt: Date;
  updatedAt: Date;
}

export interface SermonRepository {
  /** Creates the sermon, or updates only the fields that are provided. Idempotent on `externalId`. */
  upsert(input: NormalizedSermon): Promise<{ sermon: SermonRecord; created: boolean }>;
  /** Looks up by internal id, slug, or the source system's id. */
  find(idOrSlug: string): Promise<SermonRecord | null>;
}

type SermonRow = NonNullable<Awaited<ReturnType<PrismaClient['sermon']['findUnique']>>>;

function toRecord(row: SermonRow): SermonRecord {
  return {
    id: row.id,
    externalId: row.externalId,
    title: row.title,
    slug: row.slug,
    speaker: row.speaker,
    date: row.date ? row.date.toISOString().slice(0, 10) : null,
    description: row.description,
    audioUrl: row.audioUrl,
    duration: row.duration,
    metadata: row.metadata,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** Deterministic and unique per source id, so re-ingesting never collides or changes a slug. */
export function makeSlug(title: string, externalId: string): string {
  const hash = createHash('sha1').update(externalId).digest('hex').slice(0, 6);
  return `${slugify(title)}-${hash}`;
}

export class PrismaSermonRepository implements SermonRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async upsert(input: NormalizedSermon): Promise<{ sermon: SermonRecord; created: boolean }> {
    // Only provided fields overwrite; later chunk batches without e.g. a speaker must not erase it.
    const fields = {
      title: input.title,
      ...(input.speaker !== undefined && { speaker: input.speaker }),
      ...(input.date !== undefined && { date: new Date(`${input.date}T00:00:00Z`) }),
      ...(input.description !== undefined && { description: input.description }),
      ...(input.audioUrl !== undefined && { audioUrl: input.audioUrl }),
      ...(input.duration !== undefined && { duration: input.duration }),
      ...(input.metadata !== undefined && { metadata: input.metadata as Prisma.InputJsonValue }),
    };

    for (let attempt = 0; ; attempt++) {
      const existing = await this.prisma.sermon.findUnique({
        where: { externalId: input.externalId },
      });
      try {
        if (existing) {
          const row = await this.prisma.sermon.update({ where: { id: existing.id }, data: fields });
          return { sermon: toRecord(row), created: false };
        }
        const row = await this.prisma.sermon.create({
          data: {
            ...fields,
            externalId: input.externalId,
            slug: makeSlug(input.title, input.externalId),
          },
        });
        return { sermon: toRecord(row), created: true };
      } catch (err) {
        // A concurrent ingest created it between our read and write: retry as an update.
        const raceLost =
          err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
        if (!raceLost || attempt >= 1) throw err;
      }
    }
  }

  async find(idOrSlug: string): Promise<SermonRecord | null> {
    const row = await this.prisma.sermon.findFirst({
      where: { OR: [{ id: idOrSlug }, { slug: idOrSlug }, { externalId: idOrSlug }] },
    });
    return row ? toRecord(row) : null;
  }
}
