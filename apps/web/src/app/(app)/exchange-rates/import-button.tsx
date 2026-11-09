"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { importOfficialRateAction } from "@/lib/core/exchange-rate-actions";

/** «Traer TRM»: runs the official-rate import now and says what it wrote, skipped or could not read. */
export function ImportOfficialRateButton() {
  const t = useTranslations("core.exchange_rates");
  const te = useTranslations("errors");
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const run = async () => {
    setBusy(true);
    try {
      const out = await importOfficialRateAction();
      if (out.ok && out.failed.length === 0) {
        setMessage({ ok: true, text: t("imported", { written: out.written, skipped: out.skipped }) });
        router.refresh();
      } else if (out.ok) setMessage({ ok: false, text: t("import_failed", { currencies: out.failed.join(", ") }) });
      else setMessage({ ok: false, text: out.details.length > 0 ? out.details.map((d) => d.message).join(" · ") : te.has(out.code) ? te(out.code) : te("unknown") });
    } finally {
      setBusy(false);
    }
  };
  return (
    <span>
      <button type="button" className="erp-btn" onClick={run} disabled={busy} data-testid="import-trm">
        {t("import")}
      </button>
      {message && (
        <span className={message.ok ? "erp-dian erp-dian--ok" : "erp-dian erp-dian--bad"} role={message.ok ? "status" : "alert"}>
          {message.text}
        </span>
      )}
    </span>
  );
}
