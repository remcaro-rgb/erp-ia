"use client";

import { useTranslations } from "next-intl";
import { DataGrid, Pill } from "@erp/ui";
import type { InvoicingView } from "@/lib/invoicing/record";

// The Líneas e impuestos and DIAN tabs of an invoice or a note (plan 2B Task 20, prototype 2B). The lines and the taxes per tax and rate in
// the universal grid (rule 20: sort, filters, pages, exports); the DIAN submission as the caller's role sees it: its status, round,
// attempts, trackId, when it was sent and decided, the DIAN's errors of a rejection and the files the e-invoice workflow kept (the signed
// XML, the ApplicationResponse, the PDF), each downloaded through a short-lived signed link the server makes (rule 22).

export function InvoicingLinesTab({ view }: { view: InvoicingView }) {
  const t = useTranslations("invoicing.view");
  return (
    <div className="erp-form">
      {view.linesGrid ? (
        <DataGrid entity={view.linesGrid.entity} title={view.linesGrid.title} columns={view.linesGrid.columns} baseFilters={view.linesGrid.filters} initialState={{ sort: [{ field: "line_no", dir: "asc" }] }} />
      ) : (
        <p className="erp-small erp-muted">{t("no_access")}</p>
      )}
      {view.taxesGrid && <DataGrid entity={view.taxesGrid.entity} title={view.taxesGrid.title} columns={view.taxesGrid.columns} baseFilters={view.taxesGrid.filters} />}
    </div>
  );
}

export function InvoicingDianTab({ view }: { view: InvoicingView }) {
  const t = useTranslations("invoicing.view");
  const s = view.submission;
  if (!s) {
    return (
      <div className="erp-form">
        <p className="erp-small erp-muted">{t(view.stage === "draft" ? "dian_tab.draft" : "dian_tab.none")}</p>
      </div>
    );
  }
  const row = (label: string, value: string | number | null) =>
    value === null || value === "" ? null : (
      <div className="erp-field">
        <span className="erp-field__label">{label}</span>
        <span className="erp-mono">{value}</span>
      </div>
    );
  return (
    <div className="erp-form">
      <section className="erp-sec">
        <h3>
          {t("dian_tab.title")} <Pill tone={view.dian.tone}>{s.statusLabel}</Pill>
        </h3>
        <div className="erp-form2">
          {row(t("dian_tab.round"), s.round)}
          {row(t("dian_tab.attempts"), s.attempts)}
          {row(t("dian_tab.track_id"), s.trackId)}
          {row(t("dian_tab.submitted_at"), s.submittedAt)}
          {row(t("dian_tab.decided_at"), s.decidedAt)}
          {row(t("dian_tab.last_error"), s.lastError)}
        </div>
        {view.errors.length > 0 && (
          <div className="erp-dian erp-dian--bad">
            <b>{t("dian_tab.errors")}</b>
            <ul>
              {view.errors.map((e, i) => (
                <li key={i}>{e}</li>
              ))}
            </ul>
          </div>
        )}
      </section>
      <section className="erp-sec">
        <h3>{t("dian_tab.files")}</h3>
        {s.files.length === 0 ? (
          <p className="erp-small erp-muted">{t("dian_tab.no_files")}</p>
        ) : (
          <ul className="erp-row">
            {s.files.map((f) => (
              <li key={f.file}>
                <a className="erp-btn erp-btn--ghost" href={`/api/einvoice/${encodeURIComponent(s.id)}?file=${f.file}`} target="_blank" rel="noopener noreferrer">
                  {f.label}
                </a>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
