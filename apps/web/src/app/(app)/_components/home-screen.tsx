"use client";

import { useCallback, useEffect, useMemo } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Dashboard, HelpWidget, KpisWidget, RecentWidget, RecommendationsWidget, UpdatedAt, useAskAssistant, type DashboardWidget, type WidgetLayout } from "@erp/ui";
import type { HomeData } from "@/lib/home/load";
import { createLayoutSaver } from "@/lib/home/layout-save";
import { saveShellPrefAction } from "@/lib/prefs/actions";
import type { ShellPrefKey } from "@/lib/prefs/validate";
import { useHomeCustomize } from "./use-customize";
import { useRecommendations } from "./use-recommendations";

/**
 * The home screen (design §19a, prototype `renderHome`): the greeting and the widget dashboard. The widgets the caller may
 * not have (their process refused) are not drawn. An accepted recommendation action opens the assistant with
 * "Ejecuta <proceso> con <input>", so the agent produces the usual confirmation card (rules 17 and 28): nothing runs here.
 * A recommendation a process raised (plan 2B Task 38) links its record («Abrir registro») and is dismissed with «Descartar».
 */
export function HomeScreen({ data, userId, companyId }: { data: HomeData; userId: string; companyId: string }) {
  const t = useTranslations();
  const router = useRouter();
  const ask = useAskAssistant();
  const { items: recommendations, pending, failed, decide, open } = useRecommendations(data.recommendations ?? []);
  const { hidden, actions } = useHomeCustomize(data.hidden, data.catalog);

  // The KPIs and the recommendations are a snapshot of the page load: they say when it was read.
  const asOf = <UpdatedAt at={data.asOf} />;
  const widgets: DashboardWidget[] = [];
  if (data.kpis) widgets.push({ id: "kpis", title: t("home.widgets.kpis"), meta: asOf, content: <KpisWidget kpis={data.kpis.filter((kpi) => !hidden.includes(kpi.id))} /> });
  if (data.recommendations) {
    widgets.push({
      id: "recommendations",
      title: t("home.widgets.recommendations"),
      meta: asOf,
      content: (
        <RecommendationsWidget
          items={recommendations}
          pendingId={pending}
          error={failed}
          onAction={(id, _processId, _input, index) => void decide(id, "accepted", index)}
          onLink={(id, _href, index) => void decide(id, "accepted", index)}
          onDismiss={(id) => void decide(id, "dismissed")}
          onOpen={open}
        />
      ),
    });
  }
  if (data.recent) widgets.push({ id: "recent", title: t("home.widgets.recent"), content: <RecentWidget records={data.recent} onOpen={(href) => router.push(href)} /> });
  widgets.push({ id: "help", title: t("home.widgets.help"), content: <HelpWidget shortcuts={data.help} onAsk={ask} /> });

  // The dashboard already cached the layout in this browser; a save that has not landed when the page hides goes as a beacon.
  const saver = useMemo(
    () =>
      createLayoutSaver({
        action: (pref) => saveShellPrefAction({ ...pref, key: pref.key as ShellPrefKey }),
        beacon: (pref) => navigator.sendBeacon("/api/prefs", new Blob([JSON.stringify(pref)], { type: "application/json" })),
      }),
    [],
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
    <div className="flex flex-col gap-4" data-testid="home">
      <Dashboard
        userId={userId}
        companyId={companyId}
        widgets={widgets}
        initial={data.layout}
        onChange={save}
        actions={actions}
        heading={<h1>{t(`home.greeting.${data.greeting.period}`, { name: data.greeting.name })}</h1>}
      />
    </div>
  );
}
