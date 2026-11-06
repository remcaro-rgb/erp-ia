"use client";

import { useState } from "react";
import { requestStepUp } from "@/lib/auth/step-up-client";

// The step runner the record screens share (sales, stock and invoicing views and the invoicing bar, plan 2B Task 20 fix round 1): it runs a
// step through the screen's server action; a sensitive one (step_up_required) asks for the TOTP code and runs again with the token, the
// same input and, when the screen keys its clicks, the same click's idempotency key (a retry of the same click runs once).

export type StepFailure = { ok: false; code: string; messages: string[] };

export interface StepRunnerOptions {
  /** Each click carries its own idempotency key (`idempotencyKey`, a UUID) unless the input already names one. */
  clickKey?: boolean;
}

export function useStepRunner<Step extends string, Done extends { ok: true }>(
  action: (step: Step, input: Record<string, unknown>, token?: string) => Promise<Done | StepFailure>,
  onDone: (outcome: Done) => void,
  options: StepRunnerOptions = {},
) {
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<{ step: Step; input: Record<string, unknown> } | null>(null);
  const [stepUpError, setStepUpError] = useState<string | null>(null);
  const [failure, setFailure] = useState<StepFailure | null>(null);
  const run = async (step: Step, input: Record<string, unknown>, token?: string) => {
    setBusy(true);
    try {
      const outcome = await action(step, input, token);
      if (outcome.ok) {
        setPending(null);
        setFailure(null);
        onDone(outcome);
      } else if (outcome.code === "step_up_required") setPending({ step, input });
      else {
        setPending(null);
        setFailure(outcome);
      }
    } finally {
      setBusy(false);
    }
  };
  return {
    busy,
    failure,
    stepUp: pending !== null,
    stepUpError,
    run: (step: Step, input: Record<string, unknown> = {}) => void run(step, options.clickKey ? { idempotencyKey: crypto.randomUUID(), ...input } : input),
    async confirm(code: string) {
      if (!pending) return;
      setStepUpError(null);
      setBusy(true);
      const answer = await requestStepUp(code);
      if ("error" in answer) {
        setStepUpError(answer.error);
        setBusy(false);
        return;
      }
      await run(pending.step, pending.input, answer.token);
    },
    cancel() {
      setPending(null);
      setStepUpError(null);
    },
    /** Forgets the last refusal (a dialog closed). */
    clear() {
      setFailure(null);
    },
  };
}

export type StepRunner = ReturnType<typeof useStepRunner>;
