/**
 * structure.ts
 * ------------
 * Turns raw extracted text into a StructuredDoc — the standard TTG section
 * layout the renderer expects. This is the "put in whatever content, get a
 * structured document back" intelligence.
 *
 * Two structurers, no external API and no API key:
 *   - "transformers" (default): a local pre-trained zero-shot model routes each
 *     paragraph to the right TTG section (Transformers.js / ONNX, runs offline).
 *   - "heuristic": pure-JavaScript keyword routing (no model, no download).
 *
 * The model path falls back to the heuristic automatically if the model can't
 * be loaded, so a document is always produced.
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
}

export async function structureContent(input: StructureInput): Promise<StructuredDoc> {
  if (config.structurer === "transformers") {
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
