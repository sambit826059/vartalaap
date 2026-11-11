// Seeds dated fake conversations into the DB so judges can test memory
// behavior immediately (and so the three sample questions from the brief
// have something to retrieve). Idempotent-ish: pass --reset to wipe first.
//
// Usage:  npm run seed            # add seed conversations
//         npm run seed -- --reset # delete all data, then seed

import { mkdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import {
  appendMessage,
  createConversation,
  openDb,
  setConversationSummary,
  indexExchange,
} from "../src/memory.ts";
import { embed, getEmbeddingBackend } from "../src/embeddings.ts";

const DB_PATH = process.env.DATABASE_PATH ?? "./data/chat.db";

function daysAgo(n: number, hour = 14, minute = 30): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  d.setHours(hour, minute, 0, 0);
  return d.toISOString();
}

interface Seed {
  daysAgo: number;
  topics: string[];
  summary: string;
  exchanges: { user: string; assistant: string }[];
}

const SEEDS: Seed[] = [
  {
    daysAgo: 2,
    topics: ["CRM tools", "pricing", "sales team"],
    summary:
      "Shortlisted 5 CRM tools for a 20-person sales team. Compared pricing, features, and integration options. The five finalists were HubSpot Sales Hub, Pipedrive, Close, Attio, and Salesforce Sales Cloud. Pipedrive Advanced was the cheapest at ~$34/seat/mo annual; HubSpot Sales Hub Professional was $100/seat/mo. Close was recommended for outbound-heavy teams at $35/user/mo (Startup tier). Attio was flagged as the newest option with usage-based pricing starting at $29/seat/mo. Salesforce Sales Cloud Professional was $80/user/mo. Next step: demo Pipedrive and Attio.",
    exchanges: [
      {
        user: "We're a 20-person sales team looking at CRMs. Can you help me shortlist 5 options with pricing?",
        assistant:
          "Based on your size and needs, here's a solid shortlist:\n\n1. HubSpot Sales Hub Professional — $100/seat/mo annual. Strong marketing integration.\n2. Pipedrive Advanced — $34/seat/mo annual. Simple pipeline focus, cheapest of the five.\n3. Close — $35/user/mo (Startup tier). Best for outbound-heavy teams, built-in calling.\n4. Attio — $29/seat/mo. Newest option, usage-based pricing, strong API.\n5. Salesforce Sales Cloud Professional — $80/user/mo. Most powerful, steepest learning curve.\n\nFor 20 seats, Pipedrive comes to $680/mo, Close $700, HubSpot $2000, Salesforce $1600, Attio starts around $580 but scales with usage.\n\nWant me to dig deeper on any of these?",
      },
      {
        user: "Yeah let's do Pipedrive and Attio — we might demo both.",
        assistant:
          "Good picks. Pipedrive is the safer choice if your reps want a familiar deal-flow interface and your admin team is small; it's been around 12+ years, docs are mature. Attio is more interesting if you're already collecting CRM data into Postgres/warehouses — their data model is table-first and their API is the best in this comparison. I'd book both demos within the same week so your team can judge them side-by-side.",
      },
    ],
  },
  {
    daysAgo: 7,
    topics: ["Postgres hosting", "database", "managed providers"],
    summary:
      "Discussed managed Postgres hosting options for a production workload with ~50GB of data and moderate read-heavy traffic. Compared Supabase, Neon, Railway, AWS RDS, and Crunchy Bridge. Neon's pricing was $19/mo for Launch tier (1 compute, 10GB storage) scaling to usage-based beyond that. Supabase Pro was $25/mo flat for 8GB included. Crunchy Bridge was quoted at $90/mo for a small instance. Recommended Neon for read-heavy workloads due to its separation of storage and compute. Next step: test Neon with a staging workload.",
    exchanges: [
      {
        user: "I'm picking a managed Postgres provider for a production app. Read-heavy, ~50GB data. What should I look at?",
        assistant:
          "The main options for your profile:\n\n- **Neon** — Launch tier $19/mo (1 compute + 10GB storage, usage-based beyond). Separates storage and compute, which is great for read-heavy workloads because you can scale reads independently. Branching feature is nice for dev workflows.\n- **Supabase Pro** — $25/mo flat, 8GB storage included, extra storage at $0.125/GB/mo. Comes with auth, realtime, edge functions — useful if you don't want to assemble them separately.\n- **Railway** — usage-based, roughly $10-30/mo for your size. Deploys are fast but no read replicas yet.\n- **AWS RDS** — more work to set up, cheapest at scale, ~$50-80/mo for your size on db.t4g.medium with 50GB gp3.\n- **Crunchy Bridge** — ~$90/mo for a small HA instance, excellent Postgres expertise behind it, best support if things go wrong.\n\nFor your workload shape, Neon is probably the best fit — the storage/compute split is genuinely useful here. Want to dig into any of these?",
      },
      {
        user: "Let's start with Neon. Any gotchas?",
        assistant:
          "Three to watch:\n\n1. Cold-start latency on their autoscaling compute — first query after idle can take 200-500ms. Fine for most apps, bad for anything latency-sensitive.\n2. Usage-based billing can surprise you if you have unexpected traffic spikes. Set a spend cap in the dashboard.\n3. Branching uses copy-on-write but writes to a branch count against your storage quota. Easy to blow past the 10GB included if you spin up lots of branches.\n\nI'd spin up a staging project this week and point a mirrored workload at it for a few days before committing.",
      },
    ],
  },
  {
    daysAgo: 14,
    topics: ["Next.js", "App Router", "React Server Components"],
    summary:
      "Explained how Next.js App Router handles Server Components vs Client Components, and when to use which. Covered the 'use client' directive, data fetching with async Server Components, and streaming with Suspense. Recommended starting server-first and only marking components client when they need interactivity.",
    exchanges: [
      {
        user: "Trying to understand Next.js App Router. When do I use Server Components vs Client Components?",
        assistant:
          "Start server-first. The App Router defaults every component to Server Component. Only add `'use client'` when a component actually needs browser-only features: useState, useEffect, onClick handlers, browser APIs. Keep client components as leaf nodes — a client component CAN import a server component (via `children`), but the reverse doesn't work.\n\nFor data: fetch in server components (direct async/await, no useEffect), pass serializable data to client components as props. Use Suspense boundaries to stream in slow server-side data without blocking the whole page.",
      },
    ],
  },
  {
    daysAgo: 21,
    topics: ["TypeScript", "strict mode", "type narrowing"],
    summary:
      "Discussed enabling strict mode in TypeScript and the biggest wins (strictNullChecks, noImplicitAny, strictFunctionTypes). Explained type narrowing with typeof, instanceof, 'in' operator, and user-defined type guards. Recommended also turning on noUncheckedIndexedAccess for safer array/record access.",
    exchanges: [
      {
        user: "Should I enable strict mode in TypeScript? What does it actually do?",
        assistant:
          "Yes, enable it on day one — it's much harder to retrofit later. `strict: true` turns on 7 flags; the ones that catch real bugs are strictNullChecks (forces you to handle null/undefined), noImplicitAny (no silent `any` leaks), and strictFunctionTypes (contravariant params). Also turn on `noUncheckedIndexedAccess` — it's not in strict by default but it makes `array[i]` return `T | undefined`, which prevents a huge class of out-of-bounds bugs.",
      },
    ],
  },
];

async function main() {
  const reset = process.argv.includes("--reset");
  if (reset) {
    try {
      rmSync(DB_PATH, { force: true });
      rmSync(DB_PATH + "-wal", { force: true });
      rmSync(DB_PATH + "-shm", { force: true });
      console.log(`[seed] wiped ${DB_PATH}`);
    } catch {
      /* fine */
    }
  }

  mkdirSync(dirname(DB_PATH), { recursive: true });
  openDb(DB_PATH);
  console.log(`[seed] embeddings backend: ${getEmbeddingBackend()}`);

  for (const s of SEEDS) {
    const convId = createConversation();
    const baseDate = daysAgo(s.daysAgo);
    console.log(`[seed] +${s.topics[0]} (${baseDate.slice(0, 10)}) → ${convId}`);

    for (const ex of s.exchanges) {
      const userMsg = appendMessage(convId, "user", ex.user);
      const assistantMsg = appendMessage(convId, "assistant", ex.assistant);
      // Backdate the rows so the ledger shows the right date
      // (appendMessage sets created_at to now; we override here)
      const db = openDb(DB_PATH);
      db.prepare("UPDATE messages SET created_at = ? WHERE id = ?").run(
        baseDate,
        userMsg.id,
      );
      db.prepare("UPDATE messages SET created_at = ? WHERE id = ?").run(
        baseDate,
        assistantMsg.id,
      );
      db.prepare(
        "UPDATE conversations SET started_at = ?, last_activity_at = ? WHERE id = ?",
      ).run(baseDate, baseDate, convId);

      let vec: Float32Array | null = null;
      try {
        const chunk = `USER: ${ex.user}\nASSISTANT: ${ex.assistant}`;
        vec = (await embed([chunk]))[0] ?? null;
      } catch (e) {
        console.warn(`[seed] embedding failed: ${(e as Error).message}`);
      }
      indexExchange({
        conversationId: convId,
        userText: ex.user,
        assistantText: ex.assistant,
        createdAt: baseDate,
        embedding: vec,
      });
    }

    setConversationSummary(convId, s.summary, s.topics);
  }

  console.log(`[seed] done. seeded ${SEEDS.length} conversations.`);
  console.log(`[seed] try: npm run dev, then ask things like:`);
  console.log(`         "What CRM tools did we shortlist?"`);
  console.log(`         "Has Pipedrive's pricing changed since?"`);
  console.log(`         "What did I ask about Postgres hosting?"`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
