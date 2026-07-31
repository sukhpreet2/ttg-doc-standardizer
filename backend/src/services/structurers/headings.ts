/**
 * structurers/headings.ts
 * ------------------------
 * Detects pre-existing numbered section headings in source content (e.g. a
 * PDF that already has "1. Core concepts & principles", "3.1 \"Create a new
 * team\"", ... "13. Access control") so that structure can be PRESERVED
 * instead of every paragraph being routed through the generic
 * Introduction/Executive Summary/Conclusion template.
 *
 * A numbered heading line is syntactically identical to a numbered line in
 * a Table of Contents, or to an ordinary numbered list inside a paragraph
 * ("1. Revoke all their permissions. 2. Suspend the account. ..."). Both of
 * those appear as a run of several such lines back-to-back with no prose in
 * between — a real heading never does, since it's always followed by body
 * text before the next heading. So: any run of 3+ consecutive
 * heading-shaped lines is treated as a listing (TOC or in-prose list) and
 * excluded; everything else is treated as a real heading.
 */

export interface DetectedHeading {
  number: string; // "1" or "3.1"
  heading: string;
  level: 1 | 2;
  lineIndex: number;
}

const TOP_RE = /^(\d{1,2})\.\s+(.{2,100})$/;
const SUB_RE = /^(\d{1,2}\.\d{1,2})\s+(.{2,100})$/;

/** Find the real (non-TOC, non-list) numbered headings in raw source text. */
export function detectHeadings(rawText: string): DetectedHeading[] {
  const lines = rawText.replace(/\r\n/g, "\n").split("\n");

  type Candidate = { i: number; number: string; heading: string; level: 1 | 2 };
  const candidates: Candidate[] = [];
  lines.forEach((rawLine, i) => {
    const line = rawLine.trim();
    if (!line) return;
    const sub = line.match(SUB_RE);
    if (sub) {
      candidates.push({ i, number: sub[1], heading: sub[2].trim(), level: 2 });
      return;
    }
    const top = line.match(TOP_RE);
    if (top) {
      candidates.push({ i, number: top[1], heading: top[2].trim(), level: 1 });
    }
  });

  // Exclude runs of 3+ candidates on consecutive lines (TOC blocks, or a
  // numbered list embedded in prose) — a real heading is always followed by
  // body text, not immediately by the next heading.
  const excluded = new Set<number>();
  let runStart = 0;
  for (let k = 1; k <= candidates.length; k++) {
    const brokeRun = k === candidates.length || candidates[k].i !== candidates[k - 1].i + 1;
    if (brokeRun) {
      if (k - runStart >= 3) {
        for (let j = runStart; j < k; j++) excluded.add(j);
      }
      runStart = k;
    }
  }

  const survivors = candidates.filter((_, idx) => !excluded.has(idx));

  // Among the survivors, real section headings form the longest run of
  // sequential numbers (1, 2, 3, ... N) in document order. A short numbered
  // list embedded in prose ("1. Group = information only... 2. Access is
  // flat...") is too short a run to be caught by the exclusion above, but it
  // won't continue to 3, 4, 5... — so it loses out to the real chain here.
  const tops = survivors
    .map((c, idx) => ({ ...c, idx }))
    .filter((c) => c.level === 1);
  const dp = tops.map(() => 1);
  const parent = tops.map(() => -1);
  for (let i = 0; i < tops.length; i++) {
    const want = Number(tops[i].number) - 1;
    let best = 0;
    let bestJ = -1;
    for (let j = 0; j < i; j++) {
      if (Number(tops[j].number) === want && dp[j] >= best) {
        best = dp[j];
        bestJ = j;
      }
    }
    if (bestJ >= 0) {
      dp[i] = best + 1;
      parent[i] = bestJ;
    }
  }
  let chainEnd = 0;
  for (let i = 1; i < tops.length; i++) if (dp[i] > dp[chainEnd]) chainEnd = i;
  const realTopIdx = new Set<number>();
  for (let i = tops.length ? chainEnd : -1; i >= 0; i = parent[i]) realTopIdx.add(tops[i].idx);

  return survivors
    .filter((c, idx) => c.level === 2 || realTopIdx.has(idx))
    .map((c) => ({ number: c.number, heading: c.heading, level: c.level, lineIndex: c.i }));
}

/**
 * A short standalone line before the first real heading (e.g. "Background")
 * — used as that leading section's title instead of a generic "Introduction".
 */
export function detectLeadingHeading(preambleText: string): string | null {
  const lines = preambleText
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  let found: string | null = null;
  for (let i = 0; i < lines.length - 1; i++) {
    const line = lines[i];
    const next = lines[i + 1];
    // A real section heading is a short label immediately followed by a real
    // sentence of body prose. Take the LAST such match — cover-page lines
    // (company name, address fragments) match the "short label" shape too,
    // but they're followed by more short lines, not prose.
    if (line.length <= 40 && !/[.!?:]$/.test(line) && /^[A-Z]/.test(line) && next.length > 60) {
      found = line;
    }
  }
  return found;
}

/** Minimum number of real top-level headings before we trust this as a pre-structured document. */
export const MIN_HEADINGS_FOR_STRUCTURE = 3;
