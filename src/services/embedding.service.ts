// ── ULTRON v8 — local embedding service ───────────────────────────────────────
// transformers.js + MiniLM-L6-v2 (384 dims). Fully local: no API, no cost, private.
// Model cached under ~/.ultron/models. Lazy-loaded on first embed.

import { join } from "path";
import { homedir } from "os";
import { EMBED_DIM } from "../db/schema.js";
import { log } from "../lib/logger.js";

const ULTRON_DIR = process.env.ULTRON_DIR ?? join(homedir(), ".ultron");
const MODEL_ID = "Xenova/all-MiniLM-L6-v2";

// Point transformers.js cache at ULTRON dir before it loads.
process.env.HF_HOME = process.env.HF_HOME ?? join(ULTRON_DIR, "models");

type Extractor = (
  input: string | string[],
  opts: { pooling: "mean"; normalize: boolean }
) => Promise<{ data: Float32Array; dims: number[] }>;

let extractorPromise: Promise<Extractor> | null = null;
let available = true;

async function getExtractor(): Promise<Extractor> {
  if (!extractorPromise) {
    extractorPromise = (async () => {
      const { pipeline } = await import("@huggingface/transformers");
      const t0 = Date.now();
      const ex = (await pipeline("feature-extraction", MODEL_ID, { dtype: "fp32" })) as unknown as Extractor;
      log.info("embedding model loaded", { model: MODEL_ID, ms: Date.now() - t0 });
      return ex;
    })();
  }
  return extractorPromise;
}

/** Whether embeddings are usable (false after a hard load failure). */
export function embeddingsAvailable(): boolean {
  return available;
}

/** Pre-load model in background — call at MCP boot to avoid first-call latency. */
export function warmupEmbeddings(): void {
  if (!available) return;
  void getExtractor().catch(() => { /* logged inside getExtractor */ });
}

/** Embed one text → Float32Array(384), or null if the model can't load. */
export async function embedOne(text: string): Promise<Float32Array | null> {
  const out = await embedMany([text]);
  return out?.[0] ?? null;
}

/** Embed a batch → array of Float32Array(384), or null on failure. */
export async function embedMany(texts: string[]): Promise<Float32Array[] | null> {
  if (!available || texts.length === 0) return null;
  try {
    const ex = await getExtractor();
    const res = await ex(texts, { pooling: "mean", normalize: true });
    const [n, dim] = res.dims;
    if (dim !== EMBED_DIM) throw new Error(`unexpected embedding dim ${dim}, expected ${EMBED_DIM}`);
    const out: Float32Array[] = [];
    for (let i = 0; i < n; i++) {
      out.push(res.data.slice(i * dim, (i + 1) * dim) as Float32Array);
    }
    return out;
  } catch (e) {
    available = false;
    log.error("embedding failed — disabling semantic features", { error: String(e) });
    return null;
  }
}

/** Cosine similarity for normalized vectors (= dot product). */
export function cosineSim(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;
}
