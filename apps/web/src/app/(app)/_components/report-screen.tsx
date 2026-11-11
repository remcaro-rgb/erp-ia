"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { usePathname, useSearchParams } from "next/navigation";
import { formatLabel, GridFetchError, paramsFromSearch, paramsToSearch, ReportPage, StepUpPrompt, useTabs, type GridRow, type ReportLink, type ReportParams, type SavedGridState } from "@erp/ui";
import { agingDrillHref, drillHref, drillRange, linkTitle, rangeLabel } from "@/lib/accounting/drill";
import { reportTabToRename } from "@/lib/reports/tab-title";
import { requestStepUp } from "@/lib/auth/step-up-client";
import { deleteViewAction, saveViewAction } from "@/lib/grid/actions";
import type { ReportPageData } from "@/lib/reports/load";

interface Waiting {
  confirm: (code: string) => Promise<void>;
  cancel: () => void;
}

const detailsOf = (body: unknown): string[] =>
  typeof body === "object" && body !== null && "details" in body && Array.isArray(body.details) ? body.details.filter((d): d is string => typeof d === "string") : [];

/**
 * A report page: the parameters start from the schema's defaults, the URL's `?p=` over them, and stay in the URL as
 * they change; a column with a link opens the record in its own tab (rule 21); the saved parameter sets are the
 * caller's views of `report:<id>`.
 */
export function ReportScreen({ data }: { data: ReportPageData }) {
  const t = useTranslations();
  const locale = useLocale();
  const open = useTabs((s) => s.open);
  const searchParams = useSearchParams();
  const pathname = usePathname();
  // The tab of a report is named by the report ("Balance de prueba"), not by the menu item that covers every report
  // ("Informes"), however the page was reached (card, ⌘K, a typed address, a reload). A drill-down tab keeps its own title.
  const tabs = useTabs((s) => s.tabs);
  const rename = useTabs((s) => s.rename);
  const generic = t("nav.accounting.reports");
  useEffect(() => {
    const tab = reportTabToRename(tabs, pathname, data.report.label, generic);
    if (tab) rename(tab.href, data.report.label);
  }, [tabs, pathname, data.report.label, generic, rename]);
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
    const fallback = String(row[data.report.columns[0]?.field ?? "id"] ?? t("nav.shell.record"));
    if (link && drill) {
      const range = drillRange(drill);
      const title = linkTitle(row, link, data.report, fallback, range ? rangeLabel(range, (month) => formatLabel(month, locale)) : undefined);
      open({ title, href: drill, kind: "report" });
      // The tab of this very drill-down may exist from before (saved with an older title): it takes the current name.
      rename(drill, title);
    } else if (link) open({ title: linkTitle(row, link, data.report, fallback), href: `/r/${link.entity}/${link.id}`, kind: "record" });
  };
  // A figure of the Cartera por edades opens the documents that make it (Detalle de cartera, owner 2026-11-11), in a tab of its own.
  const drillCell = (row: GridRow, field: string) => {
    const href = agingDrillHref(data.report.id, row, field, current.current);
    if (!href) return;
    const bucket = field === "total" ? t("report.aging_detail.all") : t(`report.aging.${field}` as never);
    const who = typeof row.party_name === "string" && row.party_name ? row.party_name : t("report.aging_detail.tab");
    const title = `${who} · ${bucket}`;
    open({ title, href, kind: "report" });
    rename(href, title);
  };
  const changeViews = async (result: Awaited<ReturnType<typeof saveViewAction>>) => {
    if (!result.ok) throw new Error(result.code);
    setViews(result.views);
  };

  // A file action (the exógena's XML): POST /api/report/<id>/file/<action>; a sensitive one asks for the code once and runs again with its token.
  const [waiting, setWaiting] = useState<Waiting | null>(null);
  const [stepUpError, setStepUpError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const requestFile = async (actionId: string, params: ReportParams, stepUpToken?: string) => {
    const response = await fetch(`/api/report/${encodeURIComponent(data.report.id)}/file/${encodeURIComponent(actionId)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        params,
        ...(stepUpToken ? { stepUpToken } : {}),
      }),
    });
    const body = (await response.json().catch(() => null)) as {
      url?: string;
      fileName?: string;
      code?: string;
    } | null;
    if (!response.ok || !body?.url) throw new GridFetchError(body?.code ?? "handler_failed", response.status, detailsOf(body));
    const link = document.createElement("a");
    link.href = body.url;
    link.download = body.fileName ?? "";
    document.body.appendChild(link);
    link.click();
    link.remove();
  };
  const fileAction = async (actionId: string, params: ReportParams) => {
    try {
      await requestFile(actionId, params);
    } catch (error) {
      if (!(error instanceof GridFetchError) || error.code !== "step_up_required") throw error;
      await new Promise<void>((resolve, reject) => {
        setStepUpError(null);
        setWaiting({
          async confirm(code) {
            setBusy(true);
            try {
              const answer = await requestStepUp(code);
              if ("error" in answer) {
                setStepUpError(answer.error);
                return;
              }
              await requestFile(actionId, params, answer.token);
              setWaiting(null);
              resolve();
            } catch (failure) {
              setWaiting(null);
              reject(failure);
            } finally {
              setBusy(false);
            }
          },
          cancel() {
            // Cancelling the code is no refusal: nothing was generated and nothing to list.
            setWaiting(null);
            resolve();
          },
        });
      });
    }
  };

  return (
    <>
      <ReportPage
        report={data.report}
        onFileAction={data.report.fileActions.length > 0 ? fileAction : undefined}
        initialParams={initial}
        onParamsChange={keepInUrl}
        onRowOpen={openLink}
        onCellDrill={drillCell}
        savedViews={{
          views,
          onSave: async (name: string, isDefault: boolean, state: SavedGridState) => changeViews(await saveViewAction(entity, name, isDefault, state)),
          onDelete: async (id: string) => changeViews(await deleteViewAction(entity, id)),
        }}
      />
      {waiting && <StepUpPrompt onConfirm={(code) => void waiting.confirm(code)} onCancel={waiting.cancel} error={stepUpError} busy={busy} />}
    </>
  );
}
