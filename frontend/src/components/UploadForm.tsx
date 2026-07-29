import { useState, useRef, DragEvent } from "react";
import { standardize } from "../api";
import type { DocumentJob } from "../types";

const ACCEPT = ".docx,.pdf,.xlsx,.xlsm,.xls,.csv,.tsv,.txt,.md,.json";

interface Props {
  onCreated: (job: DocumentJob) => void;
}

export function UploadForm({ onCreated }: Props) {
  const [mode, setMode] = useState<"upload" | "paste">("upload");
  const [title, setTitle] = useState("");
  const [version, setVersion] = useState("v1");
  const [ownerName, setOwnerName] = useState("");
  const [ownerEmail, setOwnerEmail] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [content, setContent] = useState("");
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  function reset() {
    setTitle("");
    setVersion("v1");
    setOwnerName("");
    setOwnerEmail("");
    setFile(null);
    setContent("");
  }

  function onDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDragging(false);
    if (e.dataTransfer.files?.[0]) setFile(e.dataTransfer.files[0]);
  }

  async function submit() {
    setError(null);
    if (!title.trim() || !ownerName.trim() || !ownerEmail.trim()) {
      setError("Title, owner name, and owner email are required.");
      return;
    }
    if (mode === "upload" && !file) {
      setError("Choose a file to upload.");
      return;
    }
    if (mode === "paste" && !content.trim()) {
      setError("Paste some content to standardize.");
      return;
    }
    setBusy(true);
    try {
      const job = await standardize({
        title: title.trim(),
        version: version.trim() || "v1",
        ownerName: ownerName.trim(),
        ownerEmail: ownerEmail.trim(),
        file: mode === "upload" ? file : null,
        content: mode === "paste" ? content : undefined,
      });
      onCreated(job);
      reset();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card">
      <h2>Standardize a document</h2>

      <div className="grid2">
        <div className="field">
          <label htmlFor="title">Document title</label>
          <input
            id="title"
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="e.g. Connect Onboarding Spec"
          />
        </div>
        <div className="field">
          <label htmlFor="version">Version</label>
          <input
            id="version"
            type="text"
            value={version}
            onChange={(e) => setVersion(e.target.value)}
            placeholder="v1"
          />
        </div>
        <div className="field">
          <label htmlFor="owner">Document owner</label>
          <input
            id="owner"
            type="text"
            value={ownerName}
            onChange={(e) => setOwnerName(e.target.value)}
            placeholder="Ryan Ware"
          />
        </div>
        <div className="field">
          <label htmlFor="email">Owner email</label>
          <input
            id="email"
            type="email"
            value={ownerEmail}
            onChange={(e) => setOwnerEmail(e.target.value)}
            placeholder="rware@ttgteams.com"
          />
        </div>
      </div>

      <div className="tabs">
        <button
          className={mode === "upload" ? "active" : ""}
          onClick={() => setMode("upload")}
          type="button"
        >
          Upload file
        </button>
        <button
          className={mode === "paste" ? "active" : ""}
          onClick={() => setMode("paste")}
          type="button"
        >
          Paste text
        </button>
      </div>

      {mode === "upload" ? (
        <div
          className={`dropzone ${dragging ? "drag" : ""}`}
          onClick={() => fileInput.current?.click()}
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
        >
          {file ? (
            <span className="filename">{file.name}</span>
          ) : (
            <span>Drop a file here, or click to browse</span>
          )}
          <small>Supported: .docx · .pdf · .xlsx / .csv · .txt · .md · .json</small>
          <input
            ref={fileInput}
            type="file"
            accept={ACCEPT}
            style={{ display: "none" }}
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          />
        </div>
      ) : (
        <textarea
          value={content}
          onChange={(e) => setContent(e.target.value)}
          placeholder="Paste the content you want turned into a standardized TTG document…"
        />
      )}

      {error && <div className="error">{error}</div>}

      <div style={{ marginTop: 16 }}>
        <button className="primary" onClick={submit} disabled={busy} type="button">
          {busy && <span className="spinner" />}
          {busy ? "Standardizing…" : "Generate standardized document"}
        </button>
      </div>
    </div>
  );
}
