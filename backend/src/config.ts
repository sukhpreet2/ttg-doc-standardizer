import dotenv from "dotenv";
dotenv.config();

function required(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined) throw new Error(`Missing required env var: ${name}`);
  return v;
}

type Structurer = "groq" | "heuristic" | "transformers";
const VALID_STRUCTURERS: Structurer[] = ["groq", "heuristic", "transformers"];

/**
 * Trims whitespace and normalizes case before matching, and — unlike a bare
 * strict-equality check — logs a clear warning when STRUCTURER was actually
 * set to something that doesn't match any known value, instead of silently
 * falling back to "transformers" with zero trace of why. A stray trailing
 * space/newline from a copy-paste into a dashboard input, or a case typo,
 * used to be indistinguishable from "not set at all".
 */
function parseStructurer(raw: string | undefined): Structurer {
  if (!raw || !raw.trim()) return "transformers";
  const normalized = raw.trim().toLowerCase() as Structurer;
  if (VALID_STRUCTURERS.includes(normalized)) return normalized;
  // eslint-disable-next-line no-console
  console.warn(
    `[config] STRUCTURER=${JSON.stringify(raw)} is not one of ${VALID_STRUCTURERS.join(
      ", "
    )} — falling back to "transformers". Check for a typo or stray whitespace.`
  );
  return "transformers";
}

export const config = {
  port: parseInt(process.env.PORT ?? "4000", 10),
  nodeEnv: process.env.NODE_ENV ?? "development",

  // Postgres
  databaseUrl: required("DATABASE_URL", "postgres://ttg:ttg@localhost:5432/ttg_docs"),

  // Structuring engine:
  //   "groq"         = LLM (Groq API, OpenAI-compatible) — needs GROQ_API_KEY.
  //                    Understands a user-supplied custom prompt; best quality.
  //   "transformers" = local pre-trained zero-shot model (Transformers.js/ONNX)
  //   "heuristic"    = pure-JS keyword routing (no model download, no API)
  structurer: parseStructurer(process.env.STRUCTURER),
  // Local zero-shot model (Hugging Face id, ONNX/Transformers.js compatible).
  zeroShotModel: process.env.ZEROSHOT_MODEL ?? "Xenova/nli-deberta-v3-xsmall",
  // Where model weights are cached (pre-downloaded at Docker build).
  transformersCacheDir: process.env.TRANSFORMERS_CACHE_DIR ?? "/models",
  // In production run fully offline (weights must be pre-downloaded).
  transformersOffline: (process.env.TRANSFORMERS_OFFLINE ?? "true") !== "false",

  // Groq (OpenAI-compatible chat completions API) — only used when
  // STRUCTURER=groq. Never hardcode the key; it's read from the
  // environment only, and never logged or echoed back to the client.
  groqApiKey: process.env.GROQ_API_KEY ?? "",
  groqModel: process.env.GROQ_MODEL ?? "llama-3.3-70b-versatile",
  groqTimeoutMs: parseInt(process.env.GROQ_TIMEOUT_MS ?? "45000", 10),

  // Where rendered .docx files are written (mount a PVC here in k8s)
  // No longer used to store rendered documents (those are now stored as bytes
  // in Postgres so they survive Render's ephemeral-disk restarts). Kept as a
  // no-op env var in case other tooling still references it.
  outputDir: process.env.OUTPUT_DIR ?? "/data/outputs",

  // CORS origin for the frontend
  corsOrigin: process.env.CORS_ORIGIN ?? "*",

  // Max upload size in bytes (default 15 MB)
  maxUploadBytes: parseInt(process.env.MAX_UPLOAD_BYTES ?? "15728640", 10),
};

export const structurerMode = config.structurer;
