/**
 * structurers/groq.ts
 * --------------------
 * LLM-backed structuring via Groq's OpenAI-compatible chat completions API.
 * Unlike the heuristic/transformers paths (which classify pre-split
 * paragraphs into fixed buckets), this asks the model to do the whole job in
 * one step: identify real structure where it exists, write clean condensed
 * prose otherwise, and follow the user's own instructions for what the
 * output should emphasize. It's the highest-quality path, and the only one
 * that understands a free-form custom prompt — but it costs an API call and
 * needs GROQ_API_KEY, so callers should fall back to the heuristic/
 * transformers path on any failure (see structure.ts).
 */

import { config } from "../../config";
import type { StructuredDoc, StructuredSection, StructuredSubsection } from "../renderTtgDocx";

// Keep the request bounded — this is a summarizer, not a verbatim
// reproduction, and a hard cap keeps latency/cost predictable regardless of
// source size. ~60k characters is comfortably inside every current Groq
// Llama model's context window even after the system prompt and schema.
const MAX_CONTENT_CHARS = 60_000;
const MAX_CUSTOM_PROMPT_CHARS = 2_000;

interface LlmSection {
  heading: string;
  paragraphs?: string[];
  bullets?: string[];
  subsections?: Array<{ heading: string; paragraphs?: string[]; bullets?: string[] }>;
}

interface LlmResponseShape {
  sections: LlmSection[];
}

const SYSTEM_PROMPT = `You are a document-standardization assistant for Tartigrade (TTG). You turn arbitrary source content into a clean, professional, well-organized document body.

Rules:
1. If the source content already has its own clear section structure (numbered headings, an obvious outline), PRESERVE that structure: same headings, same order, same nesting into subsections. Do not force it into a generic template.
2. If the source has no clear structure (raw notes, a rough draft, a transcript), organize it sensibly yourself — typically something like Introduction, the substantive body split into logical sections, and a closing/next-steps section — using headings that actually describe the content, not filler labels.
3. Condense. Write clean, complete, professional prose paragraphs. Do not copy huge verbatim blocks; summarize and rephrase for clarity. Drop noise: raw tables/DDL dumps, ASCII diagrams, repeated page headers/footers, page numbers.
4. Use "bullets" only where the source content is genuinely a list; otherwise write paragraphs.
5. Use "subsections" only where the source genuinely has a nested sub-heading under a section; most sections won't have any.
6. Do not include a title page, table of contents, version, or owner info in your output — that's handled separately. Start straight from the first real section/topic.
7. Respond with ONLY a single JSON object, no prose before or after it, matching this exact shape:
{"sections": [{"heading": "string", "paragraphs": ["string", ...], "bullets": ["string", ...], "subsections": [{"heading": "string", "paragraphs": ["string", ...], "bullets": ["string", ...]}]}]}
"bullets" and "subsections" are optional — omit them entirely for a section/subsection that doesn't need them. Every section and subsection needs at least one paragraph or bullet.`;

function buildUserPrompt(content: string, customPrompt?: string): string {
  const truncated =
    content.length > MAX_CONTENT_CHARS
      ? content.slice(0, MAX_CONTENT_CHARS) + "\n\n[... content truncated for length ...]"
      : content;

  const instructions = customPrompt?.trim()
    ? `\n\nThe person who requested this document gave these additional instructions — follow them for tone, emphasis, and what to focus on or leave out, while still following the rules above:\n"""\n${customPrompt.trim().slice(0, MAX_CUSTOM_PROMPT_CHARS)}\n"""`
    : "";

  return `Source content to standardize:\n"""\n${truncated}\n"""${instructions}`;
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

/** Validate and normalize the model's JSON into our StructuredSection shape (numbers assigned separately). */
function parseLlmResponse(raw: string): LlmSection[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Groq response was not valid JSON");
  }
  const sections = (parsed as Partial<LlmResponseShape>)?.sections;
  if (!Array.isArray(sections) || sections.length === 0) {
    throw new Error("Groq response did not contain a non-empty sections array");
  }
  for (const s of sections) {
    if (typeof s?.heading !== "string" || !s.heading.trim()) {
      throw new Error("Groq response had a section with no heading");
    }
    if (s.paragraphs !== undefined && !isStringArray(s.paragraphs)) {
      throw new Error(`Groq response section "${s.heading}" had a non-string-array paragraphs field`);
    }
    if (s.bullets !== undefined && !isStringArray(s.bullets)) {
      throw new Error(`Groq response section "${s.heading}" had a non-string-array bullets field`);
    }
  }
  return sections as LlmSection[];
}

function toStructuredSections(llmSections: LlmSection[]): StructuredSection[] {
  const out: StructuredSection[] = [];
  llmSections.forEach((s, i) => {
    const paragraphs = (s.paragraphs ?? []).filter((p) => p.trim().length > 0);
    const bullets = (s.bullets ?? []).filter((b) => b.trim().length > 0);
    if (paragraphs.length === 0 && bullets.length === 0 && !(s.subsections ?? []).length) return;

    const subsections: StructuredSubsection[] = (s.subsections ?? [])
      .filter((sub) => sub?.heading?.trim())
      .map((sub, j) => ({
        number: `${i + 1}.${j + 1}`,
        heading: sub.heading.trim(),
        paragraphs: (sub.paragraphs ?? []).filter((p) => p.trim().length > 0),
        bullets: (sub.bullets ?? []).filter((b) => b.trim().length > 0) || undefined,
      }))
      .filter((sub) => sub.paragraphs.length > 0 || (sub.bullets?.length ?? 0) > 0);

    out.push({
      number: String(out.length + 1),
      heading: s.heading.trim(),
      paragraphs,
      bullets: bullets.length ? bullets : undefined,
      subsections: subsections.length ? subsections : undefined,
    });
  });
  // Renumber top-level sequentially in case any were dropped above.
  out.forEach((s, i) => (s.number = String(i + 1)));
  return out;
}

export interface GroqStructureInput {
  title: string;
  version: string;
  ownerName: string;
  ownerEmail: string;
  content: string;
  customPrompt?: string;
}

export async function structureWithGroq(input: GroqStructureInput): Promise<StructuredDoc> {
  if (!config.groqApiKey) {
    throw new Error("GROQ_API_KEY is not set");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.groqTimeoutMs);

  let res: Response;
  try {
    res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.groqApiKey}`,
      },
      body: JSON.stringify({
        model: config.groqModel,
        temperature: 0.2,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: buildUserPrompt(input.content, input.customPrompt) },
        ],
      }),
      signal: controller.signal,
    });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(`Groq request timed out after ${config.groqTimeoutMs}ms`);
    }
    throw new Error(`Groq request failed: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    clearTimeout(timeout);
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Groq API error ${res.status}: ${body.slice(0, 500)}`);
  }

  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const raw = data.choices?.[0]?.message?.content;
  if (!raw) {
    throw new Error("Groq response had no message content");
  }

  const llmSections = parseLlmResponse(raw);
  const sections = toStructuredSections(llmSections);
  if (sections.length === 0) {
    throw new Error("Groq response produced no usable sections after validation");
  }

  return {
    title: input.title,
    version: input.version,
    ownerName: input.ownerName,
    ownerEmail: input.ownerEmail,
    sections,
  };
}
