"use client";

import { createContext, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useTranslations } from "next-intl";
import { RecordFrame, recordHref, useTabs, type RecordFrameProps } from "@erp/ui";
import { cloneRecordAction } from "@/lib/records/clone";
import { handOffClone, pendingClone, releaseClone, subscribeClones, type CloneHandoff } from "@/lib/records/clone-handoff";
import { NEW_RECORD_ID } from "@/lib/records/entities";

// The record frame of the app (rule 37): on a stored record the caller may copy, "Duplicar" (or Ctrl+D / ⌘+D) reads
// the copy through the server action and opens `/r/<entity>/new` with it; there the frame shows "Copia de <nombre>"
// and the Datos form (record-form.tsx) starts from the copy and saves it with its source.

interface RecordClone {
  /** The copy the new record's form starts from, when it was opened by "Duplicar". */
  clone: CloneHandoff | null;
  /** The copy was saved: the form starts empty the next time it is shown. */
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
  // The create form takes the copy waiting for its entity. The router keeps a visited page alive while hidden; a hidden
  // page is not subscribed, and when it is shown again it reads the store and adopts a newer copy (a new "Duplicar").
  const waiting = useSyncExternalStore(subscribeClones, () => (recordId === null ? pendingClone(entity) : null), () => null);
  const [clone, setClone] = useState(waiting);
  if (waiting && waiting !== clone) setClone(waiting);
  // Taken: it no longer waits (a later "Nuevo" opens an empty form), and this frame keeps it until it is saved.
  useEffect(() => releaseClone(waiting), [waiting]);
  const shared = useMemo<RecordClone>(() => ({ clone, done: () => setClone(null) }), [clone]);
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
