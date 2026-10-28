"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { DataGrid, defaultView, viewFromSaved, type SavedGridState } from "@erp/ui";
import { deleteViewAction, saveViewAction } from "@/lib/grid/actions";
import type { GridPageData } from "@/lib/grid/load";

/**
 * The audit grid (prototype v5 renderAudit): the universal DataGrid over `kernel.audit`, newest first, with the filter
 * row, the advanced filter, the export buttons and saved views. Entries are not records: a row opens nothing.
 */
export function AuditScreen({ data }: { data: GridPageData }) {
  const t = useTranslations();
  const [views, setViews] = useState(data.views);
  // The grid starts from the user's default view, when they saved one.
  const [initialState] = useState(() => {
    const view = defaultView(data.views);
    return view ? viewFromSaved(data.columns, view.state) : undefined;
  });

  const changeViews = async (result: Awaited<ReturnType<typeof saveViewAction>>) => {
    if (!result.ok) throw new Error(result.code);
    setViews(result.views);
  };

  return (
    <div className="erp-stack">
      <p className="erp-small erp-muted">{t("common.admin.audit.hint")}</p>
      <DataGrid
        entity={data.entity}
        title={data.title}
        columns={data.columns}
        initialState={initialState}
        savedViews={{
          views,
          onSave: async (name: string, isDefault: boolean, state: SavedGridState) => changeViews(await saveViewAction(data.entity, name, isDefault, state)),
          onDelete: async (id: string) => changeViews(await deleteViewAction(data.entity, id)),
        }}
      />
    </div>
  );
}
