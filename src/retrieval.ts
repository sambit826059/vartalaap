// Hybrid recall over conversation history.
//
// Two queries run in parallel over SQLite virtual tables:
//   - vec0 cosine KNN (semantic)
//   - FTS5 BM25        (lexical — catches exact names / SKUs / errors)
//
// Results are merged with reciprocal rank fusion. A light recency boost nudges
// fresh memories ahead of older ones at similar relevance. RRF beats any
// single modality on retrieval benchmarks and is ~30 lines.

import type Database from "better-sqlite3";
import type { RecallHit } from "./types.ts";
import { embed } from "./embeddings.ts";

const RRF_K = 60; // standard RRF constant
const RECENCY_HALF_LIFE_DAYS = 14;

export interface RecallOptions {
  topK?: number;
  topKPerModality?: number;
  minScore?: number;
}

export async function recall(
  db: Database.Database,
  query: string,
  opts: RecallOptions = {},
): Promise<RecallHit[]> {
  const topK = opts.topK ?? 6;
  const perModality = opts.topKPerModality ?? 10;
  const minScore = opts.minScore ?? 0;

  const [vecHits, ftsHits] = await Promise.all([
    vecSearch(db, query, perModality).catch((e) => {
      console.warn("[recall] vec search failed:", (e as Error).message);
      return [] as RawHit[];
    }),
    Promise.resolve(ftsSearch(db, query, perModality)),
  ]);

  // RRF: score(doc) = sum over modalities of 1 / (k + rank)
  const merged = new Map<
    string,
    { hit: RawHit; score: number; sources: Set<"vec" | "fts"> }
  >();

  const addRanked = (hits: RawHit[], source: "vec" | "fts") => {
    hits.forEach((h, idx) => {
      const key = `${h.conversation_id}:${h.content.slice(0, 40)}`;
      const rrf = 1 / (RRF_K + idx + 1);
      const existing = merged.get(key);
      if (existing) {
        existing.score += rrf;
        existing.sources.add(source);
      } else {
        merged.set(key, {
          hit: h,
          score: rrf,
          sources: new Set([source]),
        });
      }
    });
  };
  addRanked(vecHits, "vec");
  addRanked(ftsHits, "fts");

  const now = Date.now();
  const scored: RecallHit[] = Array.from(merged.values())
    .map(({ hit, score, sources }) => {
      const ageDays = Math.max(
        0,
        (now - new Date(hit.created_at).getTime()) / 86_400_000,
      );
      const recencyBoost = Math.pow(0.5, ageDays / RECENCY_HALF_LIFE_DAYS);
      return {
        conversation_id: hit.conversation_id,
        content: hit.content,
        created_at: hit.created_at,
        score: score * (0.7 + 0.3 * recencyBoost),
        source:
          sources.size === 2 ? "both" : sources.has("vec") ? "vec" : "fts",
      } satisfies RecallHit;
    })
    .filter((h) => h.score >= minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);

  return scored;
}

// ---- vec ------------------------------------------------------------------

interface RawHit {
  conversation_id: string;
  content: string;
  created_at: string;
}

async function vecSearch(
  db: Database.Database,
  query: string,
  k: number,
): Promise<RawHit[]> {
  const [embedding] = await embed([query]);
  if (!embedding) return [];
  // vec0 MATCH with k=? returns up to k rows ordered by distance ascending
  const rows = db
    .prepare(
      `SELECT conversation_id, content, created_at
       FROM vec_chunks
       WHERE embedding MATCH ?
         AND k = ?
       ORDER BY distance`,
    )
    .all(Buffer.from(embedding.buffer), k) as RawHit[];
  return rows;
}

// ---- FTS5 -----------------------------------------------------------------

function ftsSearch(
  db: Database.Database,
  query: string,
  k: number,
): RawHit[] {
  const fts = toFtsQuery(query);
  if (!fts) return [];
  try {
    return db
      .prepare(
        `SELECT conversation_id, content, created_at
         FROM fts_chunks
         WHERE fts_chunks MATCH ?
         ORDER BY bm25(fts_chunks)
         LIMIT ?`,
      )
      .all(fts, k) as RawHit[];
  } catch (e) {
    // Malformed FTS query — skip rather than crash the whole recall
    console.warn("[recall] fts query rejected:", (e as Error).message);
    return [];
  }
}

// Strip FTS5 operators and quote each remaining token. Prevents the user's
// message from being interpreted as a boolean query — a tiny injection
// surface we don't need open.
function toFtsQuery(input: string): string {
  const tokens = input
    .replace(/["()*:^-]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 2 && t.length <= 40)
    .slice(0, 12);
  if (tokens.length === 0) return "";
  // OR-join with FTS5 prefix wildcards so partial words match
  return tokens.map((t) => `"${t}"*`).join(" OR ");
}

// ---- rendering ------------------------------------------------------------

export function renderRecall(hits: RecallHit[]): string {
  if (hits.length === 0) return "(no related past exchanges)";
  return hits
    .map((h) => {
      const date = h.created_at.slice(0, 10);
      // Cap each excerpt — keeps the injection even if one exchange is huge
      const trimmed =
        h.content.length > 800 ? h.content.slice(0, 800) + "…" : h.content;
      return `--- [${date}] (score ${h.score.toFixed(3)}, via ${h.source}) ---\n${trimmed}`;
    })
    .join("\n\n");
}
