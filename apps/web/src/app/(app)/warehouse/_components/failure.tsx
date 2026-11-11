"use client";

import { useTranslations } from "next-intl";
import type { StepFailure } from "@/lib/records/use-step-runner";

// The refusal line the Bodega screens share (plan 2B.2 Task 29.4): the process's messages, else its code's text.

// -------------------------------------------------------------------------------------------------
// Shared
// -------------------------------------------------------------------------------------------------

export function useFailureText() {
  const te = useTranslations("errors");
  return (f: StepFailure | null) => (f ? (f.messages.length > 0 ? f.messages.join(" · ") : te.has(f.code) ? te(f.code) : te("unknown")) : null);
}

export function Failure({ text }: { text: string | null }) {
  return text ? (
    <div className="erp-dian erp-dian--bad" role="alert">
      <b>{text}</b>
    </div>
  ) : null;
}
