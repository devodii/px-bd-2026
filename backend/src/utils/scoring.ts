/** Reciprocal Rank Fusion constant; 60 is the value from the original paper. */
const RRF_K = 60;

/** `rank` is 1-based. */
export function rrf(rank: number): number {
  return 1 / (RRF_K + rank);
}

export function clamp01(n: number): number {
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0;
}

/** Scales scores so the best one is 1. Returns the input untouched when all are <= 0. */
export function normalizeToMax(scores: number[]): number[] {
  const max = Math.max(0, ...scores);
  return max > 0 ? scores.map((s) => s / max) : scores;
}

/** Cosine distance (pgvector `<=>`, range 0..2) -> similarity in 0..1. */
export function distanceToSimilarity(distance: number): number {
  return clamp01(1 - distance);
}

export function slugify(input: string): string {
  return (
    input
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80) || 'sermon'
  );
}

/** Splits an array into fixed-size batches. */
export function batches<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
