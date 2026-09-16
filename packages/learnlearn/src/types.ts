export type ContentMode = "task" | "wander" | "mixed";
export type CardFormat = "text" | "quiz" | "mixed";
export interface Collection {
  directories: string[];
  include?: string[];
  exclude?: string[];
}
export interface Config {
  enabled: boolean;
  mode: ContentMode;
  format: CardFormat;
  layout: "summary" | "widget" | "overlay";
  usage: "standard" | "economy";
  intervalSeconds: number;
  model?: { provider: string; id: string };
  selectedCollections: string[];
  collections: Record<string, Collection>;
  saveDirectory?: string;
}
export interface Source {
  id: string;
  path: string;
  heading: string;
  line: number;
  text: string;
  collection: string;
}
export interface KnowledgeSource {
  search(query: string, limit?: number): Promise<Source[]>;
  sample(exclude: Set<string>, limit?: number): Promise<Source[]>;
  read(id: string): Promise<Source | undefined>;
}
export interface Option { label: "A" | "B" | "C" | "D"; text: string; explanation: string; verdict?: "suitable" | "conditional" | "unsuitable"; feedback?: string }
export interface Card {
  lesson?: { summary: string; scope: string; example: string; diagram?: string };
  scenario?: { phase: string; goal: string; constraints: string };
  origin?: "builtin";
  id: string;
  title: string;
  body: string;
  kind: "text" | "knowledge" | "judgment";
  options?: Option[];
  correct?: string;
  answer: string;
  sources: Source[];
  createdAt: string;
}
export interface ChatMessage { role: "user" | "assistant"; text: string }
export interface LearningPreferences {
  difficulty: "balanced" | "easier" | "harder";
  avoidTopics: string[];
}
export interface CardReadingState {
  draft: string;
  scroll: number;
  chatScroll: number;
  followReply?: boolean;
  replyStart?: number;
  details: boolean;
  sources: boolean;
}
export interface FavoriteStore {
  save(card: Card, messages: ChatMessage[], directory: string): Promise<string>;
}
