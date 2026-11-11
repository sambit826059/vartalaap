# Chat Agent

A chat agent with one tool (web search) and dated hybrid memory across sessions.
Built for Binary's architecture evaluation. Full design rationale in [DESIGN.md](./DESIGN.md).

## Run

```bash
cp .env.example .env    # fill in ANTHROPIC_API_KEY and TAVILY_API_KEY
npm install
npm run seed            # optional: seeds dated past conversations
npm run dev             # http://localhost:3000
```

Node 22.13+ required (needed for SQLite extension loading).

## Keys

Two required, one optional:

- `ANTHROPIC_API_KEY` — get from [console.anthropic.com](https://console.anthropic.com)
- `TAVILY_API_KEY` — get from [tavily.com](https://tavily.com) (free tier: 1000 searches/month)
- `VOYAGE_API_KEY` — *optional*. Enables Voyage AI embeddings for semantic
  recall. If unset, the server falls back to a local CPU embedder
  (bge-small-en-v1.5, ~30MB downloaded on first use). Semantic recall works
  either way.

## Try it

Run `npm run seed` first — it loads four dated past conversations (CRM shortlist,
Postgres hosting, Next.js, TypeScript) so you can test the memory behavior
immediately without waiting days.

Then ask things like:

- *"What did we shortlist for CRMs?"* — pure memory recall
- *"Has any of those CRM tools changed pricing since?"* — the diffing pattern
- *"What did I ask you about Postgres last week?"* — date-based recall
- *"When did I last ask about TypeScript?"* — semantic/lexical hybrid recall

## Project layout

```
src/
├── index.ts       # Hono server: SSE chat endpoint, security middleware
├── agent.ts       # the hand-written agent loop (~120 lines, one tool)
├── search.ts      # Tavily web search wrapper + untrusted-content framing
├── memory.ts      # SQLite + sqlite-vec + FTS5: persistence, ledger builder
├── retrieval.ts   # hybrid recall: vector KNN + BM25 + reciprocal rank fusion
├── embeddings.ts  # Voyage cloud → local bge-small fallback
├── summarize.ts   # async background indexing + summary refresh
├── prompt.ts      # the system prompt (the real product IP)
└── types.ts

public/            # vanilla-JS chat UI with safe rendering + link allowlist
scripts/seed.ts    # dated fake conversations for demo
DESIGN.md          # architecture rationale, threat model, trade-offs
```

## Commands

- `npm run dev` — dev server with auto-restart
- `npm start` — one-shot start
- `npm run seed` — seed dated past conversations (`-- --reset` to wipe first)
- `npm run typecheck` — TypeScript check

## License

MIT
