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

/** The lifecycle step left after the form's save (a documento's Grabar, «Guardar y enviar a aprobación»'s Enviar). */
export type PendingStep = (id: string, updatedAt: string | null) => Promise<void>;

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
    resume(id: string, updatedAt: string | null): boolean {
      const step = pending;
      pending = null;
      if (!step) return false;
      void step(id, updatedAt);
      return true;
    },
  };
}

/** For tests. */
export function clearBarFlow(): void {
  notices.clear();
}
