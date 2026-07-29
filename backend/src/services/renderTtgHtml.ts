/**
 * renderTtgHtml.ts
 * ----------------
 * Renders a StructuredDoc as a self-contained HTML page for the "View in
 * browser" feature. It does NOT convert the generated .docx (docx->HTML
 * conversion loses direct formatting like brand colors/sizes); instead it
 * renders the same StructuredDoc straight to HTML/CSS, importing its colors,
 * fonts, and sizes from renderTtgDocx.ts so the two outputs can never drift
 * apart — one set of brand constants, two renderers.
 *
 * The result mimics the printed TTG standard closely enough to review the
 * document at a glance (title page, TOC, numbered green headings, bullets)
 * without needing Word or a document converter installed on the server.
 */

import { GREEN, BLACK, FONT, SIZE, COMPANY, type StructuredDoc } from "./renderTtgDocx";
import { TTG_LOGO_PNG_BASE64 } from "../assets/logo";

// half-point docx sizes -> CSS pt
const pt = (halfPoints: number) => halfPoints / 2;

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function slugAnchor(number: string): string {
  return `sec-${number.replace(/[^0-9]/g, "-")}`;
}

function tocHtml(doc: StructuredDoc): string {
  const entry = (number: string, heading: string, indent: boolean) => `
    <div class="toc-entry${indent ? " toc-sub" : ""}">
      <a href="#${slugAnchor(number)}">${escapeHtml(number)}. ${escapeHtml(heading)}</a>
    </div>`;

  const rows = doc.sections
    .map((s) => {
      const subs = (s.subsections ?? []).map((sub) => entry(sub.number, sub.heading, true)).join("");
      return entry(s.number, s.heading, false) + subs;
    })
    .join("");

  return `<div class="toc"><div class="toc-title">Table of Contents</div>${rows}</div>`;
}

function paragraphsHtml(paragraphs: string[], bullets?: string[]): string {
  const p = paragraphs.map((t) => `<p>${escapeHtml(t)}</p>`).join("");
  const b = bullets && bullets.length ? `<ul>${bullets.map((t) => `<li>${escapeHtml(t)}</li>`).join("")}</ul>` : "";
  return p + b;
}

function sectionsHtml(doc: StructuredDoc): string {
  return doc.sections
    .map((s) => {
      const sub = (s.subsections ?? [])
        .map(
          (sub) => `
        <h2 id="${slugAnchor(sub.number)}">${escapeHtml(sub.number)}. ${escapeHtml(sub.heading)}</h2>
        ${paragraphsHtml(sub.paragraphs, sub.bullets)}`
        )
        .join("");
      return `
      <h1 id="${slugAnchor(s.number)}">${escapeHtml(s.number)}. ${escapeHtml(s.heading)}</h1>
      ${paragraphsHtml(s.paragraphs, s.bullets)}
      ${sub}`;
    })
    .join("");
}

export function renderTtgHtml(doc: StructuredDoc, filename: string): string {
  const addressLines = COMPANY.address.map((l) => `<div>${escapeHtml(l)}</div>`).join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>${escapeHtml(doc.title)} — Preview</title>
<style>
  :root {
    --green: #${GREEN};
    --black: #${BLACK};
    --font: "${FONT}", "Calibri Light", Candara, Segoe, Optima, sans-serif;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    background: #6b7280;
    font-family: var(--font);
    color: var(--black);
  }
  .toolbar {
    position: sticky;
    top: 0;
    z-index: 10;
    background: var(--black);
    color: #fff;
    padding: 10px 20px;
    font-size: 13px;
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  .toolbar b { color: var(--green); }
  .toolbar a {
    color: #fff;
    background: var(--green);
    padding: 6px 14px;
    border-radius: 4px;
    text-decoration: none;
    font-weight: 600;
  }
  .page-wrap { padding: 28px 0 60px; }
  .sheet {
    width: 8.5in;
    min-height: 11in;
    margin: 0 auto 28px;
    background: #fff;
    box-shadow: 0 2px 10px rgba(0,0,0,0.35);
    padding: 1in;
    position: relative;
  }
  .header-row {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    margin-bottom: 48px;
  }
  .header-row img { width: 130px; height: auto; }
  .address {
    text-align: right;
    font-size: ${pt(SIZE.headerAddress)}pt;
    line-height: 1.35;
  }
  .address .company { color: var(--green); font-weight: 700; }
  .title-page { text-align: right; margin-top: 60px; }
  .title-page .company-name {
    color: var(--green);
    font-size: ${pt(SIZE.titleBig)}pt;
    font-weight: 400;
    line-height: 1.15;
  }
  .title-page .doc-title {
    font-size: ${pt(SIZE.titleBig)}pt;
    line-height: 1.15;
    margin-bottom: 34px;
  }
  .title-page .label {
    color: var(--green);
    font-size: ${pt(SIZE.titleLabel)}pt;
    margin-top: 14px;
  }
  .title-page .value { font-size: ${pt(SIZE.body)}pt; }

  .running-header {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    font-size: ${pt(SIZE.runningHeader)}pt;
    border-bottom: 1px solid #d9d9d9;
    padding-bottom: 6px;
    margin-bottom: 28px;
  }
  .running-header .mark { color: var(--green); }

  .toc-title {
    color: var(--green);
    font-weight: 700;
    font-size: ${pt(SIZE.heading)}pt;
    margin-bottom: 16px;
  }
  .toc-entry {
    display: flex;
    align-items: baseline;
    font-size: ${pt(SIZE.body)}pt;
    margin-bottom: 6px;
  }
  .toc-entry.toc-sub { margin-left: 26px; }
  .toc-entry a {
    color: var(--black);
    text-decoration: none;
    border-bottom: 1px dotted #999;
    flex: 1;
    padding-bottom: 1px;
  }
  .toc-entry a:hover { color: var(--green); }

  .content h1 {
    color: var(--green);
    font-size: ${pt(SIZE.heading)}pt;
    font-weight: 700;
    margin: 28px 0 12px;
  }
  .content h2 {
    color: var(--green);
    font-size: ${pt(SIZE.heading)}pt;
    font-weight: 700;
    margin: 22px 0 10px;
  }
  .content p {
    font-size: ${pt(SIZE.body)}pt;
    line-height: 1.5;
    margin: 0 0 12px;
  }
  .content ul {
    font-size: ${pt(SIZE.body)}pt;
    margin: 0 0 12px;
    padding-left: 26px;
  }
  .page-footer {
    text-align: center;
    font-size: ${pt(SIZE.body)}pt;
    color: #666;
    margin-top: 40px;
    padding-top: 10px;
    border-top: 1px solid #eee;
  }
  @media print {
    body { background: #fff; }
    .toolbar { display: none; }
    .sheet { box-shadow: none; margin: 0 auto; }
  }
</style>
</head>
<body>
  <div class="toolbar">
    <span>Preview — <b>${escapeHtml(doc.title)}</b></span>
    <a href="download">Download .docx</a>
  </div>
  <div class="page-wrap">
    <!-- Title page -->
    <div class="sheet">
      <div class="header-row">
        <img src="data:image/png;base64,${TTG_LOGO_PNG_BASE64}" alt="Tartigrade" />
        <div class="address">
          <div class="company">${escapeHtml(COMPANY.name)}</div>
          ${addressLines}
        </div>
      </div>
      <div class="title-page">
        <div class="company-name">${escapeHtml(COMPANY.name)}</div>
        <div class="doc-title">${escapeHtml(doc.title)}</div>
        <div class="label">Document Version</div>
        <div class="value">${escapeHtml(doc.version)}</div>
        <div class="label">Document Owner</div>
        <div class="value">${escapeHtml(doc.ownerName)}</div>
        <div class="value">${escapeHtml(doc.ownerEmail)}</div>
      </div>
    </div>

    <!-- TOC + body -->
    <div class="sheet">
      <div class="running-header">
        <span>${escapeHtml(doc.title)}</span>
        <span class="mark">&#9679;</span>
      </div>
      ${tocHtml(doc)}
      <div class="content">
        ${sectionsHtml(doc)}
      </div>
      <div class="page-footer">Tartigrade (TTG) — standardized document preview</div>
    </div>
  </div>
</body>
</html>`;
}
