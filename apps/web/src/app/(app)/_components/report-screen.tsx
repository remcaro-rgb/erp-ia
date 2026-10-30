"use client";

import { useMemo, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { usePathname, useSearchParams } from "next/navigation";
import { paramsFromSearch, paramsToSearch, ReportPage, useTabs, type GridRow, type ReportLink, type ReportParams, type SavedGridState } from "@erp/ui";
import { drillHref } from "@/lib/accounting/drill";
import { deleteViewAction, saveViewAction } from "@/lib/grid/actions";
import type { ReportPageData } from "@/lib/reports/load";

/**
 * A report page: the parameters start from the schema's defaults, the URL's `?p=` over them, and stay in the URL as
 * they change; a column with a link opens the record in its own tab (rule 21); the saved parameter sets are the
 * caller's views of `report:<id>`.
 */
export function ReportScreen({ data }: { data: ReportPageData }) {
  const t = useTranslations();
  const open = useTabs((s) => s.open);
  const searchParams = useSearchParams();
  const pathname = usePathname();
  const [views, setViews] = useState(data.views);
  const entity = `report:${data.report.id}`;
  const initial = useMemo(() => ({ ...data.defaults, ...paramsFromSearch(searchParams.toString()) }), [data.defaults, searchParams]);

  // The parameters the report is running with: a row's drill-down reads the range from them.
  const current = useRef<ReportParams>(initial);
  const keepInUrl = (params: ReportParams) => {
    current.current = params;
    const search = paramsToSearch(params);
    window.history.replaceState(null, "", search ? `${pathname}?${search}` : pathname);
  };
  const openLink = (row: GridRow, link?: ReportLink) => {
    // The account of a statement row opens the Auxiliar por cuenta of the range, in its own tab (accounting design §8).
    const drill = link ? drillHref(data.report.id, link, current.current, data.periodDates) : null;
    if (link && drill) open({ title: String(row[data.report.columns[0]?.field ?? "id"] ?? t("nav.shell.record")), href: drill, kind: "report" });
    else if (link) open({ title: String(row[data.report.columns[0]?.field ?? "id"] ?? t("nav.shell.record")), href: `/r/${link.entity}/${link.id}`, kind: "record" });
  };
  const changeViews = async (result: Awaited<ReturnType<typeof saveViewAction>>) => {
    if (!result.ok) throw new Error(result.code);
    setViews(result.views);
  };

  return (
    <ReportPage
      report={data.report}
      initialParams={initial}
      onParamsChange={keepInUrl}
      onRowOpen={openLink}
      savedViews={{
        views,
        onSave: async (name: string, isDefault: boolean, state: SavedGridState) => changeViews(await saveViewAction(entity, name, isDefault, state)),
        onDelete: async (id: string) => changeViews(await deleteViewAction(entity, id)),
      }}
    />
  );
}
