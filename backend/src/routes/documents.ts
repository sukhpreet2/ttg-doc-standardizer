import { Router, Request, Response, NextFunction } from "express";
import { query, queryOne } from "../db";
import { upload } from "../middleware/upload";
import { extractContent, SUPPORTED_EXTENSIONS } from "../services/extract";
import { structureContent } from "../services/structure";
import { renderTtgDocx } from "../services/renderTtgDocx";
import { renderTtgHtml } from "../services/renderTtgHtml";
import type { StructuredDoc } from "../services/renderTtgDocx";
import type { DocumentJob } from "../types";

export const documentsRouter = Router();

// Every column EXCEPT output_bytes. Render's free plan has no persistent
// disk — any file written to the container's filesystem disappears the next
// time the service spins down/up (idle timeout) or redeploys, which is what
// was causing "This site can't be reached / ERR_INVALID_RESPONSE" on
// download. The rendered .docx is stored as bytes in Postgres instead (the
// one thing on the free plan that *does* persist), and is only selected by
// the /download route — list/detail responses (polled every couple of
// seconds while a job is in flight) never pull that payload over the wire.
const LIST_COLUMNS = `
  id, title, version, owner_name, owner_email, source_kind, source_filename,
  status, structured_json, output_filename, error, created_by, created_at, updated_at
`;

function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "report"
  );
}

function actor(req: Request): string | null {
  // In production an OIDC/Keycloak proxy should set this header (see README).
  const h = req.header("X-User-Email");
  return h && h.trim() ? h.trim() : null;
}

async function updateStatus(id: number, status: string, error?: string): Promise<void> {
  await query(
    `UPDATE document_job SET status = $2, error = $3, updated_at = now() WHERE id = $1`,
    [id, status, error ?? null]
  );
}

/**
 * POST /api/documents
 * Accepts either:
 *   - multipart/form-data with a "file" field + metadata fields, OR
 *   - application/json with { title, version, ownerName, ownerEmail, content }
 *
 * Returns as soon as the job row is created (status "pending") — it does NOT
 * wait for the pipeline to finish. Extraction/structuring/rendering happen in
 * the background; the frontend polls GET /api/documents(/:id) for status.
 * (Running the whole pipeline inside the request handler is what caused
 * requests to hang and eventually 524 — cold starts + local-model loading +
 * large documents can easily take well past any gateway's timeout.)
 */
documentsRouter.post(
  "/",
  upload.single("file"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const title = (req.body.title || "").trim();
      const version = (req.body.version || "v1").trim();
      const ownerName = (req.body.ownerName || "").trim();
      const ownerEmail = (req.body.ownerEmail || "").trim();

      if (!title) return res.status(400).json({ error: "title is required" });
      if (!ownerName) return res.status(400).json({ error: "ownerName is required" });
      if (!ownerEmail) return res.status(400).json({ error: "ownerEmail is required" });

      let content = "";
      let sourceKind: "upload" | "paste";
      let sourceFilename: string | null = null;
      let fileBuffer: Buffer | null = null;
      let originalName = "";

      if (req.file) {
        const ext = req.file.originalname.split(".").pop()?.toLowerCase() ?? "";
        if (!SUPPORTED_EXTENSIONS.includes(ext)) {
          return res.status(400).json({
            error: `Unsupported file type ".${ext}". Supported: ${SUPPORTED_EXTENSIONS.join(", ")}`,
          });
        }
        sourceKind = "upload";
        sourceFilename = req.file.originalname;
        fileBuffer = req.file.buffer;
        originalName = req.file.originalname;
      } else if (req.body.content && String(req.body.content).trim()) {
        content = String(req.body.content);
        sourceKind = "paste";
      } else {
        return res.status(400).json({ error: "Provide either a file or pasted content." });
      }

      // Create the job row up front so it is visible while processing.
      const job = await queryOne<DocumentJob>(
        `INSERT INTO document_job
           (title, version, owner_name, owner_email, source_kind, source_filename, status, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,'pending',$7)
         RETURNING ${LIST_COLUMNS}`,
        [title, version, ownerName, ownerEmail, sourceKind, sourceFilename, actor(req)]
      );
      if (!job) throw new Error("Failed to create job");

      // Respond right away — do not block on the pipeline.
      res.status(202).json(job);

      // Run the pipeline in the background. Errors are caught and written to
      // the job row (status "failed"); nothing here can crash the request
      // since the response was already sent.
      void (async () => {
        try {
          if (fileBuffer) {
            await updateStatus(job.id, "extracting");
            const { text } = await extractContent(fileBuffer, originalName);
            content = text;
          }
          if (!content.trim()) {
            throw new Error("No readable content could be extracted from the source.");
          }

          await updateStatus(job.id, "structuring");
          const structured = await structureContent({
            title,
            version,
            ownerName,
            ownerEmail,
            content,
          });

          await updateStatus(job.id, "rendering");
          const outputFilename = `${slugify(title)}-${job.id}.docx`;
          const buffer = await renderTtgDocx(structured, outputFilename);

          await query(
            `UPDATE document_job
               SET status='complete', structured_json=$2, output_filename=$3,
                   output_bytes=$4, error=NULL, updated_at=now()
             WHERE id=$1`,
            [job.id, JSON.stringify(structured), outputFilename, buffer]
          );
        } catch (pipelineErr) {
          const message =
            pipelineErr instanceof Error ? pipelineErr.message : "Processing failed";
          await updateStatus(job.id, "failed", message);
        }
      })();
    } catch (err) {
      next(err);
    }
  }
);

/** GET /api/documents — list, newest first. */
documentsRouter.get("/", async (_req, res, next) => {
  try {
    const rows = await query<DocumentJob>(
      `SELECT ${LIST_COLUMNS} FROM document_job ORDER BY created_at DESC LIMIT 200`
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

/** GET /api/documents/:id */
documentsRouter.get("/:id", async (req, res, next) => {
  try {
    const row = await queryOne<DocumentJob>(
      `SELECT ${LIST_COLUMNS} FROM document_job WHERE id=$1`,
      [req.params.id]
    );
    if (!row) return res.status(404).json({ error: "Not found" });
    res.json(row);
  } catch (err) {
    next(err);
  }
});

/** GET /api/documents/:id/download — stream the rendered .docx straight from the DB. */
documentsRouter.get("/:id/download", async (req, res, next) => {
  try {
    const row = await queryOne<DocumentJob>(
      `SELECT output_filename, output_bytes FROM document_job WHERE id=$1`,
      [req.params.id]
    );
    if (!row || !row.output_filename || !row.output_bytes) {
      return res.status(404).json({ error: "No rendered document for this job" });
    }
    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    );
    res.setHeader("Content-Disposition", `attachment; filename="${row.output_filename}"`);
    res.send(row.output_bytes);
  } catch (err) {
    next(err);
  }
});

/** GET /api/documents/:id/preview — render the standardized document as HTML for in-browser viewing. */
documentsRouter.get("/:id/preview", async (req, res, next) => {
  try {
    const row = await queryOne<DocumentJob>(
      `SELECT status, structured_json, output_filename, title FROM document_job WHERE id=$1`,
      [req.params.id]
    );
    if (!row) return res.status(404).json({ error: "Not found" });
    if (row.status !== "complete" || !row.structured_json) {
      return res.status(409).json({ error: "This document has not finished rendering yet." });
    }
    const structured = row.structured_json as unknown as StructuredDoc;
    const html = renderTtgHtml(structured, row.output_filename ?? `${row.title}.docx`);
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(html);
  } catch (err) {
    next(err);
  }
});

/** DELETE /api/documents/:id — remove the job (and its stored bytes). */
documentsRouter.delete("/:id", async (req, res, next) => {
  try {
    const result = await query<{ id: number }>(
      `DELETE FROM document_job WHERE id=$1 RETURNING id`,
      [req.params.id]
    );
    if (!result.length) return res.status(404).json({ error: "Not found" });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});
