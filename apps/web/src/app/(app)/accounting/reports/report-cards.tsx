"use client";

import { useTranslations } from "next-intl";
import { useTabs } from "@erp/ui";

export interface ReportCardItem {
  name: string;
  label: string;
  description: string;
}

/** The cards of Informes: each opens its report in a tab of the shell named after the report (rule 19). */
export function ReportCards({ items }: { items: ReportCardItem[] }) {
  const t = useTranslations("nav.accounting");
  const open = useTabs((s) => s.open);
  return (
    <nav aria-label={t("reports")} className="erp-reportcards">
      {items.map((item) => {
        const href = `/accounting/reports/${item.name}`;
        return (
          <a
            key={item.name}
            href={href}
            className="erp-card erp-reportcard"
            onClick={(event) => {
              // A plain click opens the report in the shell's tab; Ctrl/⌘-click keeps the browser's own behaviour.
              if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
              event.preventDefault();
              open({ title: item.label, href, kind: "report" });
            }}
          >
            <b>{item.label}</b>
            <div className="erp-small erp-muted">{item.description}</div>
          </a>
        );
      })}
    </nav>
  );
}
