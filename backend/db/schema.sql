-- TTG Document Standardizer — schema
-- One row per standardization job.

CREATE TABLE IF NOT EXISTS document_job (
  id              SERIAL PRIMARY KEY,
  title           VARCHAR(255) NOT NULL,
  version         VARCHAR(50)  NOT NULL DEFAULT 'v1',
  owner_name      VARCHAR(255) NOT NULL,
  owner_email     VARCHAR(255) NOT NULL,

  source_kind     VARCHAR(20)  NOT NULL
                    CHECK (source_kind IN ('upload','paste')),
  source_filename VARCHAR(512),

  status          VARCHAR(20)  NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','extracting','structuring','rendering','complete','failed')),

  structured_json JSONB,             -- the section structure the renderer used
  output_filename VARCHAR(512),      -- rendered .docx name in OUTPUT_DIR
  error           TEXT,              -- last error, if failed

  created_by      VARCHAR(255),      -- from the auth proxy (X-User-Email)
  created_at      TIMESTAMP NOT NULL DEFAULT now(),
  updated_at      TIMESTAMP NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_document_job_created_at ON document_job (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_document_job_status     ON document_job (status);
CREATE INDEX IF NOT EXISTS idx_document_job_created_by ON document_job (created_by);
