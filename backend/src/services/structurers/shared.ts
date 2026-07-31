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

import type { StructuredDoc, StructuredSection, StructuredSubsection } from "../renderTtgDocx";
import { detectHeadings, detectLeadingHeading, MIN_HEADINGS_FOR_STRUCTURE } from "./headings";

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

/**
 * Detect a single NOISE LINE (a line of a diagram, table row, DDL, or
 * page furniture) so it can be dropped without discarding the real prose
 * around it.
 *
 * This used to run on whole blank-line-delimited blocks. On PDF-extracted
 * text, blank lines are sparse (often only at page breaks), so an entire
 * page could end up as a single block — one embedded ASCII diagram or table
 * row anywhere in it flagged the WHOLE block as noise and threw away every
 * real paragraph along with it. Scoping the check to individual lines means
 * only the diagram/table line itself is dropped; the prose around it
 * survives as its own paragraph.
 */
function isNoiseLine(line: string): boolean {
  if (/[─│┌┐└┘╔╗╚╝║═▼◄►✕✓⌧ⓘ●▪◦✅☑✔]/.test(line)) return true; // box-drawing / diagram / checkbox glyphs
  if (/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(line)) return true; // emoji
  if ((line.match(/[→←⇒]/g)?.length ?? 0) >= 2) return true; // flow-diagram arrows
  if (/·\s*Feature Spec\s*\d+/i.test(line)) return true; // repeated running footer from the PDF
  if (/^\d{1,4}$/.test(line.trim())) return true; // a bare page-number line
  const schemaHits = (line.match(/VARCHAR|NOT NULL|SERIAL|TIMESTAMP|BYTEA|JSONB|\bPK\b|\bFK\b|CHECK in/g) ?? [])
    .length;
  if (schemaHits >= 2) return true; // a single line with 2+ schema tokens is a DDL/table row, not prose
  const tokens = line.split(/\s+/).length;
  const words = (line.toLowerCase().match(/\b[a-z]{3,}\b/g) ?? []).length;
  if (line.length > 60 && words / Math.max(1, tokens) < 0.4) return true; // symbol/number heavy
  if (hasSquishedTableTokens(line)) return true;
  return false;
}

/**
 * A table row that lost its inter-cell spacing on PDF extraction reads as
 * run-on "wordWord" joins — e.g. "Action | What archives" becomes
 * "ActionWhat", "Folder moves to | Access" becomes "toAccess". A lowercase
 * letter directly followed by an uppercase letter that itself continues in
 * lowercase is essentially never legitimate prose — it's deliberately NOT
 * triggered by an acronym tail like "SQL" in "PostgreSQL" (there the letter
 * after the capital is another capital, not lowercase), so ordinary
 * technical prose survives.
 */
function hasSquishedTableTokens(line: string): boolean {
  const tokens = line.split(/\s+/);
  // A full prose sentence occasionally contains one compound technical term
  // (e.g. "...the app (ProjectManagementApplication) is..." or "a CronJob
  // picks up...") — that's still a normal sentence with many words around
  // it. A table row/cell that lost its spacing is short: a handful of
  // tokens, often just one. Only treat the join as noise when the line is
  // short enough to plausibly BE a table fragment.
  if (tokens.length <= 10 && /[a-z][A-Z][a-z]/.test(line)) return true;
  for (const token of tokens) {
    const schemaSubHits = (
      token.match(/VARCHAR|SERIAL|TIMESTAMP|BYTEA|JSONB|UNIQUE|DEFAULT|NOTNULL/gi) ?? []
    ).length;
    if (schemaSubHits >= 2) return true;
  }
  return false;
}

/**
 * Split raw content into cleaned prose paragraphs. Noise LINES (diagrams,
 * table rows, page numbers, running headers/footers) are dropped and act as
 * paragraph breaks, same as a blank line — real content on either side of a
 * dropped line is kept as its own paragraph rather than glued together.
 */
export function splitParagraphs(content: string): string[] {
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  const blocks: string[] = [];
  let current: string[] = [];
  const flush = () => {
    if (current.length) {
      const block = current.join(" ").replace(/\s+/g, " ").trim();
      if (block) blocks.push(block);
      current = [];
    }
  };
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || isNoiseLine(line)) {
      flush();
      continue;
    }
    current.push(line);
  }
  flush();

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
export function condense(paragraphs: string[], maxSentences: number): string[] {
  const joined = paragraphs.join(" ");
  const sentences = extractiveSummary(joined, maxSentences);
  return toParagraphs(sentences);
}

// ---- Assembly (structure-preserving path) -----------------------------------

/** Condense a raw line-range of source text into paragraphs for one section/subsection. */
function paragraphsForSlice(lines: string[], start: number, end: number): string[] {
  const raw = lines.slice(start, end).join("\n");
  const paras = splitParagraphs(raw);
  if (!paras.length) return [];
  const totalSentences = splitSentences(paras.join(" ")).length;
  return totalSentences > 9 ? condense(paras, 8) : paras;
}

/**
 * Build a StructuredDoc directly from headings already present in the source
 * (e.g. a PDF that already has "1. Core concepts...", "3.1 \"Create a new
 * team\"", ...). Each section/subsection keeps its own heading text and gets
 * its own slice of source content condensed independently, instead of every
 * paragraph being pooled and forced through the generic Introduction /
 * Executive Summary / Conclusion template.
 */
function assembleFromHeadings(
  input: { title: string; version: string; ownerName: string; ownerEmail: string; content: string },
  headings: ReturnType<typeof detectHeadings>
): StructuredDoc {
  const lines = input.content.replace(/\r\n/g, "\n").split("\n");
  const tops = headings.filter((h) => h.level === 1).sort((a, b) => a.lineIndex - b.lineIndex);
  const subs = headings.filter((h) => h.level === 2).sort((a, b) => a.lineIndex - b.lineIndex);

  const sections: StructuredSection[] = [];

  // Preamble — any content before the first detected top-level heading
  // (e.g. the reference spec's unnumbered "Background" section). Start from
  // the detected heading line itself, not line 0 — otherwise the cover-page
  // text (company name/address/title/version — already on the title page)
  // gets pulled in as duplicate content.
  const preambleLines = lines.slice(0, tops[0].lineIndex);
  const preambleHeading = detectLeadingHeading(preambleLines.join("\n"));
  const preambleStart = preambleHeading
    ? preambleLines.findIndex((l) => l.trim() === preambleHeading) + 1
    : 0;
  const preambleParas = paragraphsForSlice(lines, preambleStart, tops[0].lineIndex);
  if (preambleParas.length) {
    sections.push({ number: "", heading: preambleHeading ?? "Introduction", paragraphs: preambleParas });
  }

  tops.forEach((top, ti) => {
    const nextTopLine = tops[ti + 1]?.lineIndex ?? lines.length;
    const ownSubs = subs
      .filter((s) => s.lineIndex > top.lineIndex && s.lineIndex < nextTopLine)
      .sort((a, b) => a.lineIndex - b.lineIndex);

    const directEnd = ownSubs.length ? ownSubs[0].lineIndex : nextTopLine;
    const directParas = paragraphsForSlice(lines, top.lineIndex + 1, directEnd);

    const subsections: StructuredSubsection[] = ownSubs.map((sub, si) => {
      const subEnd = ownSubs[si + 1]?.lineIndex ?? nextTopLine;
      return {
        number: "",
        heading: sub.heading,
        paragraphs: paragraphsForSlice(lines, sub.lineIndex + 1, subEnd),
      };
    });

    // Skip a top-level heading that ended up with no content at all (rare,
    // but possible if every line under it was noise).
    if (directParas.length === 0 && subsections.every((s) => s.paragraphs.length === 0)) return;

    sections.push({
      number: "",
      heading: top.heading,
      paragraphs: directParas,
      subsections: subsections.length ? subsections : undefined,
    });
  });

  // Number sequentially — real headings, renumbered cleanly regardless of
  // whether every original heading survived (e.g. a section with no content).
  sections.forEach((s, i) => {
    s.number = String(i + 1);
    s.subsections?.forEach((sub, j) => (sub.number = `${s.number}.${j + 1}`));
  });

  return {
    title: input.title,
    version: input.version,
    ownerName: input.ownerName,
    ownerEmail: input.ownerEmail,
    sections,
  };
}

// ---- Assembly (generic template path) ---------------------------------------

/**
 * Turn source content into a StructuredDoc. If the source already has real
 * numbered section headings (a spec, a report with its own structure), that
 * structure is preserved as-is (see assembleFromHeadings). Otherwise, every
 * paragraph is routed through the supplied classifier into the generic
 * Introduction / Executive Summary / Conclusion template — the right
 * behavior for unstructured input like notes or a rough draft.
 */
export async function assemble(
  input: { title: string; version: string; ownerName: string; ownerEmail: string; content: string },
  classifier: ParagraphClassifier
): Promise<StructuredDoc> {
  const headings = detectHeadings(input.content);
  const topHeadingCount = headings.filter((h) => h.level === 1).length;
  if (topHeadingCount >= MIN_HEADINGS_FOR_STRUCTURE) {
    return assembleFromHeadings(input, headings);
  }

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
