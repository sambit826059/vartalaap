// SQLite-backed memory. Three virtual tables share one file:
//   messages / conversations — canonical history and summaries
//   fts_chunks (FTS5)          — BM25 keyword search over exchanges
//   vec_chunks (sqlite-vec)    — cosine KNN over embeddings of exchanges
//
// Embedding dimension is fixed at module boot from the embedder. Switching
// providers later requires recreating vec_chunks — a one-line migration we
// accept as the simplicity trade for an in-process DB.

import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type { ConversationRow, StoredMessage } from "./types.ts";
import { getEmbeddingDim } from "./embeddings.ts";

let db: Database.Database | null = null;

export function openDb(path: string): Database.Database {
  if (db) return db;
  mkdirSync(dirname(path), { recursive: true });
  const database = new Database(path);
  database.pragma("journal_mode = WAL");
  database.pragma("foreign_keys = ON");
  sqliteVec.load(database);
  initSchema(database);
  db = database;
  return database;
}

function initSchema(d: Database.Database): void {
  const dim = getEmbeddingDim();

  d.exec(`
    CREATE TABLE IF NOT EXISTS conversations (
      id               TEXT PRIMARY KEY,
      started_at       TEXT NOT NULL,
      last_activity_at TEXT NOT NULL,
      summary          TEXT,
      topics           TEXT
    );

    CREATE TABLE IF NOT EXISTS messages (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id  TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      role             TEXT NOT NULL CHECK (role IN ('user','assistant')),
      content          TEXT NOT NULL,
      created_at       TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, id);
    CREATE INDEX IF NOT EXISTS idx_conv_recent   ON conversations(last_activity_at DESC);

    CREATE VIRTUAL TABLE IF NOT EXISTS fts_chunks USING fts5(
      content,
      conversation_id UNINDEXED,
      created_at      UNINDEXED,
      tokenize='porter unicode61'
    );
  `);

  // vec0 requires an explicit dimension and can't be altered. If an existing
  // table's dim doesn't match the current embedder, drop and warn.
  const existing = d
    .prepare(
      `SELECT sql FROM sqlite_master WHERE type='table' AND name='vec_chunks'`,
    )
    .get() as { sql: string } | undefined;

  if (existing && !existing.sql.includes(`float[${dim}]`)) {
    console.warn(
      `[memory] embedding dimension changed; rebuilding vec_chunks (was: ${existing.sql})`,
    );
    d.exec(`DROP TABLE vec_chunks;`);
  }

  d.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS vec_chunks USING vec0(
      embedding       float[${dim}],
      +chunk_rowid    INTEGER,
      +conversation_id TEXT,
      +content        TEXT,
      +created_at     TEXT
    );
  `);
}

// ---- conversations ----------------------------------------------------------

export function createConversation(): string {
  const d = db!;
  const id = randomUUID();
  const now = new Date().toISOString();
  d.prepare(
    `INSERT INTO conversations (id, started_at, last_activity_at) VALUES (?, ?, ?)`,
  ).run(id, now, now);
  return id;
}

export function touchConversation(id: string): void {
  db!.prepare(`UPDATE conversations SET last_activity_at = ? WHERE id = ?`).run(
    new Date().toISOString(),
    id,
  );
}

export function setConversationSummary(
  id: string,
  summary: string,
  topics: string[],
): void {
  db!
    .prepare(`UPDATE conversations SET summary = ?, topics = ? WHERE id = ?`)
    .run(summary, JSON.stringify(topics), id);
}

export function getConversation(id: string): ConversationRow | null {
  return (
    (db!
      .prepare(`SELECT * FROM conversations WHERE id = ?`)
      .get(id) as ConversationRow | undefined) ?? null
  );
}

export function listRecentConversations(limit = 30): ConversationRow[] {
  return db!
    .prepare(
      `SELECT * FROM conversations
       WHERE summary IS NOT NULL
       ORDER BY last_activity_at DESC
       LIMIT ?`,
    )
    .all(limit) as ConversationRow[];
}

// ---- messages ---------------------------------------------------------------

export function appendMessage(
  conversationId: string,
  role: "user" | "assistant",
  content: string,
): StoredMessage {
  const d = db!;
  const now = new Date().toISOString();
  const info = d
    .prepare(
      `INSERT INTO messages (conversation_id, role, content, created_at)
       VALUES (?, ?, ?, ?)`,
    )
    .run(conversationId, role, content, now);
  touchConversation(conversationId);
  return {
    id: Number(info.lastInsertRowid),
    conversation_id: conversationId,
    role,
    content,
    created_at: now,
  };
}

export function getMessages(conversationId: string): StoredMessage[] {
  return db!
    .prepare(
      `SELECT * FROM messages WHERE conversation_id = ? ORDER BY id ASC`,
    )
    .all(conversationId) as StoredMessage[];
}

// ---- exchange chunks (for retrieval) ----------------------------------------
// Each user/assistant exchange is one chunk. Keeping Q+A together makes
// recall actually useful — matching on just the question misses the answer's
// content and vice versa.

export function indexExchange(args: {
  conversationId: string;
  userText: string;
  assistantText: string;
  createdAt: string;
  embedding: Float32Array | null;
}): void {
  const d = db!;
  const chunk = `USER: ${args.userText}\nASSISTANT: ${args.assistantText}`;

  const ftsInsert = d.prepare(
    `INSERT INTO fts_chunks (content, conversation_id, created_at) VALUES (?, ?, ?)`,
  );
  const ftsInfo = ftsInsert.run(chunk, args.conversationId, args.createdAt);
  // Force BigInt so better-sqlite3 binds this as INTEGER — sqlite-vec's
  // auxiliary-column type check rejects a float-bound integer.
  const rowid = BigInt(ftsInfo.lastInsertRowid);

  if (args.embedding) {
    d.prepare(
      `INSERT INTO vec_chunks (embedding, chunk_rowid, conversation_id, content, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(
      Buffer.from(args.embedding.buffer),
      rowid,
      args.conversationId,
      chunk,
      args.createdAt,
    );
  }
}

// ---- ledger -----------------------------------------------------------------
// Dated one-line-per-conversation summary of history, newest first. Always
// injected into context so recall is deterministic — the model never has to
// decide to look things up.

export function buildLedger(opts?: {
  maxLines?: number;
  fullSummariesFor?: number;
}): string {
  const maxLines = opts?.maxLines ?? 30;
  const fullSummariesFor = opts?.fullSummariesFor ?? 5;
  const convos = listRecentConversations(maxLines);
  if (convos.length === 0) return "(no prior conversations)";

  const lines: string[] = [];
  convos.forEach((c, idx) => {
    const date = formatLedgerDate(c.last_activity_at);
    const summary = c.summary?.trim() ?? "(no summary)";
    if (idx < fullSummariesFor) {
      lines.push(`[${date}] ${summary}`);
    } else {
      // older entries get just topic tags for density
      const topics = c.topics ? (JSON.parse(c.topics) as string[]) : [];
      const topicStr = topics.length ? topics.join(", ") : summary.slice(0, 80);
      lines.push(`[${date}] ${topicStr}`);
    }
  });
  return lines.join("\n");
}

function formatLedgerDate(iso: string): string {
  const d = new Date(iso);
  const day = d.toLocaleDateString("en-US", { weekday: "short" });
  const ymd = d.toISOString().slice(0, 10);
  return `${day} ${ymd}`;
}
