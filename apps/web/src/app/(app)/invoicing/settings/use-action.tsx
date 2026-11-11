"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { StepUpPrompt } from "@erp/ui";
import { requestStepUp } from "@/lib/auth/step-up-client";
import { runInvoicingSettingsAction, type InvoicingSettingsAction } from "@/lib/invoicing/actions";

type Message = { ok: boolean; text: string } | null;

/** One process behind one button: the step-up round trip, the busy flag and the card's message. */
export function useAction(action: InvoicingSettingsAction, okText: (data: Record<string, unknown>) => string) {
  const te = useTranslations("errors");
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [stepUp, setStepUp] = useState<{ input: Record<string, unknown>; then?: (data: Record<string, unknown>) => void } | null>(null);
  const [stepUpError, setStepUpError] = useState<string | null>(null);
  const [message, setMessage] = useState<Message>(null);
  const run = async (input: Record<string, unknown>, then?: (data: Record<string, unknown>) => void, token?: string) => {
    setBusy(true);
    setMessage(null);
    try {
      const outcome = await runInvoicingSettingsAction(action, input, token);
      if (outcome.ok) {
        setStepUp(null);
        setMessage({ ok: true, text: okText(outcome.data) });
        then?.(outcome.data);
        router.refresh();
      } else if (outcome.code === "step_up_required") {
        setStepUp({ input, ...(then ? { then } : {}) });
      } else {
        setStepUp(null);
        setMessage({ ok: false, text: outcome.messages.length > 0 ? outcome.messages.join(" · ") : te.has(outcome.code) ? te(outcome.code) : te("unknown") });
      }
    } finally {
      setBusy(false);
    }
  };
  const confirm = async (code: string) => {
    if (!stepUp) return;
    setStepUpError(null);
    const answer = await requestStepUp(code);
    if ("error" in answer) setStepUpError(answer.error);
    else await run(stepUp.input, stepUp.then, answer.token);
  };
  const feedback = (
    <>
      {stepUp && <StepUpPrompt onConfirm={(code) => void confirm(code)} onCancel={() => setStepUp(null)} error={stepUpError} busy={busy} />}
      {message && (
        <div className={message.ok ? "erp-dian erp-dian--ok" : "erp-dian erp-dian--bad"} role={message.ok ? "status" : "alert"}>
          {message.text}
        </div>
      )}
    </>
  );
  return { run, busy: busy || stepUp !== null, feedback };
}
