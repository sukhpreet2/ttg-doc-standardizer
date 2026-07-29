export type JobStatus =
  | "pending"
  | "extracting"
  | "structuring"
  | "rendering"
  | "complete"
  | "failed";

export interface DocumentJob {
  id: number;
  title: string;
  version: string;
  owner_name: string;
  owner_email: string;
  source_kind: "upload" | "paste";
  source_filename: string | null;
  status: JobStatus;
  output_filename: string | null;
  error: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}
