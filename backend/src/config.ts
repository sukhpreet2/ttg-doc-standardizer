import dotenv from "dotenv";
dotenv.config();

function required(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined) throw new Error(`Missing required env var: ${name}`);
  return v;
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
  structurer: (["groq", "heuristic", "transformers"] as const).includes(
    process.env.STRUCTURER as "groq" | "heuristic" | "transformers"
  )
    ? (process.env.STRUCTURER as "groq" | "heuristic" | "transformers")
    : "transformers",
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
