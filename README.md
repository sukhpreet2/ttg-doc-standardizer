# TTG Document Standardizer

An internal web app for Tartigrade (TTG). Upload **any** content — a Word doc, PDF,
spreadsheet, or pasted text — and get back a **standardized, TTG-branded Word
document** (`.docx`) that follows the company report standard exactly: Calibri,
brand green (`#1F7A4D`) for labels and branding only, a right-aligned title page,
a table of contents, running headers, and numbered section headings.

It productizes the workflow your existing skills do by hand (`summary_generator`,
`excel_summary_generator`, `ttg_report_generator`) into one upload-and-download tool
the whole team can use.

---

## How it works

```
  Upload / paste content
          │
          ▼
   ┌──────────────┐   ┌───────────────┐   ┌─────────────────┐   ┌──────────────┐
   │  1. Extract  │──▶│ 2. Structure  │──▶│   3. Render      │──▶│ 4. Store +   │
   │ docx/pdf/xls │   │ (local model  │   │ (docx-js → the   │   │  download    │
   │  → plain text│   │  → TTG sections)│ │  TTG standard)   │   │  (.docx)     │
   └──────────────┘   └───────────────┘   └─────────────────┘   └──────────────┘
```

1. **Extract** — `mammoth` (docx), `pdf-parse` (pdf), `SheetJS` (xlsx/csv, every tab
   in order), or UTF-8 text. Covers the same formats as your summary skills.
2. **Structure** — a **local pre-trained zero-shot model** (Hugging Face, run
   in-process via Transformers.js / ONNX — no external API, no API key) reads each
   paragraph and routes it to the right TTG section. Introduction / Executive Summary
   / Conclusion are always present; optional sections appear only when the content
   supports them. Prose is condensed with a built-in extractive summarizer. If the
   model can't load, a pure-JS keyword structurer takes over automatically.
3. **Render** — `renderTtgDocx.ts` reproduces the TTG standard programmatically
   (the spec from `ttg_report_generator_SKILL.md`). Output validates against the
   OOXML schema.
4. **Store** — the `.docx` is written to a mounted volume and a row is recorded in
   Postgres so anyone can find and re-download past documents.

---

## Stack

| Part      | Tech |
|-----------|------|
| Frontend  | React + TypeScript + Vite (served by nginx in prod) |
| Backend   | Express + TypeScript |
| Rendering | `docx` (docx-js) — same library your `ttg_report_generator` skill uses |
| Structuring | Local pre-trained zero-shot model via Transformers.js/ONNX — **no API key**; pure-JS keyword fallback |
| Database  | PostgreSQL |
| Deploy    | Docker + Kubernetes |

> Note: your standard is React/Express, so the app is built that way. The renderer
> is `docx-js`, matching your existing report skill.

---

## Run locally (Docker Compose)

```bash
# The zero-shot model is downloaded into the backend image at build time,
# so the first `--build` needs internet (huggingface.co + nuget.org). After that
# it runs fully offline.
docker compose up --build
```

- App:      http://localhost:8080
- Backend:  http://localhost:4000 (`/healthz`, `/readyz`)
- Postgres: localhost:5432 (`ttg` / `ttg`)

The backend applies `db/schema.sql` on start (idempotent).

## Run locally (without Docker)

```bash
# 1. Postgres
createdb ttg_docs   # or use the compose db service

# 2. Backend
cd backend
cp .env.example .env      # set DATABASE_URL; STRUCTURER defaults to the local model
npm install               # installs the optional model runtime (needs nuget.org)
# For a no-Docker dev run, let the model download on first use:
#   set TRANSFORMERS_OFFLINE=false in .env  (or use STRUCTURER=heuristic for no model)
npm run build && npm run migrate    # create tables
npm run dev                          # http://localhost:4000

# 3. Frontend (new terminal)
cd frontend
npm install
npm run dev                          # http://localhost:5173 (proxies /api → :4000)
```

---

## Deploy to Kubernetes

```bash
# 1. Build & push images
docker build -t REGISTRY/ttg-doc-standardizer-backend:latest ./backend
docker build -t REGISTRY/ttg-doc-standardizer-frontend:latest ./frontend
docker push REGISTRY/ttg-doc-standardizer-backend:latest
docker push REGISTRY/ttg-doc-standardizer-frontend:latest
# then set the image refs in k8s/backend.yaml and k8s/frontend.yaml

# 2. Secrets (do not commit the filled-in file)
cp k8s/secrets.example.yaml k8s/secrets.yaml   # edit values

# 3. Apply
kubectl apply -f k8s/namespace.yaml
kubectl apply -f k8s/secrets.yaml
kubectl apply -f k8s/postgres.yaml
kubectl apply -f k8s/backend.yaml
kubectl apply -f k8s/frontend.yaml
kubectl apply -f k8s/ingress.yaml
```

The frontend (nginx) proxies `/api` to the `backend` service, so one ingress host
is enough. Edit the host in `k8s/ingress.yaml`.

---

## Configuration (backend env)

| Var | Purpose | Default |
|-----|---------|---------|
| `PORT` | HTTP port | `4000` |
| `DATABASE_URL` | Postgres connection string | local dev value |
| `OUTPUT_DIR` | Where rendered `.docx` files are written (mount a PVC here) | `/data/outputs` |
| `STRUCTURER` | `transformers` (local model) or `heuristic` (pure-JS, no model) | `transformers` |
| `ZEROSHOT_MODEL` | Hugging Face model id (Transformers.js/ONNX) | `Xenova/nli-deberta-v3-xsmall` |
| `TRANSFORMERS_CACHE_DIR` | Where model weights are cached | `/models` |
| `TRANSFORMERS_OFFLINE` | Run offline (weights pre-baked); `false` allows download | `true` |
| `CORS_ORIGIN` | Allowed browser origin | `*` |
| `MAX_UPLOAD_BYTES` | Upload size limit | `15728640` (15 MB) |

---

## API

| Method | Route | Description |
|--------|-------|-------------|
| POST | `/api/documents` | multipart (`file` + metadata) **or** JSON (`content` + metadata) → runs the pipeline, returns the finished job |
| GET | `/api/documents` | list jobs (newest first) |
| GET | `/api/documents/:id` | one job |
| GET | `/api/documents/:id/download` | download the rendered `.docx` |
| GET | `/api/documents/:id/preview` | **view the standardized document in the browser** (HTML) |
| DELETE | `/api/documents/:id` | delete job + file |
| GET | `/healthz`, `/readyz` | health / readiness |

Metadata fields: `title` (required), `version` (default `v1`), `ownerName` (required),
`ownerEmail` (required).

---

## Notes & sensible next steps

- **Access control.** The app records `created_by` from an `X-User-Email` header.
  Put your existing Keycloak/OIDC auth proxy in front of the ingress and have it
  inject that header (nginx already forwards it). This mirrors the auth approach in
  your Connect / Talent-Connect specs.
- **Structuring model.** The default `transformers` structurer runs a local
  zero-shot classification model (`Xenova/nli-deberta-v3-xsmall`, ~a few hundred MB)
  entirely in-process — no external API, no key. It's baked into the backend image at
  build time (`scripts/prewarm.mjs`) so runtime is fully offline. To swap models set
  `ZEROSHOT_MODEL` to any Transformers.js-compatible zero-shot model. Set
  `STRUCTURER=heuristic` to skip the model entirely (pure-JS keyword routing) — useful
  for the smallest possible image or air-gapped builds. The model runs on CPU; expect
  a second or two per document.
- **Input quality.** The tool shines on prose (pasted text, narrative docs, reports).
  Very table-/schema-dense PDFs (e.g. raw DDL dumps) don't extract into clean prose in
  any text pipeline, so their summaries are weaker; the extractor drops obvious
  table/diagram noise but can't reconstruct tables. For those, paste the narrative
  portions or provide a prose source.
- **The Table of Contents** is built directly in the document (bookmarked headings,
  clickable entries, dot leaders, and `PAGEREF` fields), so it is never blank — the
  section list always shows. Word fills in the page-number digits on open (the doc
  sets `updateFields`). No LibreOffice or post-processing is required, and output
  validates against the OOXML schema. Note: in non-Word previewers (Google Docs
  quick-view, some mobile viewers) the section list and links display but the
  page-number digits stay blank until the file is opened in Word.
- **Scaling file storage.** Rendered files sit on a ReadWriteOnce PVC, so the backend
  runs 1 replica. To scale out, switch to a ReadWriteMany volume or store the `.docx`
  in object storage (S3/GCS) and stream on download.
- **PDF extraction uses `pdfjs-dist` directly, not `pdf-parse`.** `pdf-parse`
  bundles its own frozen copy of pdf.js from 2017-2018 with no way to update
  it, and chokes on how some modern PDF producers embed fonts — symptom: a
  bare `unsupported Unicode escape sequence` crash (no page number) next to
  `TT: undefined function` font-hinting warnings in the logs. `pdfjs-dist` is
  actively maintained and handles these cases; font rendering is disabled
  since only text is needed, and each page is extracted in its own try/catch
  so one corrupted page can't take down the rest of the document. Since
  `pdfjs-dist` is ESM-only and this backend is CommonJS, it's loaded through
  a runtime-constructed `import()` in `extract.ts` (`new Function("specifier",
  "return import(specifier)")`) — a plain `await import(...)` gets rewritten
  by `tsc` into a `require()` call when targeting CommonJS, which throws
  `ERR_REQUIRE_ESM` for a real `.mjs` package; building the call at runtime
  keeps it invisible to that transform.
- **Known remaining limitation: dense schema tables.** PDF extraction can lose
  the spacing between table cells (a "Column | Type | Notes" row becomes
  "ColumnTypeNotes"); most of this is now filtered as noise (see above), but
  a row whose "Notes" cell is a full sentence can be long enough to slip
  past the filter with its squished column-header prefix still attached
  (e.g. `idSERIALPK` at the start of an otherwise-fine sentence). This
  mainly shows up in heavily tabular sections (database schema, audit-log
  columns). The tool condenses to prose rather than reconstructing actual
  Word tables from source tables, so very table-dense sections are the
  weakest case; flag it if this needs tightening further.
- **Preserves existing document structure.** If the source already has real
  numbered section headings (a spec, a report with its own outline — like
  "1. Core concepts & principles" ... "13. Access control", including
  numbered subsections like "3.1"), that structure is detected and kept
  as-is: same headings, same order, same nesting. Only content with no such
  structure (raw notes, a rough draft) gets routed through the generic
  Introduction / Executive Summary / Conclusion template. Detection lives in
  `backend/src/services/structurers/headings.ts` — it has to tell a real
  heading apart from a Table of Contents entry or an ordinary numbered list
  embedded in a paragraph, both of which are syntactically identical to a
  heading; see the comments there for how.
- **Paragraph noise-filtering is per-line, not per-block.** On PDF-extracted
  text, blank lines are sparse enough that an entire page can be one block;
  a single embedded diagram or table row anywhere in that block used to
  discard every real paragraph along with it. It now drops only the
  offending line, so the prose around a diagram or table survives.
- **The TTG standard** lives in one place: the constants at the top of
  `backend/src/services/renderTtgDocx.ts` (green, sizes, address block). Change them
  there and every future document updates. `renderTtgHtml.ts` imports those same
  constants, so the "View" preview and the downloaded `.docx` can never drift apart.
- **Matches the reference standard exactly.** Section headings (H1-H4) and the
  Table of Contents title are brand green, bold — headings are "labels" per the
  standard, same as the title-page labels. The running header on content pages is
  a small black title line with a green brand mark, and the footer is just the
  page number, centered — matching the reference feature-spec template precisely
  (not a large green title or a filename in the footer).
- **View in browser.** Every completed document gets a "View" link (next to
  "Download .docx") that opens `/api/documents/:id/preview` — a styled HTML render
  of the same `StructuredDoc` the `.docx` was built from, so you can review a
  document without opening Word. It renders directly from the stored section data
  (not a docx→HTML conversion, which loses direct color/size formatting), so it's
  a full round-trip of the same styling — not just an approximation.
- **Logo.** The title page carries the TTG wordmark (spiral + "TARTIGRADE LIMITED")
  top-left, aligned with the address block, matching the feature-spec template. It
  renders as **body content on the title page itself** (not a page Header) — an
  image inside a table inside a Header is a known trouble spot (Google Docs' .docx
  importer in particular can silently drop it), and the letterhead only needs to
  appear once anyway. It is embedded as base64 in `backend/src/assets/logo.ts` (no
  file-path or Docker-copy concerns); replace that file to swap the mark. The same
  base64 asset is reused by the HTML preview.
- **Rendered documents are stored in Postgres, not on disk.** Render's free plan
  has no persistent disk, so anything written to the container's filesystem is
  gone the next time the service spins down/up (idle timeout) or redeploys —
  that's what caused downloads to fail with "This site can't be reached /
  ERR_INVALID_RESPONSE" for jobs that finished before a restart. The rendered
  `.docx` is now stored as `bytea` on the `document_job` row and streamed
  straight from the DB on `/download`. List/detail endpoints explicitly select
  every column *except* that one, so polling the job list every couple of
  seconds doesn't drag the binary payload along with it.
