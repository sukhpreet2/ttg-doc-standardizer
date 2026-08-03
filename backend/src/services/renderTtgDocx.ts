/**
 * renderTtgDocx.ts
 * -----------------
 * The heart of the standardizer. Takes a StructuredDoc (title/version/owner +
 * numbered sections) and produces a .docx that matches Tartigrade's exact report
 * standard:
 *
 *   - Font:            Calibri throughout
 *   - Brand green:     #1F7A4D — labels & branding ONLY (never values/content)
 *   - Body text:       11pt (size 22), black
 *   - Headings H1-H4:  14pt (size 28), bold, BRAND GREEN (headings are "labels")
 *   - Running header:  short doc title, black, 9pt (size 18) + green brand mark —
 *                      non-title pages only
 *   - Title page:      right-aligned address block + big title + version/owner
 *   - Footer:          page number only, centered; hidden (empty) on title page
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
  HorizontalPositionRelativeFrom,
  HorizontalPositionAlign,
  VerticalPositionRelativeFrom,
  TextWrappingType,
} from "docx";
import JSZip from "jszip";
import { TTG_LOGO_PNG, TTG_LOGO_WIDTH, TTG_LOGO_HEIGHT } from "../assets/logo";
import { TTG_SWIRL_PNG, TTG_SWIRL_WIDTH, TTG_SWIRL_HEIGHT } from "../assets/swirl";

// ---- Brand constants (single source of truth) -------------------------------

export const GREEN = "1F7A4D";
export const BLACK = "000000";
export const FONT = "Calibri";

// half-point sizes (docx uses half-points: 11pt -> 22)
export const SIZE = {
  body: 22, // 11pt
  headerAddress: 22, // 11pt (title-page header lines)
  titleBig: 64, // 32pt (company name + doc title on title page)
  titleLabel: 28, // 14pt ("Document Version" / "Document Owner")
  runningHeader: 18, // 9pt (short doc title in the running page header)
  heading: 28, // 14pt (H1-H4) — brand green, matches the TTG standard exactly
};

export const COMPANY = {
  name: "Tartigrade (TTG)",
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
}

export interface StructuredSection {
  number: string; // e.g. "1"
  heading: string; // e.g. "Introduction"
  paragraphs: string[];
  bullets?: string[];
  subsections?: StructuredSubsection[];
}

export interface StructuredDoc {
  title: string;
  version: string;
  ownerName: string;
  ownerEmail: string;
  sections: StructuredSection[];
}

// ---- Small helpers ----------------------------------------------------------

function run(text: string, opts: { size: number; color?: string; bold?: boolean }) {
  return new TextRun({
    text: sanitizeXmlText(text),
    font: FONT,
    size: opts.size,
    color: opts.color ?? BLACK,
    bold: opts.bold ?? false,
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

/** A body paragraph of plain prose. */
function bodyParagraph(text: string): Paragraph {
  return new Paragraph({
    spacing: { before: 0, after: 120, line: 240 },
    children: [run(text, { size: SIZE.body })],
  });
}

/** A single bullet item (level 0) using the shared numbering config. */
function bulletParagraph(text: string, level = 0): Paragraph {
  return new Paragraph({
    numbering: { reference: "ttg-bullets", level },
    spacing: { before: 0, after: 60, line: 240 },
    children: [run(text, { size: SIZE.body })],
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
        children: [run(numberedText, { size: SIZE.heading, bold: true, color: GREEN })],
      }),
    ],
  });
}

// ---- Title page -------------------------------------------------------------

function titlePageChildren(doc: StructuredDoc): (Paragraph | Table)[] {
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
      children: [run(text, { size: SIZE.body, color: BLACK })],
    });

  return [
    titlePageLetterhead(),
    titlePageSwirl(),
    // vertical breathing room so the block sits lower on the page
    new Paragraph({ spacing: { before: 3200, after: 0 }, children: [] }),
    // Company kicker — small, green, ALL CAPS (matches the reference standard;
    // it is NOT the same giant size as the title below it).
    new Paragraph({
      alignment: AlignmentType.RIGHT,
      spacing: { before: 0, after: 240, line: 240 },
      children: [run(COMPANY.name.toUpperCase(), { size: SIZE.titleLabel, color: GREEN })],
    }),
    // Document title value — black, big (no label)
    new Paragraph({
      alignment: AlignmentType.RIGHT,
      spacing: { before: 0, after: 480, line: 760 },
      children: [run(doc.title, { size: SIZE.titleBig, color: BLACK })],
    }),
    rightLabel("Document Version"),
    rightValue(doc.version),
    rightLabel("Document Owner"),
    rightValue(doc.ownerName),
    rightValue(doc.ownerEmail),
  ];
}

/**
 * Title-page decoration: a spiral of green dots, floating in the lower-left
 * of the page — matching the reference TTG standard. It's a floating image
 * (anchored to the page, not the text flow) so it can sit independently of
 * the right-aligned title/version/owner block sharing the same vertical
 * space; the paragraph it's attached to carries no visible text of its own.
 */
function titlePageSwirl(): Paragraph {
  const widthIn = 2.5;
  const heightIn = widthIn * (TTG_SWIRL_HEIGHT / TTG_SWIRL_WIDTH);
  const widthPx = Math.round(widthIn * 96);
  const heightPx = Math.round(heightIn * 96);
  const topOffsetEmu = Math.round(6.3 * 914400); // ~6.3" down the 11" page

  return new Paragraph({
    children: [
      new ImageRun({
        data: TTG_SWIRL_PNG,
        transformation: { width: widthPx, height: heightPx },
        floating: {
          horizontalPosition: {
            relative: HorizontalPositionRelativeFrom.MARGIN,
            align: HorizontalPositionAlign.LEFT,
          },
          verticalPosition: {
            relative: VerticalPositionRelativeFrom.PAGE,
            offset: topOffsetEmu,
          },
          wrap: { type: TextWrappingType.SQUARE },
          allowOverlap: true,
        },
      }),
    ],
  });
}

/**
 * Letterhead: TTG logo (left) + company/address block (right), as BODY
 * content at the top of the title page — not a Header. An image inside a
 * table inside a page Header is a known trouble spot (Google Docs' .docx
 * importer in particular can silently drop it), and it only needs to render
 * once anyway, so it lives with the rest of the title-page content instead.
 */
function titlePageLetterhead(): Table {
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
      children: [run(COMPANY.name, { size: SIZE.headerAddress, color: GREEN, bold: true })],
    }),
    ...COMPANY.address.map(
      (line) =>
        new Paragraph({
          alignment: AlignmentType.RIGHT,
          spacing: { before: 0, after: 0, line: 240 },
          children: [run(line, { size: SIZE.headerAddress, color: BLACK })],
        })
    ),
  ];

  return new Table({
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
  });
}

// ---- Headers & footers ------------------------------------------------------

/**
 * Running header on every non-title page: small black running title (left)
 * + a small brand-green mark (right), exactly matching the reference TTG
 * standard — not a large green title. The filename is NOT part of this; the
 * header identifies the document by name, page after page.
 */
function runningHeader(title: string): Header {
  return new Header({
    children: [
      new Paragraph({
        tabStops: [{ type: TabStopType.RIGHT, position: TabStopPosition.MAX }],
        spacing: { before: 0, after: 120, line: 240 },
        border: {
          bottom: { style: BorderStyle.SINGLE, size: 4, color: "D9D9D9", space: 4 },
        },
        children: [
          run(title, { size: SIZE.runningHeader, color: BLACK }),
          new TextRun({ text: "\t", font: FONT, size: SIZE.runningHeader }),
          run("\u25CF", { size: SIZE.runningHeader, color: GREEN }), // brand mark
        ],
      }),
    ],
  });
}

/** Footer on every non-title page: just the page number, centered — matching the standard exactly. */
function bodyFooter(_filename: string): Footer {
  return new Footer({
    children: [
      new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { before: 0, after: 0, line: 240 },
        children: [
          new TextRun({
            font: FONT,
            size: SIZE.body,
            color: BLACK,
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
    if (section.bullets) for (const b of section.bullets) out.push(bulletParagraph(b));

    for (const sub of section.subsections ?? []) {
      out.push(
        headingParagraph(`${sub.number}. ${sub.heading}`, HeadingLevel.HEADING_2, sub.number)
      );
      for (const p of sub.paragraphs) out.push(bodyParagraph(p));
      if (sub.bullets) for (const b of sub.bullets) out.push(bulletParagraph(b));
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
      children: [run("Table of Contents", { size: SIZE.heading, bold: true, color: GREEN })],
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

export async function renderTtgDocx(doc: StructuredDoc, filename: string): Promise<Buffer> {
  const tocSection = tocChildren(doc);

  const document = new Document({
    creator: "TTG Document Standardizer",
    title: doc.title,
    features: { updateFields: true },
    styles: {
      default: {
        document: { run: { font: FONT, size: SIZE.body, color: BLACK } },
      },
      paragraphStyles: [
        {
          id: "Heading1",
          name: "Heading 1",
          basedOn: "Normal",
          next: "Normal",
          quickFormat: true,
          run: { font: FONT, size: SIZE.heading, bold: true, color: GREEN },
          paragraph: { spacing: { before: 240, after: 120, line: 240 }, outlineLevel: 0 },
        },
        {
          id: "Heading2",
          name: "Heading 2",
          basedOn: "Normal",
          next: "Normal",
          quickFormat: true,
          run: { font: FONT, size: SIZE.heading, bold: true, color: GREEN },
          paragraph: { spacing: { before: 200, after: 100, line: 240 }, outlineLevel: 1 },
        },
        {
          id: "Heading3",
          name: "Heading 3",
          basedOn: "Normal",
          next: "Normal",
          quickFormat: true,
          run: { font: FONT, size: SIZE.heading, bold: true, color: GREEN },
          paragraph: { spacing: { before: 160, after: 80, line: 240 }, outlineLevel: 2 },
        },
        {
          id: "Heading4",
          name: "Heading 4",
          basedOn: "Normal",
          next: "Normal",
          quickFormat: true,
          run: { font: FONT, size: SIZE.heading, bold: true, color: GREEN },
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
              style: { paragraph: { indent: { left: 720, hanging: 360 } } },
            },
            {
              level: 1,
              format: LevelFormat.BULLET,
              text: "\u25CB",
              alignment: AlignmentType.LEFT,
              style: { paragraph: { indent: { left: 1080, hanging: 360 } } },
            },
          ],
        },
      ],
    },
    sections: [
      // Section 1 — Title page (letterhead is body content; no header, no visible page number)
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
        footers: { default: bodyFooter(filename) },
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
