// Background summarization. Runs after each assistant turn without blocking
// the user. Uses the same model at low effort — cheap, reliable, and the
// summary quality matters for memory recall accuracy.

import Anthropic from "@anthropic-ai/sdk";
import { embed } from "./embeddings.ts";
import {
  getConversation,
  getMessages,
  indexExchange,
  setConversationSummary,
} from "./memory.ts";
import { buildSummaryPrompt, buildTopicsPrompt } from "./prompt.ts";

const SUMMARY_MODEL = "claude-opus-5";

export async function indexAndSummarize(
  anthropic: Anthropic,
  conversationId: string,
  userText: string,
  assistantText: string,
  createdAt: string,
): Promise<void> {
  // 1. Embed + index this exchange for future recall. Best effort — if the
  //    embedder is down, still write to FTS so keyword recall keeps working.
  const chunk = `USER: ${userText}\nASSISTANT: ${assistantText}`;
  let vec: Float32Array | null = null;
  try {
    const result = await embed([chunk]);
    vec = result[0] ?? null;
  } catch (e) {
    console.warn(
      "[summarize] embedding failed; falling back to FTS-only index for this exchange:",
      (e as Error).message,
    );
  }
  try {
    indexExchange({
      conversationId,
      userText,
      assistantText,
      createdAt,
      embedding: vec,
    });
  } catch (e) {
    console.warn("[summarize] indexExchange failed:", (e as Error).message);
  }

  // 2. Refresh the running summary for this conversation. Use the full
  //    transcript so far so the summary reflects the whole thread, not just
  //    the latest turn.
  try {
    const all = getMessages(conversationId);
    if (all.length === 0) return;
    const transcript = all
      .map((m) => `${m.role.toUpperCase()}: ${m.content}`)
      .join("\n\n");

    const summaryRes = await anthropic.messages.create({
      model: SUMMARY_MODEL,
      max_tokens: 400,
      thinking: { type: "disabled" },
      output_config: { effort: "low" },
      system:
        "You write dense, factual summaries of assistant/user conversations. No preamble, no hedging.",
      messages: [
        {
          role: "user",
          content: buildSummaryPrompt("(see transcript below)", transcript),
        },
      ],
    });
    const summary = textOf(summaryRes.content).trim();
    if (!summary) return;

    const topicsRes = await anthropic.messages.create({
      model: SUMMARY_MODEL,
      max_tokens: 100,
      thinking: { type: "disabled" },
      output_config: { effort: "low" },
      system:
        "Extract topic tags for a conversation. Return ONLY a JSON array of 2-5 short strings.",
      messages: [{ role: "user", content: buildTopicsPrompt(summary) }],
    });
    let topics: string[] = [];
    try {
      const parsed = JSON.parse(textOf(topicsRes.content).trim());
      if (Array.isArray(parsed)) {
        topics = parsed
          .filter((t): t is string => typeof t === "string")
          .slice(0, 5);
      }
    } catch {
      // ignore — summary alone is fine
    }

    // Only update if the conversation still exists (user hasn't deleted it)
    if (getConversation(conversationId)) {
      setConversationSummary(conversationId, summary, topics);
    }
  } catch (e) {
    console.warn("[summarize] summary failed:", (e as Error).message);
  }
}

function textOf(blocks: unknown): string {
  if (!Array.isArray(blocks)) return "";
  return blocks
    .filter(
      (b): b is { type: "text"; text: string } =>
        !!b && typeof b === "object" && (b as { type: string }).type === "text",
    )
    .map((b) => b.text)
    .join("");
}
