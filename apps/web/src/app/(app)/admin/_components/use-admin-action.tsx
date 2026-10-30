"use client";

import { useCallback, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import type { SaveIssue } from "@erp/ui";
import { adminAction } from "@/lib/admin/actions";
import type { ActionResult } from "@/lib/records/tab-actions";
import { useStepUpAction } from "../../_components/use-step-up";

export interface PerformOptions {
  /** Called with the process's reasons when it refuses (a batch names the refused changes by index). */
  onRefused?: (details: SaveIssue[]) => void;
}

export interface AdminActions {
  /** Runs the admin process (asking for the step-up code when it answers `step_up_required`); true when it succeeded. */
  perform: (processId: string, input: unknown, options?: PerformOptions) => Promise<boolean>;
  /** The same for a dedicated server action (`(stepUpToken?) => result`, e.g. setUserMfaAction): its final result. */
  execute: <T>(action: (stepUpToken?: string) => Promise<ActionResult<T>>, options?: PerformOptions) => Promise<ActionResult<T>>;
  /** The step-up prompt while a run waits for the code: render it where the user is looking (inside an open dialog). */
  prompt: ReactNode;
  /** The outcome of the last run (saved / refused with the reasons). */
  status: ReactNode;
  busy: boolean;
  /** Clears the outcome of the last run (the screen changed since). */
  reset: () => void;
}

/** The admin screens' way to change something (rules 1 and 15): process, step-up, then the server data again. */
export function useAdminAction(): AdminActions {
  const t = useTranslations();
  const router = useRouter();
  const { run, prompt } = useStepUpAction();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const execute = useCallback(
    async function execute<T>(action: (stepUpToken?: string) => Promise<ActionResult<T>>, options?: PerformOptions): Promise<ActionResult<T>> {
      setBusy(true);
      setMessage(null);
      try {
        const result = await run(action);
        if (result.ok) {
          setMessage({ ok: true, text: t("common.admin.saved") });
          router.refresh();
          return result;
        }
        const reason = result.details.length > 0 ? result.details.map((d) => d.message).join(" · ") : t.has(`errors.${result.code}`) ? t(`errors.${result.code}`) : t("errors.unknown");
        setMessage({ ok: false, text: t("common.admin.failed", { reason }) });
        options?.onRefused?.(result.details);
        return result;
      } finally {
        setBusy(false);
      }
    },
    [run, router, t],
  );
  const perform = useCallback(
    async (processId: string, input: unknown, options?: PerformOptions) => (await execute((stepUpToken) => adminAction(processId, input, stepUpToken), options)).ok,
    [execute],
  );

  const status = message ? (
    <div role={message.ok ? "status" : "alert"} className={`erp-dian erp-dian--${message.ok ? "ok" : "bad"}`}>
      {message.text}
    </div>
  ) : null;
  const reset = useCallback(() => setMessage(null), []);
  return { perform, execute, prompt, status, busy, reset };
}

/** The step-up prompt docked at the bottom of the screen, for changes made outside a dialog. */
export function StepUpDock({ prompt }: { prompt: ReactNode }) {
  return prompt ? <div className="erp-admin__dock">{prompt}</div> : null;
}

/** `record` without `key` (an optimistic change dropped after a refusal). */
export function without<T>(record: Record<string, T>, key: string): Record<string, T> {
  const next = { ...record };
  delete next[key];
  return next;
}
