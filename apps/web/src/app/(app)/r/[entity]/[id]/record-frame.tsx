"use client";

import { createContext, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { useFormatter, useTranslations } from "next-intl";
import { barButtons, browserDownload, NotifyDialog, RecordActions, RecordBridgeProvider, RecordFrame, recordHref, useTabs, type RecordActionOutcome, type RecordBarAction, type RecordBridge, type RecordFrameProps, type RecordRights } from "@erp/ui";
import type { LifecycleFlags, RecordStatus } from "@erp/kernel/lifecycle";
import { runEntryAction } from "@/lib/accounting/entry-actions";
import { SaveAsTemplateDialog } from "./save-as-template";
import { openCreatedRecord } from "@/lib/records/open-created";
import { requestStepUp } from "@/lib/auth/step-up-client";
import { cloneRecordAction } from "@/lib/records/clone";
import { notifyRecordAction, printRecordAction, runRecordAction } from "@/lib/records/lifecycle-actions";
import { currentClone, finishClone, handOffClone, leaveClone, subscribeClones, takeClone, type CloneHandoff } from "@/lib/records/clone-handoff";
import { NEW_RECORD_ID } from "@/lib/records/entities";
import { actionKey, chainedStep, keepNotice, stepLeftAfterSave, stepsAfterSave, takeNotice, takeNoticeLink, type NoticeLink } from "@/lib/records/bar-flow";

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

/**
 * While the action bar's Guardar runs, the form's save does not navigate or reload by itself: the bar still has the lifecycle step
 * (a documento's Grabar, «Guardar y enviar a aprobación»'s Enviar) to run, then it goes to the record. `lastSaved` is the saved id.
 */
interface SaveHold {
  /** The bar's Guardar is running: the form leaves the navigation to it. */
  held: () => boolean;
  /**
   * The form saved the record `id`; `updatedAt` is the version the save wrote, when its process answers it (minor 9); `status` is the
   * lifecycle status the save left it in, when its process answers it (a create that already routed it to approval: pending).
   */
  saved: (id: string, updatedAt?: string | null, status?: string | null) => void;
  /**
   * The form saved `id` outside the bar's run (with the step-up code its save asked for): the lifecycle step the bar's Guardar still
   * had goes on (minor 6). True when there was one: it then opens or reloads the record itself.
   */
  resume: (id: string) => boolean;
}
const HoldContext = createContext<SaveHold | null>(null);
export const useSaveHold = () => useContext(HoldContext);

/** A refusal that happened while a new record was being saved, shown by the bar of the record once it opens. */
const flashes = new Map<string, string>();

/** The facts the action bar needs (Task 15), computed by the page's server. */
export interface FrameLifecycle {
  entityType: "maestro" | "documento";
  status: RecordStatus;
  flags: LifecycleFlags;
  rights: RecordRights;
  tools: { new: boolean; print: boolean; notify: boolean };
  updatedAt: string | null;
  createdAt: string | null;
  createdBy: string | null;
  updatedBy: string | null;
  recipients: string[];
  /** The entity's noun (`{tipo}` of the Notificar subject). */
  noun: string;
  /** A comprobante may be reversed (posted and not yet reversed) by this caller: Revertir. */
  reverse?: boolean;
  /** A stored comprobante may be kept as a plantilla de comprobante by this caller: Guardar como plantilla, next to Revertir. */
  saveTemplate?: boolean;
  /** Where Eliminar leaves to (the entity's grid). */
  listHref: string;
  /**
   * Guardar only saves the Datos form (create or update): the documento's Grabar is a step of its own (an invoice's or a note's «Emitir»,
   * plan 2B Task 20, which numbers it by the DIAN resolution and posts it; a Borrador is saved as a Borrador).
   */
  saveOnly?: boolean;
  /**
   * A module's own buttons for the record, shown in the bar next to Guardar on every tab (plan 2B Task 20 fix round 1: an invoice's Emitir,
   * Reintentar envío and «Anular (nota crédito)»). Other entities leave it out and their bar is unchanged.
   */
  extraActions?: ReactNode;
}

export type AppRecordFrameProps = Omit<RecordFrameProps, "onDuplicate" | "duplicating" | "copyOf"> & {
  /** A maestro or documento: the standard action bar in the tabs bar (its Guardar saves the Datos form; owner 2026-11-05). */
  lifecycle?: FrameLifecycle | null;
  entity: string;
  /** Null on the create form. */
  recordId: string | null;
  /** The caller may create a copy of this stored record. */
  canDuplicate?: boolean;
  /** Title of the tab the copy opens in ("Crear tercero"). */
  newTitle: string;
};

export function AppRecordFrame({ entity, recordId, canDuplicate = false, newTitle, lifecycle = null, ...frame }: AppRecordFrameProps) {
  const t = useTranslations();
  const router = useRouter();
  const format = useFormatter();
  const close = useTabs((s) => s.close);
  const hold = useRef(false);
  const lastSaved = useRef<{ id: string; updatedAt: string | null; status?: string | null } | null>(null);
  const chain = useRef(chainedStep());
  const holdValue = useMemo<SaveHold>(
    () => ({
      held: () => hold.current,
      saved: (id, updatedAt = null, status = null) =>
        (lastSaved.current = {
          id,
          updatedAt: updatedAt ?? (lastSaved.current?.id === id ? lastSaved.current.updatedAt : null),
          status: status ?? (lastSaved.current?.id === id ? (lastSaved.current.status ?? null) : null),
        }),
      resume: (id) =>
        chain.current.resume(id, lastSaved.current?.id === id ? lastSaved.current.updatedAt : null, lastSaved.current?.id === id ? (lastSaved.current.status ?? null) : null),
    }),
    [],
  );
  const [notifyOpen, setNotifyOpen] = useState(false);
  const [templateOpen, setTemplateOpen] = useState(false);
  const [sent, setSent] = useState<string | null>(null);
  const [flash] = useState(() => {
    const key = `${entity}:${recordId}`;
    const message = flashes.get(key) ?? null;
    flashes.delete(key);
    return message;
  });
  // Minor 7: the success notice of the action that led here (kept across its navigation); a reload in place drops the kept copy.
  const [flashNotice] = useState(() => takeNotice(`${entity}:${recordId}`));
  const [flashNoticeLink] = useState(() => takeNoticeLink(`${entity}:${recordId}`));
  const version = lifecycle?.updatedAt ?? null;
  useEffect(() => {
    takeNotice(`${entity}:${recordId}`);
    takeNoticeLink(`${entity}:${recordId}`);
  }, [entity, recordId, version]);
  const shortcut = useRef<() => void>(() => {});
  const open = useTabs((s) => s.open);
  const tabsApi = useTabs((s) => s);
  // Cerrar: closes this page's tab (the one whose address is the page's) and goes to the entity's list.
  const closePage = (listHref: string) => {
    const here = window.location.pathname + window.location.search;
    const tab = tabsApi.tabs.find((t) => t.href === here) ?? tabsApi.tabs.find((t) => t.id === tabsApi.activeId);
    if (tab) close(tab.id);
    router.replace(listHref);
  };
  const rename = useTabs((s) => s.rename);
  // The tab of a stored record is named by the record itself, as its page learns it (the shell only knew the entity).
  const frameTitle = typeof frame.title === "string" ? frame.title : null;
  useEffect(() => {
    if (recordId !== null && frameTitle) rename(recordHref(entity, recordId), frameTitle);
  }, [entity, recordId, frameTitle, rename]);
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

  const ta = (key: string, values?: Record<string, string | number>) => t(`common.record.actions.${key}`, values);
  const reason = (o: Extract<RecordActionOutcome, { ok: false }>) => (o.messages.length > 0 ? o.messages.join(" · ") : t.has(`errors.${o.code}`) ? t(`errors.${o.code}`) : t("errors.unknown"));

  /** After the bar acted: a new record opens as itself (a refusal travels with it), a stored one reloads; a notice outlives either. */
  const finish = (id: string | null, failure: string | null, notice?: string, link?: NoticeLink) => {
    if (id && notice && !failure) keepNotice(`${entity}:${id}`, notice, link);
    if (recordId === null && id) {
      if (failure) flashes.set(`${entity}:${id}`, failure);
      finishClone(entity);
      openCreatedRecord({ open, close, replace: (href) => router.replace(href) }, entity, id, newTitle);
    } else router.refresh();
  };

  const saveThen = async (bridge: RecordBridge, lc: FrameLifecycle, submit: boolean): Promise<RecordActionOutcome> => {
    chain.current.disarm();
    if (bridge.state.dirty || recordId === null) {
      hold.current = true;
      lastSaved.current = null;
      let ok: boolean;
      try {
        ok = await bridge.save();
      } finally {
        hold.current = false;
      }
      const saved = lastSaved.current as { id: string; updatedAt: string | null; status?: string | null } | null;
      if (!ok || !saved) {
        // The form shows its own refusal (fields, step-up) and keeps the user's edits. When it asked for a step-up code, its save with
        // the code goes on with this step (minor 6); any other refusal is saved again through the bar, which disarms it.
        chain.current.arm(async (id, updatedAt, status) => {
          // The save with the code may itself have left the record pending approval: nothing is left to run (Task 14b).
          if (!stepLeftAfterSave(status)) {
            finish(id, null);
            return;
          }
          const outcome = await afterSave(lc, submit, id, true, updatedAt);
          if (!outcome.ok && outcome.code !== "shown") setFailure(outcome.messages.length > 0 ? outcome.messages.join(" · ") : ta("refused", { action: ta(submit ? "save_submit" : "save"), reason: reason(outcome) }));
        });
        return { ok: false, code: "shown", messages: [] };
      }
      // A documento its own save already routed to approval (a cotización or a pedido whose discount or credit asks for it, Task 14b):
      // there is no Grabar or Enviar left to run, the record opens as it stands.
      if (!stepLeftAfterSave(saved.status)) {
        finish(saved.id, null);
        return { ok: true };
      }
      return afterSave(lc, submit, saved.id, true, saved.updatedAt);
    }
    if (!recordId) return { ok: false, code: "shown", messages: [] };
    return afterSave(lc, submit, recordId, false, lc.updatedAt);
  };

  /**
   * The lifecycle step after the form's save: a documento's Grabar (it posts in the same action when it posts, D8), then the submit of
   * «Guardar y enviar a aprobación». `version` is the one the user last saw or saved (minor 9: the form save answers it); a change by
   * someone else in between answers stale_record. Each step runs under the click's idempotency key (minor 2).
   */
  const afterSave = async (lc: FrameLifecycle, submit: boolean, id: string, savedNow: boolean, savedVersion: string | null): Promise<RecordActionOutcome> => {
    let version: string | null = savedVersion;
    let message: string | undefined;
    const plan = stepsAfterSave(lc, submit, savedNow);
    if (plan.grabar) {
      const grabado = await runRecordAction(entity, "save", id, version ? { expectedUpdatedAt: version } : {}, undefined, actionKey(`${entity}.save`));
      if (!grabado.ok) {
        const failure = grabado.code === "stale_record" ? ta("stale") : ta("refused", { action: ta("save"), reason: reason(grabado) });
        finish(savedNow ? id : null, recordId === null ? failure : null);
        return recordId === null ? { ok: true } : grabado;
      }
      version = grabado.updatedAt ?? null;
      message = grabado.message;
    } else if (plan.nothing) return { ok: true };
    if (submit) {
      const sentTo = await runRecordAction(entity, "submit", id, version ? { expectedUpdatedAt: version } : {}, undefined, actionKey(`${entity}.submit`));
      if (!sentTo.ok) {
        const failure = ta("saved_not_submitted", { reason: reason(sentTo) });
        finish(id, recordId === null ? failure : null);
        return recordId === null ? { ok: true } : { ok: false, code: "saved_not_submitted", messages: [failure] };
      }
      message = sentTo.message;
    }
    finish(id, null, message);
    return message ? { ok: true, message } : { ok: true };
  };

  const act = async (bridge: RecordBridge, lc: FrameLifecycle, action: RecordBarAction, input: { reason?: string }, token?: string): Promise<RecordActionOutcome> => {
    setSent(null);
    if (action !== "notify") chain.current.disarm();
    switch (action) {
      case "new":
        open({ title: newTitle, href: `/r/${entity}/${NEW_RECORD_ID}`, kind: "record" });
        return { ok: true };
      case "duplicate":
        await duplicate();
        return { ok: true };
      case "notify":
        setNotifyOpen(true);
        return { ok: true };
      case "save":
      case "save_submit":
        return saveThen(bridge, lc, action === "save_submit");
      default:
        break;
    }
    if (!recordId) return { ok: false, code: "invalid_input", messages: [] };
    if (action === "print") {
      const printed = await printRecordAction(entity, recordId, typeof frame.title === "string" ? frame.title : undefined);
      if (!printed.ok) return printed;
      const response = await fetch(`/api/export/${encodeURIComponent(printed.fileId)}`, { cache: "no-store" });
      const job = (await response.json().catch(() => null)) as { url?: string; fileName?: string } | null;
      if (!response.ok || !job?.url) return { ok: false, code: "unavailable", messages: [] };
      browserDownload({ kind: "link", url: job.url, ...(job.fileName ? { fileName: job.fileName } : {}) });
      return { ok: true };
    }
    if (action === "reverse") {
      const reversed = await runEntryAction("reverse", recordId, input, token, actionKey("accounting.entry.reverse"));
      if (reversed.ok) finish(recordId, null, reversed.message, reversed.link);
      return reversed;
    }
    const outcome = await runRecordAction(entity, action, recordId, { ...input, ...(lc.updatedAt ? { expectedUpdatedAt: lc.updatedAt } : {}) }, token, actionKey(`${entity}.${action}`));
    if (!outcome.ok) return outcome;
    if (action === "delete") {
      close(`/r/${entity}/${recordId}`);
      router.replace(lc.listHref);
    } else finish(recordId, null, outcome.message);
    return outcome;
  };

  const when = (at: string | null) => (at ? format.dateTime(new Date(at), { dateStyle: "short", timeStyle: "short" }) : "—");
  const subject = (lc: FrameLifecycle) => {
    const number = typeof frame.number === "string" && frame.number ? frame.number : null;
    const estado = t(`common.record.status.${lc.status}`);
    return number ? t("common.notify.subject", { tipo: lc.noun, numero: number, estado }) : t("common.record.notify_dialog.subject_id", { tipo: lc.noun, seq: typeof frame.seq === "number" ? frame.seq : "", estado });
  };

  return (
    <CloneContext.Provider value={shared}>
      <HoldContext.Provider value={holdValue}>
        {failure && (
          <div role="alert" className="erp-dian erp-dian--bad">
            {failure}
          </div>
        )}
        <RecordBridgeProvider onShortcut={() => shortcut.current()}>
          {(bridge) => {
            const lc = lifecycle;
            const bar = lc ? (
              <RecordActions
                entityType={lc.entityType}
                status={lc.status}
                flags={lc.flags}
                rights={bridge.registered ? lc.rights : { ...lc.rights, modify: false }}
                dirty={bridge.state.dirty}
                saveBlocked={(bridge.state.dirty || recordId === null) && !bridge.state.ready}
                tools={{
                  new: lc.tools.new && recordId !== null,
                  print: lc.tools.print && recordId !== null,
                  notify: lc.tools.notify && recordId !== null,
                  duplicate: recordId !== null && canDuplicate,
                  reverse: lc.reverse === true && recordId !== null,
                  saveTemplate: lc.saveTemplate === true && recordId !== null,
                }}
                onSaveTemplate={() => setTemplateOpen(true)}
                onClose={() => closePage(lc.listHref)}
                initialProblem={flash}
                initialNotice={flashNotice}
                initialNoticeLink={flashNoticeLink}
                onAction={(action, input, token) => act(bridge, lc, action, input, token)}
                requestStepUp={requestStepUp}
                disabled={busy}
                registerShortcut={(run) => (shortcut.current = run)}
                {...(lc.extraActions ? { extra: lc.extraActions } : {})}
              />
            ) : undefined;
            const meta =
              lc && recordId !== null ? (
                <>
                  <span>{t("common.record.footer.created", { at: when(lc.createdAt), by: lc.createdBy ?? t("common.record.footer.unknown_user") })}</span>
                  <span>{t("common.record.footer.modified", { at: when(lc.updatedAt), by: lc.updatedBy ?? t("common.record.footer.unknown_user") })}</span>
                  {sent && <span role="status">{sent}</span>}
                </>
              ) : undefined;
            // While the Datos form holds edits the header offers «Descartar cambios» and «Guardar cambios» (owner 2026-11-05); the latter is
            // the bar's Guardar (save, then the lifecycle step), or the form's own save on a frame without the bar.
            const dirty = bridge.registered && bridge.state.dirty;
            const saveChanges = () => {
              if (bar) shortcut.current();
              else void bridge.save();
            };
            return (
              <>
                <RecordFrame
                  {...frame}
                  {...(bar ? { toolbar: bar } : {})}
                  {...(meta ? { meta } : {})}
                  dirty={dirty}
                  saveBlocked={busy || !bridge.state.ready || (lc !== null && !barButtons(lc.entityType, lc.status, lc.flags, lc.rights).some((b) => b.action === "save"))}
                  onSaveChanges={saveChanges}
                  {...(bridge.canDiscard ? { onDiscardChanges: bridge.discard } : {})}
                  duplicateButton={!bar}
                  {...(recordId && canDuplicate ? { onDuplicate: () => void duplicate(), duplicating: busy } : {})}
                  copyOf={clone ? { title: clone.sourceTitle, href: recordHref(entity, clone.sourceRowId) } : null}
                />
                {lc && recordId && lc.saveTemplate === true && <SaveAsTemplateDialog entryId={recordId} open={templateOpen} onClose={() => setTemplateOpen(false)} />}
                {lc && recordId && lc.tools.notify && notifyOpen && (
                  <NotifyDialog
                    open
                    onClose={() => setNotifyOpen(false)}
                    name={typeof frame.title === "string" ? frame.title : lc.noun}
                    recipients={lc.recipients}
                    subject={subject(lc)}
                    onSend={(mail, token) => notifyRecordAction(entity, recordId, mail, token, actionKey("kernel.record.notify"))}
                    requestStepUp={requestStepUp}
                    onSent={(count) => setSent(t("common.record.notify_dialog.sent", { count }))}
                  />
                )}
              </>
            );
          }}
        </RecordBridgeProvider>
      </HoldContext.Provider>
    </CloneContext.Provider>
  );
}
