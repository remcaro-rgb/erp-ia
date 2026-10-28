"use client";

import { useState } from "react";
import type { RequestStepUp, SaveIssue, SaveRecord, SaveResult } from "./save-model";

export interface SaveFlow {
  saving: boolean;
  /** The last refusal: its code and the process's messages. */
  failure: { code: string; details: SaveIssue[] } | null;
  /** A save waits for the user's TOTP code (the process answered `step_up_required`). */
  stepUp: boolean;
  stepUpError: string | null;
  submit: (input: Record<string, unknown>) => Promise<SaveResult | null>;
  confirmStepUp: (code: string) => Promise<SaveResult | null>;
  cancelStepUp: () => void;
}

/**
 * Saving a record form: runs `save`; when the process asks for a step-up, keeps the input, asks for the code, turns
 * it into a token with `requestStepUp` and runs the same save again with it (rule 15).
 */
export function useSaveFlow(save: SaveRecord, requestStepUp: RequestStepUp | undefined, onSaved: (id: string) => void): SaveFlow {
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<SaveFlow["failure"]>(null);
  const [pending, setPending] = useState<Record<string, unknown> | null>(null);
  const [stepUpError, setStepUpError] = useState<string | null>(null);

  const run = async (input: Record<string, unknown>, token?: string): Promise<SaveResult | null> => {
    setSaving(true);
    try {
      const result = await save(input, token);
      if (result.ok) {
        setFailure(null);
        setPending(null);
        onSaved(result.id);
      } else if (result.code === "step_up_required" && requestStepUp) {
        setPending(input);
      } else {
        setFailure({ code: result.code, details: result.details });
        setPending(null);
      }
      return result;
    } finally {
      setSaving(false);
    }
  };

  return {
    saving,
    failure,
    stepUp: pending !== null,
    stepUpError,
    submit: (input) => run(input),
    async confirmStepUp(code) {
      if (!pending || !requestStepUp) return null;
      setStepUpError(null);
      const answer = await requestStepUp(code);
      if ("error" in answer) {
        setStepUpError(answer.error);
        return null;
      }
      return run(pending, answer.token);
    },
    cancelStepUp() {
      setPending(null);
      setStepUpError(null);
    },
  };
}
