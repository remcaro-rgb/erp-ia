"use client";

import { useTranslations } from "next-intl";

export type SuggestedActionItem = { label: string; processId: string; input: Record<string, unknown> } | { label: string; href: string };

export interface RecommendationItem {
  id: string;
  title: string;
  body: string;
  /** Who wrote it: `help`, `seed` or an agent profile of phase 3. */
  agentProfile: string;
  confidence?: number | null;
  suggestedActions: SuggestedActionItem[];
}

export interface RecommendationCardProps {
  recommendation: RecommendationItem;
  /** The user chose a process action: `index` is the action's place in the recommendation (the decision records it). */
  onAction: (processId: string, input: Record<string, unknown>, index: number) => void;
  /** The user chose a link action. */
  onLink: (href: string, index: number) => void;
  onDismiss: (id: string) => void;
  /** The decision is being saved: nothing else can be pressed. */
  busy?: boolean;
}

const KNOWN_AGENTS = new Set(["help", "seed"]);

/**
 * A recommendation offered to the user (design §7.5, rule 28; prototype `.rec`): what was noticed, why, and the actions it
 * suggests. It never runs anything: choosing an action hands the process and its input to the screen, which opens the
 * assistant so the confirmation card is the usual one.
 */
export function RecommendationCard({ recommendation, onAction, onLink, onDismiss, busy = false }: RecommendationCardProps) {
  const t = useTranslations("home.recommendations");
  const { agentProfile } = recommendation;
  const who = KNOWN_AGENTS.has(agentProfile) ? t(`agents.${agentProfile as "help" | "seed"}`) : t("agents.other", { name: agentProfile });
  return (
    <article className="erp-rec">
      <div className="erp-rec__who">
        {who}
        {typeof recommendation.confidence === "number" ? ` · ${t("confidence", { percent: Math.round(recommendation.confidence * 100) })}` : ""}
      </div>
      <div className="erp-rec__title">{recommendation.title}</div>
      <p className="erp-rec__body">{recommendation.body}</p>
      <div className="erp-rec__chips">
        {recommendation.suggestedActions.map((action, index) => (
          <button
            key={index}
            type="button"
            className="erp-btn erp-btn--primary"
            disabled={busy}
            onClick={() => ("processId" in action ? onAction(action.processId, action.input, index) : onLink(action.href, index))}
          >
            {action.label}
          </button>
        ))}
        <button type="button" className="erp-btn erp-btn--ghost" disabled={busy} onClick={() => onDismiss(recommendation.id)}>
          {t("dismiss")}
        </button>
      </div>
    </article>
  );
}
