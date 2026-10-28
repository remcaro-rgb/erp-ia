"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { useSearchParams } from "next/navigation";
import { DataGrid, defaultView, ImportIcon, partyKindFilters, PartyScopeSwitches, useTabs, viewFromSaved, type GridRow, type PartySwitches, type SavedGridState } from "@erp/ui";
import { deleteViewAction, saveViewAction } from "@/lib/grid/actions";
import type { GridPageData } from "@/lib/grid/load";
import { NEW_RECORD_ID } from "@/lib/records/entities";

/**
 * A grid page (design §9, §19a): no page title (the grid header names the entity), "Nuevo" and "Importar" next to
 * the grid's own buttons, the party switches on Terceros, saved views, and a record opening in its own tab.
 */
export function GridPage({ data }: { data: GridPageData }) {
  const t = useTranslations();
  const open = useTabs((s) => s.open);
  const searchParams = useSearchParams();
  const [views, setViews] = useState(data.views);
  const [switches, setSwitches] = useState<PartySwitches>({ customers: true, suppliers: true });
  const baseFilters = useMemo(() => (data.partyScope ? partyKindFilters(data.partyScope, switches) : []), [data.partyScope, switches]);
  // The user's default view, as the grid starts.
  const [initialState] = useState(() => {
    const view = defaultView(data.views);
    return view ? viewFromSaved(data.columns, view.state) : undefined;
  });

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
    <DataGrid
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
          <button type="button" className="erp-btn" disabled title={t("grid.import.soon")}>
            <ImportIcon />
            {t("grid.import.title")}
          </button>
        </>
      }
      savedViews={{
        views,
        onSave: async (name: string, isDefault: boolean, state: SavedGridState) => changeViews(await saveViewAction(data.entity, name, isDefault, state)),
        onDelete: async (id: string) => changeViews(await deleteViewAction(data.entity, id)),
      }}
    />
  );
}
