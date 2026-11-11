import { getTranslations } from "next-intl/server";
import type { Caller } from "@erp/kernel";
import { isEditableStatus, RecordLink, WithoutRecordBridge } from "@erp/ui";
import type { LoadedContribution } from "@/lib/records/contributed-load";
import { gridRows, loadRecord } from "@/lib/records/load";
import { ContributedTab } from "./contributed-tab";
import { RecordForm } from "./record-form";

// A document's Contabilidad tab (accounting's contribution `accounting.entries`, owner 2026-11-11): each comprobante the document made is
// shown as the comprobante's own Datos tab, read-only: its header (fuente, fecha, descripción…) and its lines grid. A document with more
// comprobantes than MAX_SHOWN, or a caller who may not read them, keeps the grid of comprobantes.

/** The comprobantes shown whole; beyond it the tab lists them. */
const MAX_SHOWN = 4;

export async function EntriesTab({ caller, entityId, recordId, tab }: { caller: Caller; entityId: string; recordId: string; tab: LoadedContribution }) {
  const grid = <ContributedTab entityId={entityId} recordId={recordId} tab={tab} />;
  if (tab.kind !== "grid" || tab.gridHidden || !tab.source || tab.action) return grid;
  const page = await gridRows(caller, tab.source, {
    filters: tab.filters ?? [],
    sort: [{ field: "date", dir: "asc" }, { field: "number", dir: "asc" }],
    page: 1,
    pageSize: MAX_SHOWN + 1,
  });
  if (page.total === 0 || page.total > MAX_SHOWN) return grid;
  const entries = (await Promise.all(page.rows.map((row) => loadRecord("accounting.entry", String(row.id))))).filter((e): e is NonNullable<typeof e> => e !== null && e.record !== null);
  if (entries.length !== page.rows.length) return grid;
  const t = await getTranslations();
  return (
    <div className="erp-stack">
      {entries.map((loaded) => {
        const record = loaded.record!;
        // A stored comprobante reads as on its own page: read-only by its state (contabilizado, anulado…); a draft is edited on its own page.
        const readOnly = !loaded.canSave || isEditableStatus(String(record.status ?? ""));
        return (
          <section key={record.id} className="erp-stack" data-entry={String(record.number ?? record.id)}>
            <div className="erp-row" style={{ justifyContent: "flex-end" }}>
              <span className="erp-small">
                <RecordLink entity="accounting.entry" id={record.id} label={t("common.record.contributed.open_entry", { number: String(record.number ?? record.id) })} />
              </span>
            </div>
            <WithoutRecordBridge>
              <RecordForm entity="accounting.entry" record={record} modes={loaded.modes} readOnly={readOnly} form={loaded.form} />
            </WithoutRecordBridge>
          </section>
        );
      })}
    </div>
  );
}
