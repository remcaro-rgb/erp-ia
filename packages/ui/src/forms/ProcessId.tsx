"use client";

import { useTranslations } from "next-intl";

/**
 * The registry id of the process a form runs (rule 21: business words first): closed behind "Detalles", for the admin or
 * the support agent who needs the technical name; the form's footer reads as a sentence without it.
 */
export function ProcessId({ id }: { id: string }) {
  const t = useTranslations("common.forms");
  return (
    <details className="erp-process">
      <summary>{t("details")}</summary>
      <span className="erp-mono">{t("process", { process: id })}</span>
    </details>
  );
}
