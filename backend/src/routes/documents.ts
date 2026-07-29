import { Router, Request, Response, NextFunction } from "express";
import * as fs from "fs/promises";
import * as path from "path";
import { config } from "../config";
import { query, queryOne } from "../db";
import { upload } from "../middleware/upload";
import { extractContent, SUPPORTED_EXTENSIONS } from "../services/extract";
import { structureContent } from "../services/structure";
import { renderTtgDocx } from "../services/renderTtgDocx";
import { renderTtgHtml } from "../services/renderTtgHtml";
import type { StructuredDoc } from "../services/renderTtgDocx";
import type { DocumentJob } from "../types";

export const documentsRouter = Router();

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
 * Runs the full pipeline and returns the finished job.
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

      if (req.file) {
        const ext = req.file.originalname.split(".").pop()?.toLowerCase() ?? "";
        if (!SUPPORTED_EXTENSIONS.includes(ext)) {
          return res.status(400).json({
            error: `Unsupported file type ".${ext}". Supported: ${SUPPORTED_EXTENSIONS.join(", ")}`,
          });
        }
        sourceKind = "upload";
        sourceFilename = req.file.originalname;
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
         RETURNING *`,
        [title, version, ownerName, ownerEmail, sourceKind, sourceFilename, actor(req)]
      );
      if (!job) throw new Error("Failed to create job");

      try {
        // 1. Extract
        if (req.file) {
          await updateStatus(job.id, "extracting");
          const { text } = await extractContent(req.file.buffer, req.file.originalname);
          content = text;
        }
        if (!content.trim()) {
          throw new Error("No readable content could be extracted from the source.");
        }

        // 2. Structure
        await updateStatus(job.id, "structuring");
        const structured = await structureContent({
          title,
          version,
          ownerName,
          ownerEmail,
          content,
        });

        // 3. Render (manual TOC populates in Word on open; no post-processing needed)
        await updateStatus(job.id, "rendering");
        const outputFilename = `${slugify(title)}-${job.id}.docx`;
        const buffer = await renderTtgDocx(structured, outputFilename);
        await fs.mkdir(config.outputDir, { recursive: true });
        await fs.writeFile(path.join(config.outputDir, outputFilename), buffer);

        // 4. Complete
        const finished = await queryOne<DocumentJob>(
          `UPDATE document_job
             SET status='complete', structured_json=$2, output_filename=$3, error=NULL, updated_at=now()
           WHERE id=$1
           RETURNING *`,
          [job.id, JSON.stringify(structured), outputFilename]
        );
        return res.status(201).json(finished);
      } catch (pipelineErr) {
        const message =
          pipelineErr instanceof Error ? pipelineErr.message : "Processing failed";
        await updateStatus(job.id, "failed", message);
        const failed = await queryOne<DocumentJob>(
          `SELECT * FROM document_job WHERE id=$1`,
          [job.id]
        );
        return res.status(422).json({ error: message, job: failed });
      }
    } catch (err) {
      next(err);
    }
  }
);

/** GET /api/documents — list, newest first. */
documentsRouter.get("/", async (_req, res, next) => {
  try {
    const rows = await query<DocumentJob>(
      `SELECT * FROM document_job ORDER BY created_at DESC LIMIT 200`
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

/** GET /api/documents/:id */
documentsRouter.get("/:id", async (req, res, next) => {
  try {
    const row = await queryOne<DocumentJob>(`SELECT * FROM document_job WHERE id=$1`, [
      req.params.id,
    ]);
    if (!row) return res.status(404).json({ error: "Not found" });
    res.json(row);
  } catch (err) {
    next(err);
  }
});

/** GET /api/documents/:id/download — stream the rendered .docx. */
documentsRouter.get("/:id/download", async (req, res, next) => {
  try {
    const row = await queryOne<DocumentJob>(`SELECT * FROM document_job WHERE id=$1`, [
      req.params.id,
    ]);
    if (!row || !row.output_filename) {
      return res.status(404).json({ error: "No rendered document for this job" });
    }
    const filePath = path.join(config.outputDir, row.output_filename);
    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    );
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${row.output_filename}"`
    );
    res.sendFile(filePath, (err) => {
      if (err) next(err);
    });
  } catch (err) {
    next(err);
  }
});

/** GET /api/documents/:id/preview — render the standardized document as HTML for in-browser viewing. */
documentsRouter.get("/:id/preview", async (req, res, next) => {
  try {
    const row = await queryOne<DocumentJob>(`SELECT * FROM document_job WHERE id=$1`, [
      req.params.id,
    ]);
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

/** DELETE /api/documents/:id — remove the job and its file. */
documentsRouter.delete("/:id", async (req, res, next) => {
  try {
    const row = await queryOne<DocumentJob>(`SELECT * FROM document_job WHERE id=$1`, [
      req.params.id,
    ]);
    if (!row) return res.status(404).json({ error: "Not found" });
    if (row.output_filename) {
      await fs.rm(path.join(config.outputDir, row.output_filename), { force: true });
    }
    await query(`DELETE FROM document_job WHERE id=$1`, [req.params.id]);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});
