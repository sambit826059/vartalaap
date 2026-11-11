// Embeddings with two backends behind one interface.
//
//   1. Voyage voyage-3.5-lite  (set VOYAGE_API_KEY) — cloud, MTEB-top-tier
//   2. Local bge-small-en-v1.5 (@huggingface/transformers) — CPU, ~30MB,
//      downloaded on first call. Kept dynamic-imported so the module cost
//      is paid only if the fallback actually runs.
//
// Both produce L2-normalized float32 vectors. Voyage returns 1024-dim,
// bge-small is 384-dim. The dim is frozen at process start by the first
// call to getEmbeddingDim() so the DB schema can be built for it.

const VOYAGE_MODEL = "voyage-3.5-lite";
const VOYAGE_DIM = 1024;
const LOCAL_MODEL = "Xenova/bge-small-en-v1.5";
const LOCAL_DIM = 384;

type Backend = "voyage" | "local" | "disabled";

let backend: Backend | null = null;
let dim: number | null = null;
let localPipeline: ((texts: string[]) => Promise<Float32Array[]>) | null = null;

function resolveBackend(): Backend {
  if (backend) return backend;
  if (process.env.VOYAGE_API_KEY) {
    backend = "voyage";
    dim = VOYAGE_DIM;
  } else {
    backend = "local";
    dim = LOCAL_DIM;
  }
  return backend;
}

export function getEmbeddingBackend(): Backend {
  return resolveBackend();
}

export function getEmbeddingDim(): number {
  resolveBackend();
  return dim!;
}

/** Embed a batch. Returns L2-normalized float32 vectors. */
export async function embed(texts: string[]): Promise<Float32Array[]> {
  if (texts.length === 0) return [];
  const b = resolveBackend();
  if (b === "voyage") return embedVoyage(texts);
  return embedLocal(texts);
}

// ----- Voyage ---------------------------------------------------------------

async function embedVoyage(texts: string[]): Promise<Float32Array[]> {
  const res = await fetch("https://api.voyageai.com/v1/embeddings", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${process.env.VOYAGE_API_KEY}`,
    },
    body: JSON.stringify({
      model: VOYAGE_MODEL,
      input: texts,
      output_dtype: "float",
    }),
    // Reasonable timeout — embeddings should be fast
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Voyage embeddings failed ${res.status}: ${body.slice(0, 300)}`);
  }
  const json = (await res.json()) as {
    data: { embedding: number[]; index: number }[];
  };
  // Order is not guaranteed — sort by index before returning
  const sorted = [...json.data].sort((a, b) => a.index - b.index);
  return sorted.map((d) => normalize(new Float32Array(d.embedding)));
}

// ----- Local (transformers.js) ----------------------------------------------

async function embedLocal(texts: string[]): Promise<Float32Array[]> {
  if (!localPipeline) {
    localPipeline = await buildLocalPipeline();
  }
  return localPipeline(texts);
}

async function buildLocalPipeline(): Promise<
  (texts: string[]) => Promise<Float32Array[]>
> {
  // Dynamic import so Voyage users don't pay the module cost.
  const { pipeline, env } = await import("@huggingface/transformers");
  // Ensure the model cache has a stable location
  env.cacheDir = env.cacheDir || "./.cache/hf";
  const extractor = await pipeline("feature-extraction", LOCAL_MODEL, {
    dtype: "fp32",
  });

  return async (texts: string[]) => {
    // bge recommends prefixing queries; we use the same encoding for docs and
    // queries since the model was trained symmetrically in v1.5.
    const output = await extractor(texts, { pooling: "mean", normalize: true });
    // output.data is a flat Float32Array of length (batch * dim)
    const flat = output.data as Float32Array;
    const n = texts.length;
    const d = flat.length / n;
    const result: Float32Array[] = [];
    for (let i = 0; i < n; i++) {
      result.push(flat.slice(i * d, (i + 1) * d));
    }
    return result;
  };
}

// ----- utils ---------------------------------------------------------------

function normalize(v: Float32Array): Float32Array {
  let sum = 0;
  for (let i = 0; i < v.length; i++) sum += v[i]! * v[i]!;
  const n = Math.sqrt(sum);
  if (n === 0) return v;
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i]! / n;
  return out;
}
