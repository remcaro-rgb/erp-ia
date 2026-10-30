"use client";

import { useCallback, useState, type ReactNode } from "react";
import { StepUpPrompt } from "@erp/ui";
import { requestStepUp } from "@/lib/auth/step-up-client";
import type { ActionResult } from "@/lib/records/tab-actions";

interface Waiting {
  confirm: (code: string) => Promise<void>;
  cancel: () => void;
}

/**
 * The step-up path the tab actions share with the record forms (rule 15): `run` calls the action; when the process is
 * sensitive and answers `step_up_required`, `prompt` asks for the 6-digit code, turns it into a token with the step-up
 * endpoint and runs the same action again with it. The promise settles with the final result (the first refusal when the
 * user cancels). Render `prompt` next to the tab.
 */
export function useStepUpAction(): {
  run: <T>(action: (stepUpToken?: string) => Promise<ActionResult<T>>) => Promise<ActionResult<T>>;
  prompt: ReactNode;
  /** Cancels a run waiting for the code, as the prompt's Cancelar does (for a container that closes around the prompt). */
  cancel: () => void;
} {
  const [waiting, setWaiting] = useState<Waiting | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const run = useCallback(async function run<T>(action: (stepUpToken?: string) => Promise<ActionResult<T>>): Promise<ActionResult<T>> {
    const first = await action();
    if (first.ok || first.code !== "step_up_required") return first;
    return new Promise<ActionResult<T>>((resolve) => {
      setError(null);
      setWaiting({
        async confirm(code) {
          setBusy(true);
          try {
            const answer = await requestStepUp(code);
            if ("error" in answer) {
              setError(answer.error);
              return;
            }
            const result = await action(answer.token);
            setWaiting(null);
            setError(null);
            resolve(result);
          } finally {
            setBusy(false);
          }
        },
        cancel() {
          setWaiting(null);
          setError(null);
          resolve(first);
        },
      });
    });
  }, []);

  const prompt = waiting ? <StepUpPrompt onConfirm={(code) => void waiting.confirm(code)} onCancel={waiting.cancel} error={error} busy={busy} /> : null;
  const cancel = useCallback(() => waiting?.cancel(), [waiting]);
  return { run, prompt, cancel };
}
