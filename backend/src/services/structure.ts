/**
 * structure.ts
 * ------------
 * Turns raw extracted text into a StructuredDoc — the standard TTG section
 * layout the renderer expects. This is the "put in whatever content, get a
 * structured document back" intelligence.
 *
 * Three structurers:
 *   - "groq" (best quality): an LLM (Groq API, OpenAI-compatible) structures
 *     the whole document in one step and understands a free-form custom
 *     prompt from the person requesting the document. Needs GROQ_API_KEY.
 *   - "transformers" (default, no API key): a local pre-trained zero-shot
 *     model routes each paragraph to the right TTG section (Transformers.js
 *     / ONNX, runs offline).
 *   - "heuristic" (no API key, no model download): pure-JavaScript keyword
 *     routing.
 *
 * Both the groq and transformers paths fall back automatically — groq to
 * transformers/heuristic, transformers to heuristic — so a document is
 * always produced even if an API call fails or a model can't load.
 */

import { config } from "../config";
import { assemble } from "./structurers/shared";
import { heuristicClassifier } from "./structurers/heuristic";
import type { StructuredDoc } from "./renderTtgDocx";

export interface StructureInput {
  title: string;
  version: string;
  ownerName: string;
  ownerEmail: string;
  content: string;
  /** Optional free-form instructions from the person requesting the document
   *  (e.g. "focus on the API endpoints, skip the database schema"). Only the
   *  groq structurer can act on this — it's ignored by the local paths. */
  customPrompt?: string;
}

export async function structureContent(input: StructureInput): Promise<StructuredDoc> {
  if (config.structurer === "groq") {
    try {
      const { structureWithGroq } = await import("./structurers/groq");
      return await structureWithGroq(input);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(
        "[structure] groq structurer failed; falling back to local structuring:",
        err instanceof Error ? err.message : err
      );
    }
  }

  if (config.structurer === "groq" || config.structurer === "transformers") {
    try {
      const { transformersClassifier } = await import("./structurers/transformers");
      return await assemble(input, transformersClassifier);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(
        "[structure] model structurer unavailable; falling back to heuristic:",
        err instanceof Error ? err.message : err
      );
    }
  }
  return assemble(input, heuristicClassifier);
}
