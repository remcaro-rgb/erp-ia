"use client";

import { useState, type ReactNode } from "react";
import { useTranslations } from "next-intl";
import { useLeaveGuard } from "../../_components/leave-guard";
import { useAdminAction } from "./use-admin-action";
import { changesOf, rebase, refusedCells, stage, stageAll, type Staged } from "./staging";

export interface StagedChanges<V> {
  /** What the cell shows: the staged value, the value just applied (until the server data says it), or `stored`. */
  value: (key: string, stored: V) => V;
  /** The cell holds a change not applied yet ("pendiente"). */
  isStaged: (key: string) => boolean;
  /** Why the last batch refused this cell, if it did. */
  refusal: (key: string) => string | undefined;
  /** Stages a cell (or drops it when it is back to `stored`). */
  set: (key: string, value: V, stored: V) => void;
  /** Stages several cells at once. */
  setAll: (cells: { key: string; value: V; stored: V }[]) => void;
  count: number;
  /** A batch is being applied: the cells and buttons wait. */
  busy: boolean;
  /** The fixed bar under the matrix: the pending count (a live region), the outcome, Descartar and Aplicar cambios. */
  bar: (idle: ReactNode) => ReactNode;
  /** The step-up prompt while the batch waits for the code. */
  prompt: ReactNode;
}

interface Options<V, C> {
  /** The server data the matrix shows: new data rebases the staged cells on it. */
  data: unknown;
  /** The stored value of a cell in `data`; undefined when the data no longer has the cell. */
  stored: (key: string) => V | undefined;
  /** The batch process (kernel.admin.permission.set_many, kernel.admin.field_permission.set_many). */
  processId: string;
  /** One change of the batch's input from a staged cell. */
  change: (key: string, value: V) => C;
}

/**
 * The admin matrices' staged editing (OD-7, design §22.11): cells change locally and are applied together by one batch
 * process, with one step-up (rules 1 and 15). A refused batch applies nothing (one transaction) and comes back with the
 * index of each refused change: those cells are marked and everything stays staged. Leaving with staged changes asks.
 */
export function useStagedChanges<V, C>({ data, stored, processId, change }: Options<V, C>): StagedChanges<V> {
  const t = useTranslations();
  const { perform, prompt, status, busy, reset } = useAdminAction();
  const [pending, setPending] = useState<Staged<V>>({});
  const [applied, setApplied] = useState<Staged<V>>({});
  const [refused, setRefused] = useState<Record<string, string>>({});
  const [shown, setShown] = useState(data);
  if (shown !== data) {
    setShown(data);
    setPending(rebase(pending, stored));
    setApplied({});
  }
  const count = Object.keys(pending).length;
  const leave = useLeaveGuard(count);

  const set = (key: string, value: V, storedValue: V) => {
    setPending((p) => stage(p, key, value, storedValue));
    setRefused((r) => {
      if (!(key in r)) return r;
      const next = { ...r };
      delete next[key];
      return next;
    });
    reset();
  };
  const setAll = (cells: { key: string; value: V; stored: V }[]) => {
    setPending((p) => stageAll(p, cells));
    reset();
  };
  const discard = () => {
    setPending({});
    setRefused({});
    reset();
  };
  const apply = async () => {
    const batch = pending;
    const keys = Object.keys(batch);
    if (keys.length === 0) return;
    setRefused({});
    const ok = await perform(processId, { changes: changesOf(batch, change) }, { onRefused: (details) => setRefused(refusedCells(keys, details)) });
    if (ok) {
      // Shown as applied until router.refresh() brings the stored data.
      setApplied(batch);
      setPending({});
    }
  };

  const bar = (idle: ReactNode) => (
    <div className="erp-admin__bar">
      {/* Always mounted, so a screen reader hears the count change. */}
      <span role="status" className="erp-admin__pending">
        {count > 0 ? <span className="erp-pill erp-pill--warn">{t("common.admin.pending_changes", { count })}</span> : null}
      </span>
      {leave ?? (
        <>
          {status ?? <span className="erp-small erp-muted erp-grow">{count > 0 ? t("common.admin.batch_note") : idle}</span>}
          {count > 0 && (
            <>
              <button type="button" className="erp-btn" onClick={discard} disabled={busy}>
                {t("common.admin.discard_changes")}
              </button>
              <button type="button" className="erp-btn erp-btn--primary" onClick={() => void apply()} disabled={busy}>
                {t("common.admin.apply_changes")}
              </button>
            </>
          )}
        </>
      )}
    </div>
  );

  return {
    value: (key, storedValue) => (key in pending ? pending[key]! : key in applied ? applied[key]! : storedValue),
    isStaged: (key) => key in pending,
    refusal: (key) => refused[key],
    set,
    setAll,
    count,
    busy,
    bar,
    prompt,
  };
}
