/**
 * renderTtgDocx.ts
 * -----------------
 * The heart of the standardizer. Takes a StructuredDoc (title/version/owner +
 * numbered sections) and produces a .docx that matches Tartigrade's exact report
 * standard, calibrated pixel-for-pixel against the reference template
 * ("Talent <-> Connect Bridge — Employee Onboarding Feature Spec"):
 *
 *   - Font:            Calibri throughout; Consolas for inline code / code blocks
 *   - Brand green:     #5AA66A — labels, bullets, numbering & branding ONLY
 *                      (never body prose/values)
 *   - Body text:       11pt (size 22), near-black (#111111)
 *   - Headings H1:     14pt (size 28), bold, near-black, numbered "N. Heading"
 *   - Headings H2-H4:  14pt (size 28), bold, near-black, numbered "N.N Heading"
 *                      (no trailing period on sub-numbers)
 *   - Running header:  small (9pt) gray title, left; small brand mark, right;
 *                       thin rule beneath — non-title pages only
 *   - Title page:      right-aligned address block + big title + Document
 *                       Version / Document Owners / Date, + decorative dot
 *                       mark bottom-left
 *   - Footer:          page number only, right-aligned, small gray — hidden on
 *                       title page
 *   - Page:            US Letter (12240 x 15840 DXA), 1" margins (1440 DXA)
 *
 * The spec lives in ttg_report_generator SKILL.md; this is its programmatic form.
 */

import {
  Document,
  Packer,
  Paragraph,
  TextRun,
  HeadingLevel,
  AlignmentType,
  PageNumber,
  Header,
  Footer,
  Bookmark,
  InternalHyperlink,
  SimpleField,
  TabStopType,
  TabStopPosition,
  LeaderType,
  LevelFormat,
  convertInchesToTwip,
  ImageRun,
  Table,
  TableRow,
  TableCell,
  WidthType,
  BorderStyle,
  VerticalAlign,
  HorizontalPositionAlign,
  HorizontalPositionRelativeFrom,
  VerticalPositionAlign,
  VerticalPositionRelativeFrom,
  TextWrappingType,
  TextWrappingSide,
} from "docx";
import JSZip from "jszip";
import { TTG_LOGO_PNG, TTG_LOGO_WIDTH, TTG_LOGO_HEIGHT } from "../assets/logo";
import { TTG_DOTS_PNG, TTG_DOTS_WIDTH, TTG_DOTS_HEIGHT } from "../assets/dots";

// ---- Brand constants (single source of truth) -------------------------------
// Calibrated against the reference PDF by sampling actual pixel colors —
// do not "round" these back to generic brand-guide values without re-checking.

const GREEN = "5AA66A"; // labels, bullets, list numbers, branding — never body text
const TEXT = "111111"; // near-black body/heading text (the doc is not pure #000)
const GRAY = "666666"; // running header title + footer page number
const FONT = "Calibri";
const MONO_FONT = "Consolas"; // inline code spans / code blocks

// half-point sizes (docx uses half-points: 11pt -> 22)
const SIZE = {
  body: 22, // 11pt
  headerAddress: 22, // 11pt (title-page header lines)
  titleBig: 64, // 32pt (company name + doc title on title page)
  titleLabel: 28, // 14pt ("Document Version" / "Document Owners" / "Date")
  runningHeader: 18, // 9pt (doc title in the running page header — small, not a heading)
  footer: 18, // 9pt (page number)
  heading: 28, // 14pt (H1-H4)
};

const COMPANY = {
  name: "Tartigrade Ltd. (TTG)", // as printed in the small header/address block
  brandName: "TARTIGRADE (TTG)", // as printed big + green on the title page
  address: [
    "Suite 5803 - 655 Center St. S,",
    "Calgary, AB, T2G 1S6",
    "Tel : +1 (403) 690-7006",
    "https://tartigrade.ca/",
  ],
};

// ---- Public shape the rest of the app produces ------------------------------

export interface StructuredSubsection {
  number: string; // e.g. "1.1"
  heading: string; // e.g. "Background"
  paragraphs: string[];
  bullets?: string[];
  /** "bullet" (green dot, default) or "number" (green "1." "2." ...) */
  bulletStyle?: "bullet" | "number";
}

export interface StructuredSection {
  number: string; // e.g. "1"
  heading: string; // e.g. "Introduction"
  paragraphs: string[];
  bullets?: string[];
  /** "bullet" (green dot, default) or "number" (green "1." "2." ...) */
  bulletStyle?: "bullet" | "number";
  subsections?: StructuredSubsection[];
}

export interface StructuredDoc {
  title: string;
  version: string;
  ownerName: string;
  ownerTitle?: string; // e.g. "Software Developer" — printed under the owner's name
  ownerEmail: string;
  date: string; // e.g. "2026-07-26" — printed on the title page as "Date"
  sections: StructuredSection[];
}

// ---- Small helpers ----------------------------------------------------------

function run(text: string, opts: { size: number; color?: string; bold?: boolean; font?: string }) {
  return new TextRun({
    text: sanitizeXmlText(text),
    font: opts.font ?? FONT,
    size: opts.size,
    color: opts.color ?? TEXT,
    bold: opts.bold ?? false,
  });
}

/**
 * Split prose on backtick-delimited spans (`` `like this` ``) and render each
 * piece as its own run: plain text stays body-styled, code spans render in
 * green monospace — matching inline file paths / identifiers / routes in the
 * reference document (e.g. "the file `foo.ts`", "`GET /intake`").
 */
function formatRuns(text: string, size: number): TextRun[] {
  const parts = text.split(/(`[^`]+`)/g).filter((p) => p.length > 0);
  if (parts.length <= 1 && !parts[0]?.startsWith("`")) {
    return [run(text, { size })];
  }
  return parts.map((part) => {
    if (part.startsWith("`") && part.endsWith("`") && part.length > 1) {
      return run(part.slice(1, -1), { size, color: GREEN, font: MONO_FONT });
    }
    return run(part, { size });
  });
}

/**
 * Strip characters that are illegal in XML 1.0 (e.g. NUL and other control
 * bytes that PDF/text extraction can leak in). Without this, an otherwise
 * valid run can corrupt word/document.xml.
 */
function sanitizeXmlText(text: string): string {
  // Allowed: tab, LF, CR, and the standard XML character ranges.
  return text.replace(
    /[^\u0009\u000A\u000D\u0020-\uD7FF\uE000-\uFFFD]/g,
    ""
  );
}

/** A body paragraph of plain prose (with inline `code` span support). */
function bodyParagraph(text: string): Paragraph {
  return new Paragraph({
    spacing: { before: 0, after: 120, line: 240 },
    children: formatRuns(text, SIZE.body),
  });
}

/** A single bullet or numbered item using the shared numbering config. */
function bulletParagraph(text: string, style: "bullet" | "number" = "bullet", level = 0): Paragraph {
  return new Paragraph({
    numbering: { reference: style === "number" ? "ttg-numbers" : "ttg-bullets", level },
    spacing: { before: 0, after: 60, line: 240 },
    children: formatRuns(text, SIZE.body),
  });
}

/** Turn a section number like "1.1" into a valid Word bookmark name. */
function bookmarkName(number: string): string {
  return `_ttg_${number.replace(/[^0-9]/g, "_")}`;
}

/**
 * Heading paragraph. Uses a built-in HeadingLevel (for outline/navigation) and
 * carries a Bookmark so the manually-built Table of Contents can hyperlink and
 * PAGEREF to it. The visible text carries our own "1." / "1.1." number so the
 * numbering is deterministic and identical to the TTG standard.
 */
function headingParagraph(
  numberedText: string,
  level: (typeof HeadingLevel)[keyof typeof HeadingLevel],
  number: string
): Paragraph {
  return new Paragraph({
    heading: level,
    spacing: { before: 240, after: 120, line: 240 },
    children: [
      new Bookmark({
        id: bookmarkName(number),
        children: [run(numberedText, { size: SIZE.heading, bold: true, color: TEXT })],
      }),
    ],
  });
}

// ---- Title page -------------------------------------------------------------

/** The decorative spiral of brand-green dots, floating bottom-left, behind the text. */
function titlePageDotMark(): Paragraph {
  const sizePx = 260; // roughly a third of the page height, matching the reference
  return new Paragraph({
    children: [
      new ImageRun({
        data: TTG_DOTS_PNG,
        transformation: { width: sizePx, height: Math.round((sizePx * TTG_DOTS_HEIGHT) / TTG_DOTS_WIDTH) },
        floating: {
          horizontalPosition: { relative: HorizontalPositionRelativeFrom.PAGE, align: HorizontalPositionAlign.LEFT },
          verticalPosition: { relative: VerticalPositionRelativeFrom.PAGE, align: VerticalPositionAlign.BOTTOM },
          wrap: { type: TextWrappingType.NONE, side: TextWrappingSide.BOTH_SIDES },
          behindDocument: true,
        },
      }),
    ],
  });
}

function titlePageChildren(doc: StructuredDoc): Paragraph[] {
  const rightLabel = (text: string) =>
    new Paragraph({
      alignment: AlignmentType.RIGHT,
      spacing: { before: 180, after: 0, line: 240 },
      children: [run(text, { size: SIZE.titleLabel, color: GREEN })],
    });
  const rightValue = (text: string) =>
    new Paragraph({
      alignment: AlignmentType.RIGHT,
      spacing: { before: 0, after: 0, line: 240 },
      children: [run(text, { size: SIZE.body, color: TEXT })],
    });

  return [
    titlePageDotMark(),
    // vertical breathing room so the block sits lower on the page
    new Paragraph({ spacing: { before: 3200, after: 0 }, children: [] }),
    // Company name — green, big (line height must clear 32pt text)
    new Paragraph({
      alignment: AlignmentType.RIGHT,
      spacing: { before: 0, after: 0, line: 760 },
      children: [run(COMPANY.brandName, { size: SIZE.titleBig, color: GREEN })],
    }),
    // Document title value — black, big (no label)
    new Paragraph({
      alignment: AlignmentType.RIGHT,
      spacing: { before: 0, after: 480, line: 760 },
      children: [run(doc.title, { size: SIZE.titleBig, color: TEXT })],
    }),
    rightLabel("Document Version"),
    rightValue(doc.version),
    rightLabel("Document Owners"),
    rightValue(doc.ownerName),
    ...(doc.ownerTitle ? [rightValue(doc.ownerTitle)] : []),
    rightValue(doc.ownerEmail),
    rightLabel("Date"),
    rightValue(doc.date),
  ];
}

// ---- Headers & footers ------------------------------------------------------

/** Title-page header: TTG logo (left) + company/address block (right). */
function titlePageHeader(): Header {
  // Display the logo ~1.35" wide, preserving aspect ratio.
  const logoWidthPx = 130;
  const logoHeightPx = Math.round((logoWidthPx * TTG_LOGO_HEIGHT) / TTG_LOGO_WIDTH);

  const usableTwips = 9360; // Letter (12240) minus 1" margins each side
  const leftWidth = 3200;
  const rightWidth = usableTwips - leftWidth;

  const noBorder = { style: BorderStyle.NONE, size: 0, color: "FFFFFF" };
  const noBorders = {
    top: noBorder,
    bottom: noBorder,
    left: noBorder,
    right: noBorder,
    insideHorizontal: noBorder,
    insideVertical: noBorder,
  };

  const addressParas = [
    new Paragraph({
      alignment: AlignmentType.RIGHT,
      spacing: { before: 0, after: 0, line: 240 },
      children: [run(COMPANY.name, { size: SIZE.headerAddress, color: TEXT, bold: true })],
    }),
    ...COMPANY.address.map(
      (line) =>
        new Paragraph({
          alignment: AlignmentType.RIGHT,
          spacing: { before: 0, after: 0, line: 240 },
          children: [run(line, { size: SIZE.headerAddress, color: TEXT })],
        })
    ),
  ];

  return new Header({
    children: [
      new Table({
        width: { size: usableTwips, type: WidthType.DXA },
        columnWidths: [leftWidth, rightWidth],
        borders: noBorders,
        rows: [
          new TableRow({
            children: [
              new TableCell({
                width: { size: leftWidth, type: WidthType.DXA },
                verticalAlign: VerticalAlign.TOP,
                margins: { top: 0, bottom: 0, left: 0, right: 0 },
                children: [
                  new Paragraph({
                    alignment: AlignmentType.LEFT,
                    spacing: { before: 0, after: 0 },
                    children: [
                      new ImageRun({
                        data: TTG_LOGO_PNG,
                        transformation: { width: logoWidthPx, height: logoHeightPx },
                      }),
                    ],
                  }),
                ],
              }),
              new TableCell({
                width: { size: rightWidth, type: WidthType.DXA },
                verticalAlign: VerticalAlign.TOP,
                margins: { top: 0, bottom: 0, left: 0, right: 0 },
                children: addressParas,
              }),
            ],
          }),
        ],
      }),
    ],
  });
}

/**
 * Running header on every non-title page: the document title, small and gray,
 * left-aligned; a small brand mark, right-aligned; a thin rule underneath
 * spanning the full text width. (Not a big green heading — that was wrong.)
 */
function runningHeader(title: string): Header {
  const usableTwips = 9360; // Letter (12240) minus 1" margins each side
  const leftWidth = 7200;
  const rightWidth = usableTwips - leftWidth;
  const markWidthPx = 42;
  const markHeightPx = Math.round((markWidthPx * TTG_LOGO_HEIGHT) / TTG_LOGO_WIDTH);

  const rule = { style: BorderStyle.SINGLE, size: 4, color: "D9D9D9" }; // thin light-gray rule
  const noBorder = { style: BorderStyle.NONE, size: 0, color: "FFFFFF" };
  const borders = {
    top: noBorder,
    bottom: rule,
    left: noBorder,
    right: noBorder,
    insideHorizontal: noBorder,
    insideVertical: noBorder,
  };

  return new Header({
    children: [
      new Table({
        width: { size: usableTwips, type: WidthType.DXA },
        columnWidths: [leftWidth, rightWidth],
        borders,
        rows: [
          new TableRow({
            children: [
              new TableCell({
                width: { size: leftWidth, type: WidthType.DXA },
                verticalAlign: VerticalAlign.BOTTOM,
                margins: { top: 0, bottom: 80, left: 0, right: 0 },
                borders,
                children: [
                  new Paragraph({
                    alignment: AlignmentType.LEFT,
                    spacing: { before: 0, after: 0, line: 240 },
                    children: [run(title, { size: SIZE.runningHeader, color: GRAY })],
                  }),
                ],
              }),
              new TableCell({
                width: { size: rightWidth, type: WidthType.DXA },
                verticalAlign: VerticalAlign.BOTTOM,
                margins: { top: 0, bottom: 80, left: 0, right: 0 },
                borders,
                children: [
                  new Paragraph({
                    alignment: AlignmentType.RIGHT,
                    spacing: { before: 0, after: 0 },
                    children: [
                      new ImageRun({
                        data: TTG_LOGO_PNG,
                        transformation: { width: markWidthPx, height: markHeightPx },
                      }),
                    ],
                  }),
                ],
              }),
            ],
          }),
        ],
      }),
    ],
  });
}

/** Footer on every non-title page: page number only, right-aligned, small gray. */
function bodyFooter(): Footer {
  return new Footer({
    children: [
      new Paragraph({
        alignment: AlignmentType.RIGHT,
        spacing: { before: 0, after: 0, line: 240 },
        children: [
          new TextRun({
            font: FONT,
            size: SIZE.footer,
            color: GRAY,
            children: [PageNumber.CURRENT],
          }),
        ],
      }),
    ],
  });
}

/** Empty footer for the title page (keeps numbering continuous, hides number). */
function emptyFooter(): Footer {
  return new Footer({ children: [new Paragraph({ children: [] })] });
}

// ---- Body -------------------------------------------------------------------

function sectionChildren(doc: StructuredDoc): Paragraph[] {
  const out: Paragraph[] = [];

  for (const section of doc.sections) {
    out.push(
      headingParagraph(`${section.number}. ${section.heading}`, HeadingLevel.HEADING_1, section.number)
    );
    for (const p of section.paragraphs) out.push(bodyParagraph(p));
    if (section.bullets)
      for (const b of section.bullets) out.push(bulletParagraph(b, section.bulletStyle ?? "bullet"));

    for (const sub of section.subsections ?? []) {
      out.push(
        headingParagraph(`${sub.number} ${sub.heading}`, HeadingLevel.HEADING_2, sub.number)
      );
      for (const p of sub.paragraphs) out.push(bodyParagraph(p));
      if (sub.bullets)
        for (const b of sub.bullets) out.push(bulletParagraph(b, sub.bulletStyle ?? "bullet"));
    }
  }
  return out;
}

/**
 * A manually-built Table of Contents. Unlike a live TOC field (which renders
 * blank until the reader updates fields), this is real, always-visible content:
 * each entry is a clickable internal hyperlink to the heading's bookmark, a
 * dot-leader tab, and a PAGEREF field for the page number. With updateFields
 * enabled, Word fills the page numbers automatically on open.
 */
function tocChildren(doc: StructuredDoc): Paragraph[] {
  const out: Paragraph[] = [
    new Paragraph({
      spacing: { before: 0, after: 240, line: 240 },
      children: [run("Table of Contents", { size: SIZE.heading, bold: true, color: TEXT })],
    }),
  ];

  const entry = (number: string, heading: string, indent: number) =>
    new Paragraph({
      spacing: { before: 0, after: 60, line: 240 },
      indent: indent ? { left: indent } : undefined,
      tabStops: [
        { type: TabStopType.RIGHT, position: TabStopPosition.MAX, leader: LeaderType.DOT },
      ],
      children: [
        new InternalHyperlink({
          anchor: bookmarkName(number),
          children: [run(`${number}. ${heading}`, { size: SIZE.body })],
        }),
        new TextRun({ text: "\t", font: FONT, size: SIZE.body }),
        new SimpleField(`PAGEREF ${bookmarkName(number)} \\h`),
      ],
    });

  for (const section of doc.sections) {
    out.push(entry(section.number, section.heading, 0));
    for (const sub of section.subsections ?? []) out.push(entry(sub.number, sub.heading, 360));
  }
  return out;
}

// ---- Assemble the document --------------------------------------------------

export async function renderTtgDocx(doc: StructuredDoc): Promise<Buffer> {
  const tocSection = tocChildren(doc);

  const document = new Document({
    creator: "TTG Document Standardizer",
    title: doc.title,
    features: { updateFields: true },
    styles: {
      default: {
        document: { run: { font: FONT, size: SIZE.body, color: TEXT } },
      },
      paragraphStyles: [
        {
          id: "Heading1",
          name: "Heading 1",
          basedOn: "Normal",
          next: "Normal",
          quickFormat: true,
          run: { font: FONT, size: SIZE.heading, bold: true, color: TEXT },
          paragraph: { spacing: { before: 240, after: 120, line: 240 }, outlineLevel: 0 },
        },
        {
          id: "Heading2",
          name: "Heading 2",
          basedOn: "Normal",
          next: "Normal",
          quickFormat: true,
          run: { font: FONT, size: SIZE.heading, bold: true, color: TEXT },
          paragraph: { spacing: { before: 200, after: 100, line: 240 }, outlineLevel: 1 },
        },
        {
          id: "Heading3",
          name: "Heading 3",
          basedOn: "Normal",
          next: "Normal",
          quickFormat: true,
          run: { font: FONT, size: SIZE.heading, bold: true, color: TEXT },
          paragraph: { spacing: { before: 160, after: 80, line: 240 }, outlineLevel: 2 },
        },
        {
          id: "Heading4",
          name: "Heading 4",
          basedOn: "Normal",
          next: "Normal",
          quickFormat: true,
          run: { font: FONT, size: SIZE.heading, bold: true, color: TEXT },
          paragraph: { spacing: { before: 120, after: 60, line: 240 }, outlineLevel: 3 },
        },
      ],
    },
    numbering: {
      config: [
        {
          reference: "ttg-bullets",
          levels: [
            {
              level: 0,
              format: LevelFormat.BULLET,
              text: "\u2022",
              alignment: AlignmentType.LEFT,
              style: {
                paragraph: { indent: { left: 720, hanging: 360 } },
                run: { color: GREEN, bold: true, font: FONT },
              },
            },
            {
              level: 1,
              format: LevelFormat.BULLET,
              text: "\u25CB",
              alignment: AlignmentType.LEFT,
              style: {
                paragraph: { indent: { left: 1080, hanging: 360 } },
                run: { color: GREEN, bold: true, font: FONT },
              },
            },
          ],
        },
        {
          reference: "ttg-numbers",
          levels: [
            {
              level: 0,
              format: LevelFormat.DECIMAL,
              text: "%1.",
              alignment: AlignmentType.LEFT,
              style: {
                paragraph: { indent: { left: 720, hanging: 360 } },
                run: { color: GREEN, bold: true, font: FONT },
              },
            },
          ],
        },
      ],
    },
    sections: [
      // Section 1 — Title page (own header/footer; no visible page number)
      {
        properties: {
          page: {
            size: { width: 12240, height: 15840 },
            margin: {
              top: convertInchesToTwip(1),
              right: convertInchesToTwip(1),
              bottom: convertInchesToTwip(1),
              left: convertInchesToTwip(1),
            },
          },
        },
        headers: { default: titlePageHeader() },
        footers: { default: emptyFooter() },
        children: titlePageChildren(doc),
      },
      // Section 2 — TOC + body (running header + numbered footer)
      {
        properties: {
          page: {
            size: { width: 12240, height: 15840 },
            margin: {
              top: convertInchesToTwip(1),
              right: convertInchesToTwip(1),
              bottom: convertInchesToTwip(1),
              left: convertInchesToTwip(1),
            },
          },
        },
        headers: { default: runningHeader(doc.title) },
        footers: { default: bodyFooter() },
        children: [...tocSection, new Paragraph({ children: [], pageBreakBefore: true }), ...sectionChildren(doc)],
      },
    ],
  });

  return patchDocx(await Packer.toBuffer(document));
}

/**
 * Post-process fixes applied to docx-js output:
 *  1. Inject the fontTable relationship docx-js omits (strict validators flag it).
 *  2. Renumber bookmark ids. docx-js emits w:id="1" on every bookmark, which is a
 *     duplicate-id validation error; we assign unique, correctly-paired ids.
 */
async function patchDocx(buffer: Buffer): Promise<Buffer> {
  const zip = await JSZip.loadAsync(buffer);

  // 1. fontTable relationship
  const relsFile = zip.file("word/_rels/document.xml.rels");
  const fontTable = zip.file("word/fontTable.xml");
  if (relsFile && fontTable) {
    let rels = await relsFile.async("string");
    if (!rels.includes("fontTable.xml")) {
      const ids = [...rels.matchAll(/Id="rId(\d+)"/g)].map((m) => parseInt(m[1], 10));
      const nextId = (ids.length ? Math.max(...ids) : 0) + 1;
      const rel =
        `<Relationship Id="rId${nextId}" ` +
        `Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/fontTable" ` +
        `Target="fontTable.xml"/>`;
      rels = rels.replace("</Relationships>", `${rel}</Relationships>`);
      zip.file("word/_rels/document.xml.rels", rels);
    }
  }

  // 2. Unique bookmark ids (paired start/end via a stack; our bookmarks are
  //    non-overlapping, so the stack depth stays at 1).
  const docFile = zip.file("word/document.xml");
  if (docFile) {
    let xml = await docFile.async("string");
    let counter = 0;
    const stack: number[] = [];
    xml = xml.replace(
      /<w:bookmark(Start|End)\b([^>]*?)\s+w:id="\d+"([^>]*?)\/>/g,
      (_m, kind: string, pre: string, post: string) => {
        let id: number;
        if (kind === "Start") {
          counter += 1;
          id = counter;
          stack.push(id);
        } else {
          id = stack.pop() ?? counter;
        }
        return `<w:bookmark${kind}${pre} w:id="${id}"${post}/>`;
      }
    );
    zip.file("word/document.xml", xml);
  }

  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}
