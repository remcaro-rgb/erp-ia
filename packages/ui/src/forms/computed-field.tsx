"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { Check, Copy } from "lucide-react";
import { useTranslations } from "next-intl";
import { Field } from "./form-parts";

/** Seconds the "Copiado" confirmation stays. */
const COPIED_MS = 2000;

/**
 * A button that copies `text` to the clipboard and says "Copiado" in a live region (polite status, always mounted so
 * the change is announced). Nothing to copy: disabled. A clipboard that refuses says so in the same region.
 */
export function CopyButton({ text, label, className }: { text: string; label: string; className?: string }) {
  const t = useTranslations("common.forms");
  const [state, setState] = useState<"copied" | "failed" | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  const copy = async () => {
    let next: "copied" | "failed" = "copied";
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      next = "failed";
    }
    setState(next);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setState(null), COPIED_MS);
  };
  return (
    <>
      <button type="button" className={["erp-copy", className].filter(Boolean).join(" ")} disabled={text === ""} aria-label={t("copy_field", { field: label })} title={t("copy_field", { field: label })} onClick={() => void copy()}>
        {state === "copied" ? <Check aria-hidden="true" className="erp-icon" /> : <Copy aria-hidden="true" className="erp-icon" />}
      </button>
      <span aria-live="polite" className="sr-only">
        {state === "copied" ? t("copied") : state === "failed" ? t("copy_failed") : ""}
      </span>
    </>
  );
}

/**
 * A value the form computes (the check digit, the name on the document, the margin): a read-only box (never `disabled`,
 * so it can be read, selected and reached by assistive technology) styled as computed, with a copy button (M12).
 */
export function ComputedField({ label, value, copyLabel, copyText = value, hint, className, inputClassName, mono, title }: { label: ReactNode; value: string; copyLabel: string; /** What the button copies when it is not the displayed value ("—" shows, nothing copies). */ copyText?: string; inputClassName?: string; hint?: ReactNode; className?: string; mono?: boolean; title?: string }) {
  return (
    <Field label={label} hint={hint} className={className}>
      {(id, describedBy) => (
        <div className="erp-computed">
          <input id={id} readOnly value={value} title={title} aria-describedby={describedBy} className={["erp-input--computed", mono && "erp-mono", inputClassName].filter(Boolean).join(" ")} />
          <CopyButton text={copyText} label={copyLabel} />
        </div>
      )}
    </Field>
  );
}
