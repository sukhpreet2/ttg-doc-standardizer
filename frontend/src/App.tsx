import { useEffect, useState, useCallback } from "react";
import { UploadForm } from "./components/UploadForm";
import { JobList } from "./components/JobList";
import { listJobs } from "./api";
import type { DocumentJob } from "./types";

const ACTIVE_STATUSES = new Set(["pending", "extracting", "structuring", "rendering"]);

export function App() {
  const [jobs, setJobs] = useState<DocumentJob[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setJobs(await listJobs());
      setLoadError(null);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Could not load documents.");
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Documents render in the background now (the POST returns as soon as the
  // job is created), so poll while anything is still in flight to pick up
  // status changes — extracting -> structuring -> rendering -> complete/failed.
  const hasActiveJob = jobs.some((j) => ACTIVE_STATUSES.has(j.status));
  useEffect(() => {
    if (!hasActiveJob) return;
    const interval = setInterval(refresh, 2000);
    return () => clearInterval(interval);
  }, [hasActiveJob, refresh]);

  return (
    <div className="app">
      <header className="app-header">
        <h1>
          <span className="brand">Tartigrade</span> Document Standardizer
        </h1>
        <span className="sub">Upload content · get a standard TTG report back</span>
      </header>

      <UploadForm
        onCreated={(job) => {
          setJobs((prev) => [job, ...prev.filter((j) => j.id !== job.id)]);
        }}
      />

      {loadError && <div className="error">{loadError}</div>}

      <JobList jobs={jobs} onChanged={refresh} />
    </div>
  );
}
