import { deleteJob, downloadUrl, previewUrl } from "../api";
import type { DocumentJob, JobStatus } from "../types";

interface Props {
  jobs: DocumentJob[];
  onChanged: () => void;
}

function statusBadge(status: JobStatus) {
  if (status === "complete") return <span className="badge complete">Complete</span>;
  if (status === "failed") return <span className="badge failed">Failed</span>;
  return <span className="badge working">{status}</span>;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function JobList({ jobs, onChanged }: Props) {
  async function remove(id: number) {
    if (!confirm("Delete this document and its file?")) return;
    await deleteJob(id);
    onChanged();
  }

  return (
    <div className="card">
      <h2>Generated documents</h2>
      {jobs.length === 0 ? (
        <div className="empty">No documents yet. Standardize your first one above.</div>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Title</th>
              <th>Ver.</th>
              <th>Owner</th>
              <th>Source</th>
              <th>Created</th>
              <th>Status</th>
              <th>Document</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {jobs.map((j) => (
              <tr key={j.id}>
                <td>{j.title}</td>
                <td>{j.version}</td>
                <td>{j.owner_name}</td>
                <td>{j.source_kind === "upload" ? j.source_filename ?? "file" : "pasted"}</td>
                <td>{formatDate(j.created_at)}</td>
                <td>
                  {statusBadge(j.status)}
                  {j.status === "failed" && j.error && (
                    <div style={{ color: "#b42318", fontSize: 12, marginTop: 4 }}>{j.error}</div>
                  )}
                </td>
                <td>
                  {j.status === "complete" && j.output_filename ? (
                    <span className="doc-links">
                      <a
                        className="view"
                        href={previewUrl(j.id)}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        View
                      </a>
                      <a className="download" href={downloadUrl(j.id)}>
                        Download .docx
                      </a>
                    </span>
                  ) : (
                    <span style={{ color: "#9ca3af" }}>—</span>
                  )}
                </td>
                <td>
                  <button className="link" onClick={() => remove(j.id)} type="button">
                    Delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
