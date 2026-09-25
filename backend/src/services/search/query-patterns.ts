/** Matches things like "Romans 8:28", "1 Corinthians 13:4-7", "John 3:16". */
const BIBLE_REFERENCE =
  /\b(?:[1-3]\s?)?[A-Za-z]{2,}\.?\s+\d{1,3}\s*:\s*\d{1,3}(?:\s*[-–]\s*\d{1,3})?\b/;

export function looksLikeBibleReference(query: string): boolean {
  return BIBLE_REFERENCE.test(query);
}

const QUESTION_START = /^(?:what|why|how|when|where|who|does|do|did|is|are|can|should|could)\b/i;

export function looksLikeQuestion(query: string): boolean {
  const q = query.trim();
  return q.endsWith('?') || QUESTION_START.test(q);
}
