"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ExportRequestError, requestExport, type ExportOptions, type ExportResult } from "./export-client";
import type { ExportFormat, GridStateInput } from "./types";

export type ExportStatus =
  | { phase: "idle" }
  | { phase: "working"; format: ExportFormat }
  /** Too many rows for a request: the server makes the file in the background and the download starts when it is ready. */
  | { phase: "job"; format: ExportFormat }
  | { phase: "ready"; fileName: string }
  | { phase: "failed"; code: string; detail?: string };

/** How long "Descarga lista: …" stays in the grid header. */
export const READY_CLEARS_MS = 8_000;

/** Saves the exported file: an inline file through an object URL, a job's file through its signed link. */
export function browserDownload(result: ExportResult): void {
  const link = document.createElement("a");
  if (result.kind === "file") {
    link.href = URL.createObjectURL(result.blob);
    link.download = result.fileName;
  } else {
    link.href = result.url;
    if (result.fileName) link.download = result.fileName;
  }
  link.rel = "noopener";
  document.body.append(link);
  link.click();
  link.remove();
  if (result.kind === "file") setTimeout(() => URL.revokeObjectURL(link.href), 30_000);
}

export interface UseGridExportOptions extends Pick<ExportOptions, "endpoint" | "fetcher" | "pollMs" | "maxWaitMs"> {
  entity: string;
  /** The screen's name: the exported file and its sheet are named after it. */
  title?: string;
  download?: (result: ExportResult) => void;
}

/** Runs the PDF / Excel / CSV export of a grid and tells how it is going (one at a time). */
export function useGridExport({ entity, title, endpoint, fetcher, pollMs, maxWaitMs, download = browserDownload }: UseGridExportOptions) {
  const [status, setStatus] = useState<ExportStatus>({ phase: "idle" });
  const running = useRef<AbortController | null>(null);
  useEffect(() => () => running.current?.abort(), []);
  // "Descarga lista" is news, not a state: it clears after 8 s (UI density audit L10).
  useEffect(() => {
    if (status.phase !== "ready") return;
    const timer = setTimeout(() => setStatus((current) => (current === status ? { phase: "idle" } : current)), READY_CLEARS_MS);
    return () => clearTimeout(timer);
  }, [status]);

  const run = useCallback(
    async (format: ExportFormat, state: GridStateInput) => {
      if (running.current) return;
      const controller = new AbortController();
      running.current = controller;
      setStatus({ phase: "working", format });
      try {
        const result = await requestExport(
          { entity, format, state, ...(title ? { title } : {}) },
          { endpoint, fetcher, pollMs, maxWaitMs, signal: controller.signal, onJob: () => setStatus({ phase: "job", format }) },
        );
        download(result);
        setStatus({ phase: "ready", fileName: result.fileName ?? `${entity}.${format}` });
      } catch (error) {
        if (error instanceof ExportRequestError && error.code === "aborted") return;
        setStatus(
          error instanceof ExportRequestError ? { phase: "failed", code: error.code, ...(error.detail ? { detail: error.detail } : {}) } : { phase: "failed", code: "unknown" },
        );
      } finally {
        running.current = null;
      }
    },
    [entity, title, endpoint, fetcher, pollMs, maxWaitMs, download],
  );

  return { status, run, busy: status.phase === "working" || status.phase === "job" };
}
