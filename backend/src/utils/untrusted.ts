/**
 * Transcript text is untrusted: a sermon could literally say "ignore previous instructions".
 * Everything passed to JEV or an LLM goes through here first so it is stripped of control
 * characters and delimiter look-alikes and length-capped. It must only ever be sent as data
 * (structured state / a delimited evidence block), never concatenated into instructions.
 */
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
const DELIMITER_LOOKALIKE = /<\/?\s*(evidence|source|passage|system|assistant|user)[^>]*>/gi;

export function sanitizeUntrusted(text: string, maxChars = 2000): string {
  const cleaned = text
    .replace(CONTROL, ' ')
    .replace(DELIMITER_LOOKALIKE, '')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.length > maxChars ? `${cleaned.slice(0, maxChars)}…` : cleaned;
}
