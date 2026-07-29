import type { DocumentJob } from "./types";

const BASE = `${import.meta.env.VITE_API_URL}/api/documents`;

async function handle<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let message = `Request failed (${res.status})`;
    try {
      const body = await res.json();
      if (body?.error) message = body.error;
    } catch {
      /* ignore */
    }
    throw new Error(message);
  }
  return res.json() as Promise<T>;
}

export interface StandardizeInput {
  title: string;
  version: string;
  ownerName: string;
  ownerTitle?: string;
  ownerEmail: string;
  file?: File | null;
  content?: string;
}

export async function standardize(input: StandardizeInput): Promise<DocumentJob> {
  const form = new FormData();
  form.append("title", input.title);
  form.append("version", input.version);
  form.append("ownerName", input.ownerName);
  if (input.ownerTitle) form.append("ownerTitle", input.ownerTitle);
  form.append("ownerEmail", input.ownerEmail);

  if (input.file) form.append("file", input.file);
  else if (input.content) form.append("content", input.content);

  const res = await fetch(BASE, {
    method: "POST",
    body: form
  });

  return handle<DocumentJob>(res);
}

export async function listJobs(): Promise<DocumentJob[]> {
  return handle<DocumentJob[]>(await fetch(BASE));
}

export async function deleteJob(id: number): Promise<void> {
  const res = await fetch(`${BASE}/${id}`, {
    method: "DELETE"
  });

  if (!res.ok && res.status !== 204) {
    throw new Error(`Delete failed (${res.status})`);
  }
}

export function downloadUrl(id: number): string {
  return `${BASE}/${id}/download`;
}