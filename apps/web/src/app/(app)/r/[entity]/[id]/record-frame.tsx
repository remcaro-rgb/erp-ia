"use client";

import { createContext, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useTranslations } from "next-intl";
import { RecordFrame, recordHref, useTabs, type RecordFrameProps } from "@erp/ui";
import { cloneRecordAction } from "@/lib/records/clone";
import { currentClone, finishClone, handOffClone, leaveClone, subscribeClones, takeClone, type CloneHandoff } from "@/lib/records/clone-handoff";
import { NEW_RECORD_ID } from "@/lib/records/entities";

// The record frame of the app (rule 37): on a stored record the caller may copy, "Duplicar" (or Ctrl+D / ⌘+D) reads
// the copy through the server action and opens `/r/<entity>/new` with it; there the frame shows "Copia de <nombre>"
// and the Datos form (record-form.tsx) starts from the copy and saves it with its source.

interface RecordClone {
  /** The copy the new record's form starts from, when it was opened by "Duplicar". */
  clone: CloneHandoff | null;
  /** The copy was saved: it goes, and the form starts empty the next time it is shown. */
  done: () => void;
}

const CloneContext = createContext<RecordClone>({ clone: null, done: () => {} });

export const useRecordClone = () => useContext(CloneContext);

export type AppRecordFrameProps = Omit<RecordFrameProps, "onDuplicate" | "duplicating" | "copyOf"> & {
  entity: string;
  /** Null on the create form. */
  recordId: string | null;
  /** The caller may create a copy of this stored record. */
  canDuplicate?: boolean;
  /** Title of the tab the copy opens in ("Crear tercero"). */
  newTitle: string;
};

export function AppRecordFrame({ entity, recordId, canDuplicate = false, newTitle, ...frame }: AppRecordFrameProps) {
  const t = useTranslations();
  const open = useTabs((s) => s.open);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  // The create form shows the copy handed to its entity and takes it once shown; leaving the form (the router hides a
  // visited page) lets the copy go, so the form shown again later without a fresh "Duplicar" is empty.
  const clone = useSyncExternalStore(subscribeClones, () => (recordId === null ? currentClone(entity) : null), () => null);
  useEffect(() => {
    if (recordId !== null) return;
    takeClone(entity);
  }, [entity, recordId, clone]);
  useEffect(() => {
    if (recordId !== null) return;
    return () => leaveClone(entity);
  }, [entity, recordId]);
  const shared = useMemo<RecordClone>(() => ({ clone, done: () => finishClone(entity) }), [clone, entity]);
  const running = useRef(false);

  const duplicate = async () => {
    if (!recordId || running.current) return;
    running.current = true;
    setBusy(true);
    setFailure(null);
    try {
      const result = await cloneRecordAction(entity, recordId);
      if (!result.ok) {
        const code = t.has(`errors.${result.code}`) ? result.code : "unknown";
        setFailure(t("common.record.duplicate_failed", { reason: t(`errors.${code}`) }));
        return;
      }
      handOffClone(result);
      open({ title: newTitle, href: `/r/${entity}/${NEW_RECORD_ID}`, kind: "record" });
    } finally {
      running.current = false;
      setBusy(false);
    }
  };

  return (
    <CloneContext.Provider value={shared}>
      {failure && (
        <div role="alert" className="erp-dian erp-dian--bad">
          {failure}
        </div>
      )}
      <RecordFrame
        {...frame}
        {...(recordId && canDuplicate ? { onDuplicate: () => void duplicate(), duplicating: busy } : {})}
        copyOf={clone ? { title: clone.sourceTitle, href: recordHref(entity, clone.sourceRowId) } : null}
      />
    </CloneContext.Provider>
  );
}
