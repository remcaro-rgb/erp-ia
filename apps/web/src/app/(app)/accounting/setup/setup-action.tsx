"use client";

import { ProcessId } from "@erp/ui";
import { useTranslations } from "next-intl";
import { seedChartAction } from "@/lib/accounting/posting-actions";
import { useAdminAction } from "../../admin/_components/use-admin-action";

/** The single action of the first visit: `accounting.chart.seed` behind the TOTP dialog; then a full load, so the layout reads the new settings. */
export function SetupAction() {
  const t = useTranslations("accounting.pages.setup");
  const { execute, prompt, status, busy } = useAdminAction();
  return (
    <div className="erp-stack">
      <div>
        <button
          type="button"
          className="erp-btn erp-btn--primary"
          disabled={busy}
          onClick={() =>
            void execute((token) => seedChartAction(token)).then((r) => {
              // The layout above holds the answer "not configured": load the module again from its first page.
              // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- a full load: the layout above must read the new settings
              if (r.ok) window.location.href = "/accounting/entries";
            })
          }
        >
          {busy ? t("running") : t("action")}
        </button>
      </div>
      <div className="erp-small erp-muted"><ProcessId id={"accounting.chart.seed"} /></div>
      {status}
      {prompt}
    </div>
  );
}
