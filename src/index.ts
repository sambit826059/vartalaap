// Hono server: SSE chat endpoint, security middleware, static UI.
//
// Request lifecycle:
//   1. Validate body (zod) + rate-limit by IP
//   2. Resolve conversation (create if new)
//   3. Build deterministic context: ledger + hybrid recall + clock
//   4. Stream the agent loop over SSE
//   5. Persist the assistant turn; async kick off embed + summary refresh
//      (never blocks the response)

import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import Anthropic from "@anthropic-ai/sdk";
import type { MessageParam } from "@anthropic-ai/sdk/resources/messages.mjs";
import { Hono } from "hono";
import { secureHeaders } from "hono/secure-headers";
import { streamSSE } from "hono/streaming";
import { z } from "zod";

import { runAgent, extractAssistantText } from "./agent.ts";
import {
  appendMessage,
  buildLedger,
  createConversation,
  getConversation,
  getMessages,
  openDb,
} from "./memory.ts";
import { recall, renderRecall } from "./retrieval.ts";
import { buildContextBlock, buildSystemPrompt } from "./prompt.ts";
import { indexAndSummarize } from "./summarize.ts";
import { getEmbeddingBackend } from "./embeddings.ts";

// ---- config ----------------------------------------------------------------

const PORT = Number(process.env.PORT ?? 3000);
const DB_PATH = process.env.DATABASE_PATH ?? "./data/chat.db";
const MAX_MESSAGE_CHARS = 8_000;
const MAX_HISTORY_MESSAGES = 50;
const RATE_LIMIT_PER_MINUTE = 20;

// ---- boot ------------------------------------------------------------------

if (!process.env.ANTHROPIC_API_KEY) {
  console.error("Missing ANTHROPIC_API_KEY");
  process.exit(1);
}
if (!process.env.TAVILY_API_KEY) {
  console.error("Missing TAVILY_API_KEY");
  process.exit(1);
}

const anthropic = new Anthropic();
const db = openDb(DB_PATH);
console.log(
  `[boot] embeddings backend: ${getEmbeddingBackend()}; db: ${DB_PATH}`,
);

// ---- rate limiting ---------------------------------------------------------
// Dead-simple in-memory token bucket. Fine for a single-process single-user
// demo. Production would move this to Redis / durable storage.

const buckets = new Map<string, { tokens: number; resetAt: number }>();
function takeToken(ip: string): boolean {
  const now = Date.now();
  const b = buckets.get(ip);
  if (!b || b.resetAt < now) {
    buckets.set(ip, { tokens: RATE_LIMIT_PER_MINUTE - 1, resetAt: now + 60_000 });
    return true;
  }
  if (b.tokens <= 0) return false;
  b.tokens--;
  return true;
}

// ---- schema ---------------------------------------------------------------

const ChatBody = z.object({
  conversationId: z.string().uuid().optional(),
  message: z.string().min(1).max(MAX_MESSAGE_CHARS),
});

// ---- app ------------------------------------------------------------------

const app = new Hono();

app.use(
  "*",
  secureHeaders({
    contentSecurityPolicy: {
      // The browser is the last line of defense against markdown exfiltration.
      // No remote image loads, no remote script loads, no outbound fetches.
      // The one thing we DO allow: inline styles for the UI.
      defaultSrc: ["'self'"],
      imgSrc: ["'self'", "data:"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      connectSrc: ["'self'"],
      fontSrc: ["'self'"],
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
    },
    referrerPolicy: "no-referrer",
    xFrameOptions: "DENY",
  }),
);

// ---- static UI ------------------------------------------------------------

app.use("/*", serveStatic({ root: "./public" }));

// ---- health ---------------------------------------------------------------

app.get("/api/health", (c) =>
  c.json({ ok: true, embeddings: getEmbeddingBackend() }),
);

// ---- conversation list / detail ------------------------------------------

app.get("/api/conversations", (c) => {
  const rows = db
    .prepare(
      `SELECT id, started_at, last_activity_at, summary, topics
       FROM conversations
       ORDER BY last_activity_at DESC
       LIMIT 50`,
    )
    .all();
  return c.json(rows);
});

app.get("/api/conversations/:id", (c) => {
  const id = c.req.param("id");
  const parsed = z.string().uuid().safeParse(id);
  if (!parsed.success) return c.json({ error: "bad id" }, 400);
  const conv = getConversation(id);
  if (!conv) return c.json({ error: "not found" }, 404);
  const messages = getMessages(id);
  return c.json({ conversation: conv, messages });
});

// ---- chat (SSE) ----------------------------------------------------------

app.post("/api/chat", async (c) => {
  // Rate limit by IP (header set by reverse proxy if present)
  const ip =
    c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ||
    c.req.header("x-real-ip") ||
    "local";
  if (!takeToken(ip)) {
    return c.json({ error: "rate limited" }, 429);
  }

  const raw = await c.req.json().catch(() => null);
  const parsed = ChatBody.safeParse(raw);
  if (!parsed.success) {
    return c.json(
      { error: "invalid body", details: parsed.error.flatten() },
      400,
    );
  }

  const { conversationId: incomingId, message } = parsed.data;

  // Resolve or create the conversation
  let conversationId = incomingId;
  if (conversationId) {
    if (!getConversation(conversationId)) {
      return c.json({ error: "conversation not found" }, 404);
    }
  } else {
    conversationId = createConversation();
  }

  // Persist the user message BEFORE we generate so that even if the client
  // disconnects mid-stream the question is recorded.
  appendMessage(conversationId, "user", message);

  // Build the history for the model from storage. Caps history length so a
  // long-running tab can't balloon a single request.
  const stored = getMessages(conversationId);
  const trimmed = stored.slice(-MAX_HISTORY_MESSAGES);
  const history: MessageParam[] = trimmed.map((m) => ({
    role: m.role,
    content: m.content,
  }));

  // Deterministic context pre-pass.
  const ledger = buildLedger();
  const recalled = await recall(db, message, { topK: 5 }).catch((e) => {
    console.warn("[chat] recall failed:", (e as Error).message);
    return [];
  });

  const contextBlock = buildContextBlock({
    nowIso: new Date().toISOString(),
    ledger,
    recall: renderRecall(recalled),
  });

  return streamSSE(c, async (stream) => {
    const send = (event: string, data: unknown) =>
      stream.writeSSE({
        event,
        data: JSON.stringify(data),
      });

    await send("meta", {
      conversationId,
      recalled: recalled.map((r) => ({
        date: r.created_at.slice(0, 10),
        score: Number(r.score.toFixed(3)),
        source: r.source,
      })),
    });

    let assistantText = "";
    const citations: { id: number; url: string; title: string }[] = [];
    const seenUrls = new Set<string>();
    let citationCounter = 0;

    try {
      const run = runAgent({
        anthropic,
        systemPrompt: buildSystemPrompt(),
        contextBlock,
        history,
      });

      for await (const event of run) {
        if (event.type === "text" && event.text) {
          assistantText += event.text;
          await send("text", { delta: event.text });
        } else if (event.type === "tool_use_start" && event.tool) {
          await send("tool_start", {
            name: event.tool.name,
          });
        } else if (event.type === "tool_use_end" && event.toolResult) {
          for (const url of event.toolResult.urls) {
            if (seenUrls.has(url)) continue;
            seenUrls.add(url);
            citationCounter++;
            citations.push({
              id: citationCounter,
              url,
              title: urlHostname(url),
            });
          }
          await send("tool_end", { urls: event.toolResult.urls });
        } else if (event.type === "stop") {
          break;
        } else if (event.type === "error" && event.message) {
          await send("error", { message: event.message });
          break;
        }
      }

      await send("citations", { citations });
      await send("done", { conversationId });
    } catch (e) {
      console.error("[chat] run failed:", e);
      await send("error", {
        message: "Something went wrong. Check server logs.",
      });
    } finally {
      // Persist the assistant turn (even if partial), then kick off index +
      // summary refresh in the background — never blocks the response.
      if (assistantText) {
        const stored = appendMessage(
          conversationId!,
          "assistant",
          assistantText,
        );
        // Fire-and-forget. Unhandled rejection? We log it inside the task.
        void indexAndSummarize(
          anthropic,
          conversationId!,
          message,
          assistantText,
          stored.created_at,
        ).catch((e) =>
          console.warn("[chat] background index/summary failed:", e),
        );
      }
    }
  });
});

function urlHostname(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url.slice(0, 60);
  }
}

// ---- go --------------------------------------------------------------------

serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(`[ready] http://localhost:${info.port}`);
});
