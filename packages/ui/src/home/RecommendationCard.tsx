"use client";

import { useTranslations } from "next-intl";
import { recommendationText } from "./recommendation-text";

export type SuggestedActionItem = { label: string; processId: string; input: Record<string, unknown> } | { label: string; href: string };

export interface RecommendationItem {
  id: string;
  title: string;
  body: string;
  /** Who wrote it: `help`, `seed` or an agent profile of phase 3. */
  agentProfile: string;
  confidence?: number | null;
  suggestedActions: SuggestedActionItem[];
  /** `process`: raised by a registered process (plan 2B Task 38); its text is composed from the keys below. Absent: an agent's. */
  source?: "agent" | "process";
  /** The raising module (its name is `nav.modules.<module>`). */
  module?: string | null;
  titleKey?: string | null;
  bodyKey?: string | null;
  /** The reason's code and its catalogue key (`<module>.recommendation.reason.<code>`): the `reason` argument of the text. */
  reason?: string | null;
  reasonKey?: string | null;
  /** The values the text names, masked by the kernel for this viewer (null when the field is not theirs to see). */
  params?: Record<string, string | number | null>;
  /** Where the record it is about opens; null when the viewer may not open it (or it names none). */
  href?: string | null;
}

export interface RecommendationCardProps {
  recommendation: RecommendationItem;
  /** The user chose a process action: `index` is the action's place in the recommendation (the decision records it). */
  onAction: (processId: string, input: Record<string, unknown>, index: number) => void;
  /** The user chose a link action. */
  onLink: (href: string, index: number) => void;
  onDismiss: (id: string) => void;
  /** The user opens the record a process row is about (navigation only: nothing is decided). */
  onOpen?: (href: string) => void;
  /** The decision is being saved: nothing else can be pressed. */
  busy?: boolean;
}

const KNOWN_AGENTS = new Set(["help", "seed"]);

/**
 * A recommendation offered to the user (design §7.5, rule 28; prototype `.rec`): what was noticed, why, and the actions it
 * suggests. It never runs anything: choosing an action hands the process and its input to the screen, which opens the
 * assistant so the confirmation card is the usual one.
 */
export function RecommendationCard({ recommendation, onAction, onLink, onDismiss, onOpen, busy = false }: RecommendationCardProps) {
  const t = useTranslations("home.recommendations");
  const root = useTranslations();
  const { agentProfile } = recommendation;
  const raised = recommendation.source === "process";
  const who = raised
    ? t("agents.process", { module: recommendation.module && root.has(`nav.modules.${recommendation.module}`) ? root(`nav.modules.${recommendation.module}`) : (recommendation.module ?? "") })
    : KNOWN_AGENTS.has(agentProfile)
      ? t(`agents.${agentProfile as "help" | "seed"}`)
      : t("agents.other", { name: agentProfile });
  const { title, body } = recommendationText(root, recommendation);
  return (
    <article className="erp-rec" data-recommendation={recommendation.id}>
      <div className="erp-rec__who">
        {who}
        {typeof recommendation.confidence === "number" ? ` · ${t("confidence", { percent: Math.round(recommendation.confidence * 100) })}` : ""}
      </div>
      <div className="erp-rec__title">{title}</div>
      <p className="erp-rec__body">{body}</p>
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
        {raised &&
          (recommendation.href ? (
            <button type="button" className="erp-btn erp-btn--primary" disabled={busy} onClick={() => onOpen?.(recommendation.href!)}>
              {t("open_record")}
            </button>
          ) : (
            <span className="erp-muted erp-small">{t("no_link")}</span>
          ))}
        <button type="button" className="erp-btn erp-btn--ghost" disabled={busy} onClick={() => onDismiss(recommendation.id)}>
          {t("dismiss")}
        </button>
      </div>
    </article>
  );
}
