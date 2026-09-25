export type SearchIntent =
  | 'TOPIC_SEARCH'
  | 'TEACHING_QUESTION'
  | 'BIBLE_REFERENCE'
  | 'SERMON_LOOKUP'
  | 'PERSON_LOOKUP'
  | 'GENERAL_SEARCH';

export const SEARCH_INTENTS = [
  'TOPIC_SEARCH',
  'TEACHING_QUESTION',
  'BIBLE_REFERENCE',
  'SERMON_LOOKUP',
  'PERSON_LOOKUP',
  'GENERAL_SEARCH',
] as const satisfies readonly SearchIntent[];

export type SearchType = 'semantic' | 'keyword' | 'hybrid';

export interface SermonSummary {
  id: string;
  title: string;
  date: string | null;
  speaker: string | null;
}

/** A chunk joined with its sermon: the unit every search stage passes around. */
export interface ChunkRecord {
  chunkId: string;
  sermonId: string;
  chunkIndex: number;
  startTime: number;
  endTime: number;
  text: string;
  sermon: SermonSummary & { audioUrl: string | null };
}
