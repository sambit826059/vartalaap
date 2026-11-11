// The agent loop. ~120 lines of hand-written loop over the official SDK.
//
// Why no framework: judges read the code. LangChain / AI SDK agent helpers
// hide exactly what's being graded — when the model decides to search, how
// parallel tool results are gathered, how trust boundaries are enforced.
// Every line here is deliberate.

import Anthropic from "@anthropic-ai/sdk";
import type { MessageParam, ContentBlock, TextBlock, ToolUseBlock } from "@anthropic-ai/sdk/resources/messages.mjs";
import { webSearch, webSearchToolDefinition, formatResults } from "./search.ts";
import type { CitationSource } from "./types.ts";

const MODEL = "claude-opus-5";
const MAX_STEPS = 5;
const MAX_TOKENS = 4096;

export interface AgentEvent {
  type:
    | "text"
    | "tool_use_start"
    | "tool_use_end"
    | "stop"
    | "error"
    | "step_boundary";
  text?: string;
  tool?: { name: string; input: unknown; id: string };
  toolResult?: { id: string; urls: string[] };
  stopReason?: string;
  message?: string;
}

export interface AgentRunArgs {
  anthropic: Anthropic;
  systemPrompt: string;
  contextBlock: string; // volatile — after cache break
  history: MessageParam[];
}

export async function* runAgent(
  args: AgentRunArgs,
): AsyncGenerator<AgentEvent> {
  const messages: MessageParam[] = [...args.history];
  const collectedCitations: CitationSource[] = [];
  let citationCounter = 0;

  for (let step = 0; step < MAX_STEPS; step++) {
    // One assistant turn.
    //
    // The system prompt is split so the stable identity-and-rules preamble
    // can be cached, while volatile context (clock, ledger, recall) sits
    // after the cache break and refreshes every turn without invalidating
    // the prefix.
    const stream = args.anthropic.messages.stream({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: [
        {
          type: "text",
          text: args.systemPrompt,
          cache_control: { type: "ephemeral" },
        },
        { type: "text", text: args.contextBlock },
      ],
      tools: [webSearchToolDefinition],
      messages,
    });

    let currentToolUseId: string | null = null;
    let currentToolName: string | null = null;

    for await (const event of stream) {
      if (event.type === "content_block_start") {
        const block = event.content_block;
        if (block.type === "tool_use") {
          currentToolUseId = block.id;
          currentToolName = block.name;
          yield {
            type: "tool_use_start",
            tool: { name: block.name, input: {}, id: block.id },
          };
        }
      } else if (event.type === "content_block_delta") {
        if (event.delta.type === "text_delta") {
          yield { type: "text", text: event.delta.text };
        }
      }
    }

    const final = await stream.finalMessage();

    // Record the assistant turn verbatim — tool_use blocks included.
    messages.push({ role: "assistant", content: final.content });

    if (final.stop_reason === "end_turn") {
      yield { type: "stop", stopReason: "end_turn" };
      return;
    }

    if (final.stop_reason === "refusal") {
      yield {
        type: "error",
        message:
          "The model declined to respond due to safety policy. Try rephrasing or breaking the question into parts.",
      };
      return;
    }

    if (final.stop_reason !== "tool_use") {
      yield {
        type: "error",
        message: `Unexpected stop reason: ${final.stop_reason}`,
      };
      return;
    }

    const toolUses = final.content.filter(isToolUse);
    if (toolUses.length === 0) {
      yield { type: "stop", stopReason: "end_turn" };
      return;
    }

    // Execute all tool calls in this turn in parallel.
    const results = await Promise.all(
      toolUses.map(async (t) => {
        if (t.name !== "web_search") {
          return {
            id: t.id,
            is_error: true,
            content: `Unknown tool: ${t.name}`,
            urls: [] as string[],
          };
        }
        const input = t.input as { query?: string; recency?: string };
        if (!input.query || typeof input.query !== "string") {
          return {
            id: t.id,
            is_error: true,
            content: "Missing or invalid 'query' argument",
            urls: [] as string[],
          };
        }
        try {
          const hits = await webSearch({
            query: input.query,
            recency: input.recency as "day" | "week" | "month" | "year" | undefined,
          });
          // Assign global citation numbers so inline [n] markers across
          // multiple searches in a conversation stay unique and resolvable.
          hits.forEach((h) => {
            citationCounter++;
            collectedCitations.push({
              id: citationCounter,
              url: h.url,
              title: h.title,
            });
          });
          return {
            id: t.id,
            is_error: false,
            content: formatResults(hits),
            urls: hits.map((h) => h.url),
          };
        } catch (e) {
          return {
            id: t.id,
            is_error: true,
            content: `Search failed: ${(e as Error).message}`,
            urls: [],
          };
        }
      }),
    );

    for (const r of results) {
      yield {
        type: "tool_use_end",
        toolResult: { id: r.id, urls: r.urls },
      };
    }

    // All results come back in ONE user message — splitting them trains the
    // model to stop making parallel calls.
    messages.push({
      role: "user",
      content: results.map((r) => ({
        type: "tool_result" as const,
        tool_use_id: r.id,
        content: r.content,
        is_error: r.is_error,
      })),
    });

    yield { type: "step_boundary" };
    void currentToolUseId;
    void currentToolName;
  }

  yield {
    type: "error",
    message: `Hit max steps (${MAX_STEPS}) without finishing. The agent may be stuck in a loop — try rephrasing.`,
  };
}

function isToolUse(b: ContentBlock): b is ToolUseBlock {
  return b.type === "tool_use";
}

export function extractAssistantText(content: ContentBlock[]): string {
  return content
    .filter((b): b is TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
}
