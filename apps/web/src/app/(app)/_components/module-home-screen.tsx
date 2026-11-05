"use client";

import { useCallback, useEffect, useMemo } from "react";
import { useTranslations } from "next-intl";
import { chartWidgetId, ChartCard, Dashboard, defaultModuleLayout, isModuleWidgetId, KpisWidget, UpdatedAt, type DashboardWidget, type WidgetLayout } from "@erp/ui";
import type { ModuleHomeData } from "@/lib/home/load";
import { createLayoutSaver } from "@/lib/home/layout-save";
import { saveShellPrefAction } from "@/lib/prefs/actions";
import type { ShellPrefKey } from "@/lib/prefs/validate";
import { useHomeCustomize } from "./use-customize";

/**
 * A module's Inicio page (design §19a): the module's indicators as one strip and each chart as a card, on the same draggable and
 * resizable grid as the company-wide Inicio, with its own layout per user. "Personalizar página de inicio" switches items on and off.
 * What the caller's role cannot see never reaches the page (the kernel runs each provider as the caller).
 */
export function ModuleHomeScreen({ data, userId, companyId }: { data: ModuleHomeData; userId: string; companyId: string }) {
  const t = useTranslations();
  const { hidden, actions } = useHomeCustomize(data.hidden, data.catalog);
  const off = new Set(hidden);
  const kpis = data.kpis.filter((kpi) => !off.has(kpi.id));
  const charts = data.charts.filter((chart) => !off.has(chart.id));
  const asOf = <UpdatedAt at={data.asOf} />;

  const widgets: DashboardWidget[] = [];
  if (kpis.length > 0) widgets.push({ id: "kpis", title: t("home.widgets.kpis"), meta: asOf, content: <KpisWidget kpis={kpis} /> });
  for (const chart of charts) widgets.push({ id: chartWidgetId(chart.id), title: t(chart.label), meta: asOf, content: <ChartCard chart={chart} /> });

  // The default holds every chart the caller could have, switched on or not: a chart switched back on finds its place.
  const defaultLayout = useMemo(() => defaultModuleLayout(data.catalog.filter((item) => item.kind === "chart").map((item) => item.id)), [data.catalog]);

  const key = `home_layout.${data.module}`;
  const saver = useMemo(
    () =>
      createLayoutSaver({
        key,
        action: (pref) => saveShellPrefAction({ ...pref, key: pref.key as ShellPrefKey }),
        beacon: (pref) => navigator.sendBeacon("/api/prefs", new Blob([JSON.stringify(pref)], { type: "application/json" })),
      }),
    [key],
  );
  useEffect(() => {
    window.addEventListener("pagehide", saver.pageHide);
    return () => {
      window.removeEventListener("pagehide", saver.pageHide);
      saver.pageHide();
    };
  }, [saver]);
  const save = useCallback((layout: WidgetLayout[], savedAt: number) => void saver.save(layout, savedAt), [saver]);

  return (
    <div className="flex flex-col gap-4" data-testid="module-home" data-module={data.module}>
      <Dashboard
        key={data.module}
        userId={userId}
        companyId={companyId}
        scope={data.module}
        widgets={widgets}
        defaultLayout={defaultLayout}
        knownId={isModuleWidgetId}
        initial={data.layout}
        onChange={save}
        actions={actions}
        heading={<h1>{t("home.module.title", { module: t(`nav.modules.${data.module}`) })}</h1>}
      />
      {data.catalog.length === 0 ? (
        <p className="erp-muted erp-small" data-testid="module-home-empty">
          {t("home.module.empty")}
        </p>
      ) : widgets.length === 0 ? (
        <p className="erp-muted erp-small" data-testid="module-home-all-off">
          {t("home.module.all_off")}
        </p>
      ) : null}
    </div>
  );
}
