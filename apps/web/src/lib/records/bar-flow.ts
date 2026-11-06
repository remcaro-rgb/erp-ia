// The record action bar's flow across a click and the navigation that follows it (Phase 2A.5 minors 2, 6, 7). Client-side state only.

/**
 * Minor 2: the idempotency key of one click on the bar. The server action runs the process with it, so a double click (or a retried
 * request) runs the action once and answers the first run's result (kernel.process_idempotency).
 */
export function actionKey(processId: string): string {
  return `bar:${processId}:${crypto.randomUUID()}`;
}

/** How long a kept notice waits for the record's bar to show it. */
const NOTICE_TTL_MS = 10_000;
const notices = new Map<string, { message: string; at: number }>();

/** Minor 7: a success notice for the bar of `key` (`<entity>:<id>`) once the navigation that follows the action has shown it. */
export function keepNotice(key: string, message: string, link?: NoticeLink): void {
  notices.set(key, { message, at: Date.now() });
  if (link) noticeLinks.set(key, link);
  else noticeLinks.delete(key);
}

/** A record the notice names (e.g. the comprobante that reversed this one): shown as a link inside the notice's text. */
export interface NoticeLink {
  entity: string;
  id: string;
  label: string;
}
const noticeLinks = new Map<string, NoticeLink>();

/** The link kept with the notice of `key`, once (the bar takes the notice and its link together). */
export function takeNoticeLink(key: string): NoticeLink | null {
  const link = noticeLinks.get(key) ?? null;
  noticeLinks.delete(key);
  return link;
}

/** The notice kept for `key`, once (null when none, or when it waited longer than a few seconds). */
export function takeNotice(key: string): string | null {
  const kept = notices.get(key);
  notices.delete(key);
  return kept && Date.now() - kept.at <= NOTICE_TTL_MS ? kept.message : null;
}

/**
 * The lifecycle step left after the form's save (a documento's Grabar, «Guardar y enviar a aprobación»'s Enviar). `status` is where the
 * save left the record when its process answers it (Task 14b: a create that already routed it to approval answers pending).
 */
export type PendingStep = (id: string, updatedAt: string | null, status: string | null) => Promise<void>;

/**
 * Whether the bar still has a lifecycle step to run after the form saved (Task 14b): not when the save itself left the record waiting
 * for approval (a cotización or pedido over the discount threshold or the credit limit). There is no Grabar from Pendiente de Aprobación.
 */
export const stepLeftAfterSave = (status: string | null | undefined): boolean => status !== "pending";

/**
 * What the bar's Guardar runs after the form's save (`savedNow`: the form wrote something), plan 2B Task 20 fix round 1: a documento's
 * Grabar, unless the frame saves only (an invoice's or a note's Borrador is saved as a Borrador; «Emitir» is its own step), then the
 * submit of «Guardar y enviar a aprobación». `nothing`: there is nothing to run and nothing to reload (an unchanged record).
 */
export function stepsAfterSave(lc: { entityType: "maestro" | "documento"; saveOnly?: boolean }, submit: boolean, savedNow: boolean): { grabar: boolean; submit: boolean; nothing: boolean } {
  const grabar = lc.entityType === "documento" && lc.saveOnly !== true;
  return { grabar, submit, nothing: !grabar && !savedNow && !submit };
}

/**
 * Minor 6: the bar's Guardar stopped because the form's save asked for a step-up code; the step it still had to run is armed here and
 * runs, once, when the form saves with the code. The next bar action disarms it.
 */
export function chainedStep() {
  let pending: PendingStep | null = null;
  return {
    arm(step: PendingStep) {
      pending = step;
    },
    disarm() {
      pending = null;
    },
    /** Runs the armed step for the saved record; false when none was armed (the form goes on as usual). */
    resume(id: string, updatedAt: string | null, status: string | null = null): boolean {
      const step = pending;
      pending = null;
      if (!step) return false;
      void step(id, updatedAt, status);
      return true;
    },
  };
}

/** For tests. */
export function clearBarFlow(): void {
  notices.clear();
}
