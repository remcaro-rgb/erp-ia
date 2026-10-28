"use client";

import { useCallback, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Dashboard, HelpWidget, KpisWidget, RecentWidget, RecommendationsWidget, useAskAssistant, type DashboardWidget, type RecommendationItem, type WidgetLayout } from "@erp/ui";
import { decideRecommendationAction } from "@/lib/home/actions";
import type { HomeData } from "@/lib/home/load";
import { saveShellPrefAction } from "@/lib/prefs/actions";

/**
 * The home screen (design §19a, prototype `renderHome`): the greeting and the widget dashboard. The widgets the caller may
 * not have (their process refused) are not drawn. An accepted recommendation action opens the assistant with
 * "Ejecuta <proceso> con <input>", so the agent produces the usual confirmation card (rules 17 and 28): nothing runs here.
 */
export function HomeScreen({ data, userId, companyId }: { data: HomeData; userId: string; companyId: string }) {
  const t = useTranslations();
  const router = useRouter();
  const ask = useAskAssistant();
  const [recommendations, setRecommendations] = useState<RecommendationItem[]>(data.recommendations ?? []);
  const [pending, setPending] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  const decide = useCallback(
    async (id: string, decision: "accepted" | "dismissed", action = 0) => {
      setPending(id);
      setFailed(false);
      try {
        const outcome = await decideRecommendationAction({ id, decision, action });
        if (!outcome.ok) {
          // Already decided elsewhere or no longer yours: it leaves the inbox; anything else is said.
          if (outcome.code === "not_found" || outcome.code === "handler_failed") setRecommendations((list) => list.filter((r) => r.id !== id));
          setFailed(outcome.code !== "not_found");
          return;
        }
        setRecommendations((list) => list.filter((r) => r.id !== id));
        const { open, href } = outcome.result;
        if (open) {
          const input = JSON.stringify(open.input);
          ask(Object.keys(open.input).length === 0 ? t("home.assistant.run_plain", { process: open.processId }) : t("home.assistant.run", { process: open.processId, input }));
        } else if (href) {
          router.push(href);
        }
      } catch {
        setFailed(true);
      } finally {
        setPending(null);
      }
    },
    [ask, router, t],
  );

  const widgets: DashboardWidget[] = [];
  if (data.kpis) widgets.push({ id: "kpis", title: t("home.widgets.kpis"), content: <KpisWidget kpis={data.kpis} /> });
  if (data.recommendations) {
    widgets.push({
      id: "recommendations",
      title: t("home.widgets.recommendations"),
      content: (
        <RecommendationsWidget
          items={recommendations}
          pendingId={pending}
          error={failed}
          onAction={(id, _processId, _input, index) => void decide(id, "accepted", index)}
          onLink={(id, _href, index) => void decide(id, "accepted", index)}
          onDismiss={(id) => void decide(id, "dismissed")}
        />
      ),
    });
  }
  if (data.recent) widgets.push({ id: "recent", title: t("home.widgets.recent"), content: <RecentWidget records={data.recent} onOpen={(href) => router.push(href)} /> });
  widgets.push({ id: "help", title: t("home.widgets.help"), content: <HelpWidget shortcuts={data.help} onAsk={ask} /> });

  const save = useCallback((layout: WidgetLayout[], savedAt: number) => {
    // The dashboard already cached it in this browser; a refused or lost save is retried from that cache on the next visit.
    void saveShellPrefAction({ key: "home_layout", value: layout, savedAt }).catch(() => {});
  }, []);

  return (
    <div className="flex flex-col gap-4" data-testid="home">
      <Dashboard
        userId={userId}
        companyId={companyId}
        widgets={widgets}
        initial={data.layout}
        onChange={save}
        heading={<h1>{t(`home.greeting.${data.greeting.period}`, { name: data.greeting.name })}</h1>}
      />
    </div>
  );
}
