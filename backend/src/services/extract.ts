/**
 * extract.ts
 * ----------
 * Turns an uploaded file (any supported format) into plain text so the
 * structuring stage can work format-agnostically. Mirrors the coverage of the
 * existing summary-generator / excel-summary-generator skills:
 *   - .docx            -> mammoth
 *   - .pdf             -> pdfjs-dist
 *   - .xlsx/.xls/.csv  -> SheetJS (every tab, in tab order)
 *   - .txt/.md/others  -> utf-8 text
 */

import mammoth from "mammoth";
import * as XLSX from "xlsx";

export interface ExtractResult {
  text: string;
  detectedType: string;
}

function ext(filename: string): string {
  const i = filename.lastIndexOf(".");
  return i >= 0 ? filename.slice(i + 1).toLowerCase() : "";
}

async function extractDocx(buffer: Buffer): Promise<string> {
  const { value } = await mammoth.extractRawText({ buffer });
  return value;
}

// tsc rewrites a literal `await import(...)` into `require(...)` when
// targeting CommonJS, which throws ERR_REQUIRE_ESM for a real ESM-only
// package like pdfjs-dist. Building the import call at runtime (invisible
// to tsc's static transform) keeps it a genuine dynamic import.
const dynamicImport = new Function("specifier", "return import(specifier)") as (
  specifier: string
) => Promise<typeof import("pdfjs-dist/legacy/build/pdf.mjs")>;

/**
 * pdfjs-dist is ESM-only (no CJS build), so it's imported dynamically even
 * though this file is CommonJS. Using pdfjs-dist directly instead of the
 * unmaintained `pdf-parse` package matters: pdf-parse bundles its own copy
 * of pdf.js frozen at v1.9–v2.0 (2017-2018), which chokes on how some modern
 * PDF producers embed fonts (symptom: a bare "unsupported Unicode escape
 * sequence" crash with no page number, alongside "TT: undefined function"
 * font-hinting warnings). pdfjs-dist is actively maintained and handles
 * these cases; font rendering itself is disabled since we only need text.
 */
async function extractPdf(buffer: Buffer): Promise<string> {
  const pdfjsLib = await dynamicImport("pdfjs-dist/legacy/build/pdf.mjs");
  const loadingTask = pdfjsLib.getDocument({
    data: new Uint8Array(buffer),
    disableFontFace: true,
    useSystemFonts: false,
    verbosity: 0,
  });

  try {
    const doc = await loadingTask.promise;
    let text = "";
    for (let i = 1; i <= doc.numPages; i++) {
      try {
        const page = await doc.getPage(i);
        const content = await page.getTextContent();
        let lastY: number | null = null;
        for (const item of content.items as Array<{ str: string; transform: number[] }>) {
          const y = item.transform?.[5] ?? null;
          if (lastY !== null && y !== lastY) text += "\n";
          text += item.str;
          lastY = y;
        }
        text += "\n\n";
      } catch {
        // One corrupted/unsupported page (bad embedded font, malformed
        // content stream, ...) should not take down the whole document —
        // skip it and keep every other page's text.
      }
    }
    return text;
  } finally {
    await loadingTask.destroy();
  }
}

/**
 * Strip characters that are valid in a JS string but not safe downstream:
 * a NUL byte or other C0 control character embedded in extracted text is
 * a very common artifact of a corrupted/subsetted font (a glyph that fails
 * to map to a real Unicode codepoint often resolves to U+0000). JSON.stringify
 * happily encodes that as a literal \u0000 escape — perfectly valid per the
 * JSON spec — but PostgreSQL's `jsonb` type rejects it outright with
 * "unsupported Unicode escape sequence", which is what actually failed here
 * (downstream of extraction, when saving structured_json — not extraction
 * itself, which is why swapping the PDF library alone didn't change the
 * error). Unpaired UTF-16 surrogates (another common PDF/font artifact) are
 * replaced with U+FFFD for the same reason: valid JS string content, but
 * invalid UTF-8 once encoded, which breaks JSON/XML consumers downstream.
 */
function sanitizeText(text: string): string {
  return text
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "") // C0 controls except \t \n \r
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/g, "\uFFFD") // unpaired high surrogate
    .replace(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "\uFFFD"); // unpaired low surrogate
}

function extractSpreadsheet(buffer: Buffer): string {
  const wb = XLSX.read(buffer, { type: "buffer" });
  const parts: string[] = [];
  // Tab order is the order SheetNames is given by the file (left-to-right).
  for (const name of wb.SheetNames) {
    const sheet = wb.Sheets[name];
    const csv = XLSX.utils.sheet_to_csv(sheet, { blankrows: false });
    if (csv.trim().length === 0) {
      parts.push(`--- Tab: ${name} (empty) ---`);
    } else {
      parts.push(`--- Tab: ${name} ---\n${csv}`);
    }
  }
  return parts.join("\n\n");
}

export async function extractContent(
  buffer: Buffer,
  filename: string
): Promise<ExtractResult> {
  const e = ext(filename);
  const result = await (async (): Promise<ExtractResult> => {
    switch (e) {
      case "docx":
        return { text: await extractDocx(buffer), detectedType: "docx" };
      case "pdf":
        return { text: await extractPdf(buffer), detectedType: "pdf" };
      case "xlsx":
      case "xlsm":
      case "xls":
      case "csv":
      case "tsv":
        return { text: extractSpreadsheet(buffer), detectedType: e };
      case "txt":
      case "md":
      case "markdown":
      case "json":
        return { text: buffer.toString("utf-8"), detectedType: e || "txt" };
      default:
        // Best-effort: treat unknown types as utf-8 text.
        return { text: buffer.toString("utf-8"), detectedType: e || "unknown" };
    }
  })();
  return { ...result, text: sanitizeText(result.text) };
}

export const SUPPORTED_EXTENSIONS = [
  "docx",
  "pdf",
  "xlsx",
  "xlsm",
  "xls",
  "csv",
  "tsv",
  "txt",
  "md",
  "markdown",
  "json",
];
