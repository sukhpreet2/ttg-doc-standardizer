/**
 * structurers/shared.ts
 * ---------------------
 * Format-agnostic logic shared by every structurer. A "structurer" only has to
 * decide, for each source paragraph, which TTG body section it belongs to
 * (a ParagraphClassifier). Everything else — splitting text, extractive
 * summarization, and assembling/numbering the standard TTG sections — lives here
 * so the model-based and heuristic structurers produce identically-shaped output.
 *
 * No external services and no API keys.
 */

import type { StructuredDoc, StructuredSection } from "../renderTtgDocx";

/** The optional TTG body sections that source content can be routed into. */
export type BodyLabel = "problem" | "scope" | "description" | "manual" | "next" | "other";

export interface ParagraphClassifier {
  /** Classify each paragraph; returns one label per input paragraph, in order. */
  classify(paragraphs: string[]): Promise<BodyLabel[]>;
}

/** Human-readable heading for each optional body section, in canonical order. */
const BODY_ORDER: { label: BodyLabel; heading: string }[] = [
  { label: "problem", heading: "Problem Description" },
  { label: "scope", heading: "Scope of Work & Sequence" },
  { label: "description", heading: "Description of Work" },
  { label: "manual", heading: "Operating Manual" },
  { label: "next", heading: "Next Steps" },
];

/** Natural-language candidate labels for zero-shot classification. */
export const CANDIDATE_LABELS: Record<Exclude<BodyLabel, "other">, string> = {
  problem: "a description of a problem, issue, challenge, or requirement",
  scope: "the scope of work, plan, timeline, or sequence of actions",
  description: "a technical description of work done: methods, implementation, and results",
  manual: "step-by-step instructions or a usage guide for operating something",
  next: "future improvements, recommendations, next steps, or follow-up work",
};

// ---- Text splitting ---------------------------------------------------------

/** Detect non-prose blocks (tables, ASCII diagrams, DDL dumps) to skip. */
function isNoise(p: string): boolean {
  if (/[─│┌┐└┘╔╗╚╝║═▼◄►✕✓⌧ⓘ●▪◦✅☑✔]/.test(p)) return true; // box-drawing / diagram / checkbox glyphs
  if (/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(p)) return true; // emoji
  if ((p.match(/[→←⇒]/g)?.length ?? 0) >= 2) return true; // flow-diagram arrows
  if (/·\s*Feature Spec\s*\d+/i.test(p)) return true; // repeated running footer from the PDF
  const schemaHits = (p.match(/VARCHAR|NOT NULL|SERIAL|TIMESTAMP|BYTEA|JSONB|\bPK\b|\bFK\b|CHECK in/g) ?? [])
    .length;
  if (schemaHits >= 3) return true;
  const tokens = p.split(/\s+/).length;
  const words = (p.toLowerCase().match(/\b[a-z]{3,}\b/g) ?? []).length;
  if (p.length > 120 && words / Math.max(1, tokens) < 0.4) return true; // symbol/number heavy
  return false;
}

/** Split raw content into cleaned prose paragraphs (blank-line separated). */
export function splitParagraphs(content: string): string[] {
  const blocks = content
    .replace(/\r\n/g, "\n")
    .split(/\n{2,}/)
    .map((b) => b.replace(/[ \t]*\n[ \t]*/g, " ").replace(/\s+/g, " ").trim())
    .filter((b) => b.length > 0 && !isNoise(b));

  // Merge very short fragments into the previous paragraph so headings/labels
  // don't become their own "paragraphs".
  const merged: string[] = [];
  for (const b of blocks) {
    if (b.length < 40 && merged.length > 0) merged[merged.length - 1] += " " + b;
    else merged.push(b);
  }
  return merged;
}

/** Split text into sentences (regex-based; long segments are broken further). */
export function splitSentences(text: string): string[] {
  const rough = text
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+(?=[A-Z0-9"'(])/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  // Break any over-long "sentence" (common when tables flatten into one blob)
  // on semicolons/commas so extractive summarization has real units and output
  // paragraphs don't become walls of text.
  const MAX = 320;
  const out: string[] = [];
  for (const s of rough) {
    if (s.length <= MAX) {
      out.push(s);
      continue;
    }
    let parts = s.split(/;\s+/);
    if (parts.some((p) => p.length > MAX)) parts = s.split(/,\s+/);
    let buf = "";
    for (const p of parts) {
      if ((buf + " " + p).trim().length > MAX && buf) {
        out.push(buf.trim());
        buf = p;
      } else {
        buf = buf ? `${buf}, ${p}` : p;
      }
    }
    if (buf.trim()) out.push(buf.trim());
  }
  return out;
}

const STOPWORDS = new Set(
  ("a an the and or but if then else for to of in on at by with from as is are was were be been being " +
    "this that these those it its they them their we you your our i he she his her not no do does did " +
    "will would can could should may might must have has had also more most such than which who whom " +
    "into over under about above below between per via etc")
    .split(" ")
);

function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9][a-z0-9'-]*/g) ?? []).filter(
    (t) => t.length > 2 && !STOPWORDS.has(t)
  );
}

// ---- Extractive summarization (TF-IDF centroid) -----------------------------

/**
 * Pick the most central sentences via TF-IDF cosine similarity to the document
 * centroid, returned in their original order. A classical, dependency-free
 * summarizer used for the synthesized sections and to condense long buckets.
 */
export function extractiveSummary(text: string, maxSentences: number): string[] {
  const sentences = splitSentences(text);
  if (sentences.length <= maxSentences) return sentences;

  const docs = sentences.map(tokenize);
  const df = new Map<string, number>();
  for (const toks of docs) {
    for (const t of new Set(toks)) df.set(t, (df.get(t) ?? 0) + 1);
  }
  const N = docs.length;
  const idf = (t: string) => Math.log(1 + N / (1 + (df.get(t) ?? 0)));

  // TF-IDF vector per sentence.
  const vectors = docs.map((toks) => {
    const tf = new Map<string, number>();
    for (const t of toks) tf.set(t, (tf.get(t) ?? 0) + 1);
    const vec = new Map<string, number>();
    for (const [t, c] of tf) vec.set(t, (c / toks.length) * idf(t));
    return vec;
  });

  // Centroid = mean of all sentence vectors.
  const centroid = new Map<string, number>();
  for (const vec of vectors) {
    for (const [t, w] of vec) centroid.set(t, (centroid.get(t) ?? 0) + w / N);
  }

  const cosine = (a: Map<string, number>, b: Map<string, number>) => {
    let dot = 0;
    for (const [t, w] of a) dot += w * (b.get(t) ?? 0);
    const na = Math.sqrt([...a.values()].reduce((s, w) => s + w * w, 0));
    const nb = Math.sqrt([...b.values()].reduce((s, w) => s + w * w, 0));
    return na && nb ? dot / (na * nb) : 0;
  };

  const scored = vectors.map((vec, i) => ({ i, score: cosine(vec, centroid) }));
  const keep = new Set(
    scored
      .sort((a, b) => b.score - a.score)
      .slice(0, maxSentences)
      .map((s) => s.i)
  );
  return sentences.filter((_, i) => keep.has(i));
}

/** Group sentences into readable paragraphs of ~`per` sentences each. */
function toParagraphs(sentences: string[], per = 4): string[] {
  const out: string[] = [];
  for (let i = 0; i < sentences.length; i += per) {
    out.push(sentences.slice(i, i + per).join(" "));
  }
  return out;
}

/** Condense a bucket of paragraphs into readable prose paragraphs. */
function condense(paragraphs: string[], maxSentences: number): string[] {
  const joined = paragraphs.join(" ");
  const sentences = extractiveSummary(joined, maxSentences);
  return toParagraphs(sentences);
}

// ---- Assembly ---------------------------------------------------------------

/**
 * Turn source content into a StructuredDoc using the supplied classifier for
 * routing. Introduction / Executive Summary / Conclusion are always present and
 * synthesized via extractive summarization; the optional body sections appear
 * only when the classifier routed content to them.
 */
export async function assemble(
  input: { title: string; version: string; ownerName: string; ownerEmail: string; content: string },
  classifier: ParagraphClassifier
): Promise<StructuredDoc> {
  const paragraphs = splitParagraphs(input.content);
  const whole = paragraphs.join(" ");

  // Route every paragraph; "other" folds into Description of Work so no
  // substantive content is dropped.
  const labels = paragraphs.length ? await classifier.classify(paragraphs) : [];
  const buckets: Record<BodyLabel, string[]> = {
    problem: [],
    scope: [],
    description: [],
    manual: [],
    next: [],
    other: [],
  };
  paragraphs.forEach((p, i) => buckets[labels[i] ?? "other"].push(p));
  buckets.description.push(...buckets.other);
  buckets.other = [];

  const sections: StructuredSection[] = [];
  const push = (heading: string, paras: string[], bullets?: string[]) => {
    if (paras.length === 0 && (!bullets || bullets.length === 0)) return;
    sections.push({ number: "", heading, paragraphs: paras, bullets });
  };

  // Introduction — a short, factual framing drawn from the most central sentences.
  const introSentences = extractiveSummary(whole, 2);
  push("Introduction", [
    `This document presents a standardized summary of "${input.title}".`,
    ...(introSentences.length ? [introSentences.join(" ")] : []),
  ]);

  // Executive Summary — the document's key points as prose + bullets.
  const execSentences = extractiveSummary(whole, 6);
  push(
    "Executive Summary",
    toParagraphs(execSentences.slice(0, 3)),
    execSentences.slice(3).length ? execSentences.slice(3) : undefined
  );

  // Optional body sections in canonical order (Conclusion is inserted mid-order).
  for (const { label, heading } of BODY_ORDER) {
    if (label === "manual" || label === "next") continue; // placed after Conclusion
    if (buckets[label].length) push(heading, condense(buckets[label], 8));
  }

  // Conclusion — synthesized from the concluding portion of the document.
  const tail = paragraphs.slice(Math.floor(paragraphs.length * 0.66)).join(" ") || whole;
  const conclusionSentences = extractiveSummary(tail, 3);
  push("Conclusion", [
    conclusionSentences.length
      ? conclusionSentences.join(" ")
      : "The source content has been reorganized into the Tartigrade standard report format.",
  ]);

  // Operating Manual and Next Steps come after the Conclusion.
  if (buckets.manual.length) push("Operating Manual", condense(buckets.manual, 8));
  if (buckets.next.length) push("Next Steps", condense(buckets.next, 6));

  // Number sequentially over whatever was included.
  sections.forEach((s, i) => (s.number = String(i + 1)));

  return {
    title: input.title,
    version: input.version,
    ownerName: input.ownerName,
    ownerEmail: input.ownerEmail,
    sections,
  };
}
