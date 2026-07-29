# TTG Document Standardizer

An internal web app for Tartigrade (TTG). Upload **any** content — a Word doc, PDF,
spreadsheet, or pasted text — and get back a **standardized, TTG-branded Word
document** (`.docx`) that follows the company report standard exactly: Calibri,
brand green (`#5AA66A`) for labels, bullets, and branding only, a right-aligned
title page with Document Version / Document Owners / Date, a table of contents,
a small gray running header with a brand mark and rule, page-number-only
footers, and numbered section headings.

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
| DELETE | `/api/documents/:id` | delete job + file |
| GET | `/healthz`, `/readyz` | health / readiness |

Metadata fields: `title` (required), `version` (default `v1`), `ownerName` (required),
`ownerTitle` (optional), `ownerEmail` (required).

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
- **The TTG standard** lives in one place: the constants at the top of
  `backend/src/services/renderTtgDocx.ts` (green `#5AA66A`, near-black text
  `#111111`, gray header/footer `#666666`, sizes, address block). These were
  calibrated by sampling actual pixel colors from the reference template
  (`Talent ↔ Connect Bridge — Employee Onboarding Feature Spec.pdf`), not
  guessed from a brand guide — change them there and every future document
  updates. The title page's "Date" field is stamped with the render date
  automatically; `ownerTitle`, if supplied, prints as a role line under the
  owner's name.
- **Logo.** The title page carries the TTG wordmark (spiral + "TARTIGRADE LIMITED")
  top-left, aligned with the address block, matching the feature-spec template. It is
  embedded as base64 in `backend/src/assets/logo.ts` (no file-path or Docker-copy
  concerns); replace that file to swap the mark. A small version of the same mark
  appears top-right in the running header on every other page. A separate
  decorative asset, `backend/src/assets/dots.ts`, reproduces the graduated
  spiral of brand-green dots that sits bottom-left on the title page; it is a
  generated approximation of the reference graphic, not a pixel-exact trace —
  swap that file if you have the original vector art.
- **Inline code spans.** Text wrapped in backticks (`` `like/this` ``) anywhere
  in a paragraph or bullet renders in green Consolas, matching how the
  reference document styles file paths, routes, and identifiers inline.
- **Ordered lists.** `StructuredSection.bulletStyle` / `StructuredSubsection.bulletStyle`
  can be set to `"number"` for a green, bold decimal list (e.g. build-order steps),
  or left as the default `"bullet"` for a green dot list.
