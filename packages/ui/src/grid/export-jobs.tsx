"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { ExportRequestError } from "./export-client";
import type { ExportFormat } from "./types";

// Exports belong to the shell, not to the grid that asked for them (UI density audit H7): changing tab unmounts the grid,
// and a 20,000-row Excel job the server is still building used to be aborted with it. The jobs live here; the file still
// downloads, and when no grid of that entity is on screen a toast says it is ready (or why it failed).

export type ExportStatus =
  | { phase: "idle" }
  | { phase: "working"; format: ExportFormat }
  /** Too many rows for a request: the server makes the file in the background and the download starts when it is ready. */
  | { phase: "job"; format: ExportFormat }
  | { phase: "ready"; fileName: string }
  | { phase: "failed"; code: string; detail?: string };

/** How long "Descarga lista: …" stays in the grid header. */
export const READY_CLEARS_MS = 8_000;

const IDLE: ExportStatus = { phase: "idle" };

/** One export: `work` asks for the file, saves it and returns its name; `onJob` says it went to the background. */
export type ExportWork = (signal: AbortSignal, onJob: () => void) => Promise<string>;

export interface ExportJobs {
  statusOf: (key: string) => ExportStatus;
  /** Starts the export of `key` (one at a time per key); `title` names the screen in the toast (the entity's name when absent). */
  start: (key: string, format: ExportFormat, title: string | undefined, work: ExportWork) => Promise<void>;
  /** A grid of `key` is on screen (it shows the outcome itself); returns the detach. */
  attach: (key: string) => () => void;
}

/** Why an export failed: the server's own reason when the screen has words for it, else the error code's. */
export function exportFailureText(t: ReturnType<typeof useTranslations>, status: { code: string; detail?: string }): string {
  if (status.detail && t.has(`grid.export.reasons.${status.detail}`)) return t(`grid.export.reasons.${status.detail}`);
  return t.has(`errors.${status.code}`) ? t(`errors.${status.code}`) : t("errors.unknown");
}

type Outcome = { key: string; title: string | undefined; status: ExportStatus };

/**
 * The jobs and their statuses; `offscreen` hears an outcome no grid is showing. With `abortOnUnmount` the owner leaving
 * (the shell on sign-out or a company switch, a bare grid) aborts what is still running: nothing downloads or toasts later.
 */
function useJobsState(offscreen: ((outcome: Outcome) => void) | null, abortOnUnmount: boolean): ExportJobs {
  const [statuses, setStatuses] = useState<Record<string, ExportStatus>>({});
  const controllers = useRef(new Map<string, AbortController>());
  const attached = useRef(new Map<string, number>());
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const offscreenRef = useRef(offscreen);
  useEffect(() => {
    offscreenRef.current = offscreen;
  }, [offscreen]);
  useEffect(
    () => () => {
      for (const timer of timers.current.values()) clearTimeout(timer);
      if (abortOnUnmount) for (const controller of controllers.current.values()) controller.abort();
    },
    [abortOnUnmount],
  );

  const set = useCallback((key: string, status: ExportStatus) => {
    clearTimeout(timers.current.get(key));
    setStatuses((current) => ({ ...current, [key]: status }));
    // "Descarga lista" is news, not a state: it clears after 8 s (UI density audit L10).
    if (status.phase === "ready") timers.current.set(key, setTimeout(() => setStatuses((current) => (current[key] === status ? { ...current, [key]: IDLE } : current)), READY_CLEARS_MS));
  }, []);

  const start = useCallback<ExportJobs["start"]>(
    async (key, format, title, work) => {
      if (controllers.current.has(key)) return;
      const controller = new AbortController();
      controllers.current.set(key, controller);
      set(key, { phase: "working", format });
      let outcome: ExportStatus | null;
      try {
        const fileName = await work(controller.signal, () => set(key, { phase: "job", format }));
        outcome = { phase: "ready", fileName };
      } catch (error) {
        outcome =
          error instanceof ExportRequestError && error.code === "aborted"
            ? null
            : error instanceof ExportRequestError
              ? { phase: "failed", code: error.code, ...(error.detail ? { detail: error.detail } : {}) }
              : { phase: "failed", code: "unknown" };
      } finally {
        controllers.current.delete(key);
      }
      set(key, outcome ?? IDLE);
      if (outcome && (attached.current.get(key) ?? 0) === 0) offscreenRef.current?.({ key, title, status: outcome });
    },
    [set],
  );

  const attach = useCallback((key: string) => {
    attached.current.set(key, (attached.current.get(key) ?? 0) + 1);
    return () => attached.current.set(key, (attached.current.get(key) ?? 1) - 1);
  }, []);

  const statusOf = useCallback((key: string) => statuses[key] ?? IDLE, [statuses]);
  return useMemo(() => ({ statusOf, start, attach }), [statusOf, start, attach]);
}

const ExportJobsContext = createContext<ExportJobs | null>(null);

/** Put once in the shell: exports outlive the grid that started them, and a toast reports the ones finished off-screen. */
export function ExportJobsProvider({ children }: { children: ReactNode }) {
  const t = useTranslations();
  const announce = useCallback(
    ({ key, title: screen, status }: Outcome) => {
      // The screen's title, else the entity's name from the catalogue (`entity.core.party`), never the bare id.
      const title = screen ?? (t.has(`entity.${key}`) ? t(`entity.${key}`) : key);
      if (status.phase === "ready") toast(t("grid.export.ready_in", { title, file: status.fileName }));
      else if (status.phase === "failed") toast(t("grid.export.failed_in", { title, reason: exportFailureText(t, status) }));
    },
    [t],
  );
  // Tab changes keep the provider mounted (exports survive them); the shell itself leaving aborts them.
  const jobs = useJobsState(announce, true);
  return <ExportJobsContext.Provider value={jobs}>{children}</ExportJobsContext.Provider>;
}

/** The shell's jobs, or this grid's own when it is used without the shell (aborted when the grid unmounts). */
export function useExportJobs(): ExportJobs {
  const shell = useContext(ExportJobsContext);
  const local = useJobsState(null, true);
  return shell ?? local;
}
