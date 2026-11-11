// Shared types. Kept narrow on purpose — the SDK's own types cover the rest.

export interface StoredMessage {
  id: number;
  conversation_id: string;
  role: "user" | "assistant";
  content: string;
  created_at: string; // ISO 8601
}

export interface ConversationRow {
  id: string;
  started_at: string;
  last_activity_at: string;
  summary: string | null;
  topics: string | null; // JSON array string
}

export interface RecallHit {
  conversation_id: string;
  content: string;
  created_at: string;
  score: number;
  source: "vec" | "fts" | "both";
}

export interface SearchResult {
  title: string;
  url: string;
  content: string; // truncated
  published_date?: string;
}

export interface CitationSource {
  id: number; // 1-indexed display id
  url: string;
  title: string;
}
