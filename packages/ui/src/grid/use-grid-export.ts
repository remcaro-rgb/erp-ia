"use client";

import { useCallback, useEffect } from "react";
import { requestExport, type ExportOptions, type ExportResult } from "./export-client";
import { useExportJobs } from "./export-jobs";
import type { ExportFormat, GridStateInput } from "./types";

export type { ExportStatus } from "./export-jobs";
export { READY_CLEARS_MS } from "./export-jobs";

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

/**
 * Runs the PDF / Excel / CSV export of a grid and tells how it is going (one at a time per entity). Inside the shell the
 * job belongs to `ExportJobsProvider` and survives this grid (a tab change); a bare grid aborts it when it unmounts.
 */
export function useGridExport({ entity, title, endpoint, fetcher, pollMs, maxWaitMs, download = browserDownload }: UseGridExportOptions) {
  const jobs = useExportJobs();
  const { attach } = jobs;
  useEffect(() => attach(entity), [attach, entity]);
  const status = jobs.statusOf(entity);

  const run = useCallback(
    (format: ExportFormat, state: GridStateInput) =>
      jobs.start(entity, format, title, async (signal, onJob) => {
        const result = await requestExport({ entity, format, state, ...(title ? { title } : {}) }, { endpoint, fetcher, pollMs, maxWaitMs, signal, onJob });
        download(result);
        return result.fileName ?? `${entity}.${format}`;
      }),
    [jobs, entity, title, endpoint, fetcher, pollMs, maxWaitMs, download],
  );

  return { status, run, busy: status.phase === "working" || status.phase === "job" };
}
