"use client";

import { useCallback, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useAskAssistant, type RecommendationItem } from "@erp/ui";
import { decideRecommendationAction } from "@/lib/home/actions";

/**
 * The recommendations of a page (Inicio's «Recomendaciones para ti», a module's «Pendientes») and the one decision a user takes on them,
 * through `kernel.recommendation.decide` (audited). An accepted process action opens the assistant with "Ejecuta <proceso> con <input>",
 * so the agent produces the usual confirmation card (rules 17 and 28): nothing runs here. After a decision the page is refreshed so the
 * bell's count follows (plan 2B Task 38).
 */
export function useRecommendations(initial: RecommendationItem[]) {
  const t = useTranslations();
  const router = useRouter();
  const ask = useAskAssistant();
  const [items, setItems] = useState<RecommendationItem[]>(initial);
  const [pending, setPending] = useState<string | null>(null);
  const [failed, setFailed] = useState<"failed" | "refused" | null>(null);

  const decide = useCallback(
    async (id: string, decision: "accepted" | "dismissed", action = 0) => {
      setPending(id);
      setFailed(null);
      try {
        const outcome = await decideRecommendationAction({ id, decision, action });
        if (!outcome.ok) {
          // Already decided elsewhere or no longer yours: it leaves the list; anything else is said.
          if (outcome.code === "not_found" || outcome.code === "handler_failed") setItems((list) => list.filter((r) => r.id !== id));
          // A suggested action the role may not take: the recommendation stays, with the reason.
          setFailed(outcome.code === "not_found" ? null : outcome.code === "forbidden" || outcome.code === "not_entitled" ? "refused" : "failed");
          return;
        }
        setItems((list) => list.filter((r) => r.id !== id));
        const { open, href } = outcome.result;
        if (open) {
          const input = JSON.stringify(open.input);
          ask(Object.keys(open.input).length === 0 ? t("home.assistant.run_plain", { process: open.processId }) : t("home.assistant.run", { process: open.processId, input }));
          router.refresh();
        } else if (href) {
          router.push(href);
        } else {
          router.refresh();
        }
      } catch {
        setFailed("failed");
      } finally {
        setPending(null);
      }
    },
    [ask, router, t],
  );

  return { items, pending, failed, decide, open: useCallback((href: string) => router.push(href), [router]) };
}
