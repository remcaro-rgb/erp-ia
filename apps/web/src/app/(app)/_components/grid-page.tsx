"use client";

import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslations } from "next-intl";
import { useSearchParams } from "next/navigation";
import { DataGrid, decodeGridQuery, defaultView, ImportDialog, ImportIcon, partyKindFilters, PartyScopeSwitches, useTabs, viewFromSaved, type GridRow, type PartySwitches, type SavedGridState } from "@erp/ui";
import { requestStepUp } from "@/lib/auth/step-up-client";
import { deleteViewAction, saveViewAction } from "@/lib/grid/actions";
import type { GridPageData } from "@/lib/grid/load";
import { NEW_RECORD_ID } from "@/lib/records/entities";

/** A toggle that narrows the grid (Hoy, Borradores…); one per group is on at a time, and the groups combine with AND. */
export interface QuickFilter {
  id: string;
  group: string;
  label: string;
  filters: { field: string; op: "eq" | "between"; value: string; value2?: string }[];
}

/**
 * A grid page (design §9, §19a): no page title (the grid header names the entity), "Nuevo" and "Importar" (the import
 * dialog, for callers who may import) next to the grid's own buttons, the party switches on Terceros, saved views,
 * and a record opening in its own tab.
 */
export function GridPage({ data, quickFilters = [], toolbarExtra = null }: { data: GridPageData; quickFilters?: readonly QuickFilter[]; toolbarExtra?: ReactNode }) {
  const t = useTranslations();
  const open = useTabs((s) => s.open);
  const searchParams = useSearchParams();
  const [views, setViews] = useState(data.views);
  const [switches, setSwitches] = useState<PartySwitches>({ customers: true, suppliers: true });
  const [importing, setImporting] = useState(false);
  const [quick, setQuick] = useState<Record<string, string>>({});
  const baseFilters = useMemo(
    () => [
      ...(data.partyScope ? partyKindFilters(data.partyScope, switches) : []),
      ...quickFilters.filter((q) => quick[q.group] === q.id).flatMap((q) => q.filters),
    ],
    [data.partyScope, switches, quick, quickFilters],
  );
  // The assistant's "Abrir como grid" lands here with ?q=<the query>: the grid starts from it (what the caller may not
  // filter or sort on is dropped by viewFromSaved); otherwise from the user's default view.
  const query = searchParams.get("q");
  const initialState = useMemo(() => {
    const asked = decodeGridQuery(query);
    if (asked) return viewFromSaved(data.columns, asked);
    const view = defaultView(data.views);
    // The entity's own default state (Movimientos: the open period, posted lines) comes after the user's choices.
    return view ? viewFromSaved(data.columns, view.state) : data.initialState ? viewFromSaved(data.columns, data.initialState) : undefined;
    // The saved views change while the grid is open (the user saves one); the grid only starts from them.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, data.columns]);

  const openNew = () => open({ title: data.newTitle, href: `/r/${data.entity}/${NEW_RECORD_ID}`, kind: "record" });
  const openRow = (row: GridRow) => open({ title: String(row[data.titleField] ?? t("nav.shell.record")), href: `/r/${data.entity}/${row.id}`, kind: "record" });

  // ⌘K "Crear …" lands here with ?new=1: open the new record's tab once.
  const handledNew = useRef(false);
  useEffect(() => {
    if (searchParams.get("new") !== "1" || handledNew.current || !data.canCreate) return;
    handledNew.current = true;
    openNew();
    // Once per visit with ?new=1; openNew only reads props that do not change while the page is open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  const changeViews = async (result: Awaited<ReturnType<typeof saveViewAction>>) => {
    if (!result.ok) throw new Error(result.code);
    setViews(result.views);
  };

  return (
    <>
      <DataGrid
        key={query ?? ""}
        entity={data.entity}
        title={data.title}
        columns={data.columns}
        initialState={initialState}
        baseFilters={baseFilters}
        onRowOpen={openRow}
        headerExtra={data.partyScope ? <PartyScopeSwitches scope={data.partyScope} value={switches} onChange={setSwitches} /> : null}
        toolbar={
          <>
            {data.canCreate && (
              <button type="button" className="erp-btn erp-btn--primary" onClick={openNew}>
                {t("grid.new")}
              </button>
            )}
            {toolbarExtra && <Fragment key="toolbar-extra">{toolbarExtra}</Fragment>}
            {quickFilters.length > 0 && (
              <span className="erp-row" role="group" aria-label={t("accounting.entry.grid.filters")}>
                {quickFilters.map((q) => (
                  <button
                    key={q.id}
                    type="button"
                    className="erp-btn"
                    aria-pressed={quick[q.group] === q.id}
                    onClick={() => setQuick((current) => {
                      const { [q.group]: on, ...rest } = current;
                      return on === q.id ? rest : { ...rest, [q.group]: q.id };
                    })}
                  >
                    {q.label}
                  </button>
                ))}
              </span>
            )}
            {data.canImport && (
              <button type="button" className="erp-btn" onClick={() => setImporting(true)}>
                <ImportIcon />
                {t("grid.import.title")}
              </button>
            )}
          </>
        }
        savedViews={{
          views,
          onSave: async (name: string, isDefault: boolean, state: SavedGridState) => changeViews(await saveViewAction(data.entity, name, isDefault, state)),
          onDelete: async (id: string) => changeViews(await deleteViewAction(data.entity, id)),
        }}
      />
      {data.canImport && <ImportDialog open={importing} onOpenChange={setImporting} entity={data.entity} entityLabel={data.title} requestStepUp={requestStepUp} />}
    </>
  );
}
