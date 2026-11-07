import type { RecommendationItem } from "./RecommendationCard";

/** The translator of next-intl at the catalogue's root (`useTranslations()`), as far as composing a recommendation needs it. */
export interface RecommendationTranslator {
  (key: string, values?: Record<string, string | number>): string;
  has(key: string): boolean;
}

/** What a masked value (null) reads as. */
export const MASKED_VALUE = "—";

/**
 * The title and body of a recommendation as the viewer reads them (plan 2B Task 38): an agent's row has its own text; a process row is
 * composed from its catalogue keys with its params, already masked by the kernel for this viewer (a null reads «—»), and its reason's
 * text as the `reason` argument (the code itself when the catalogue has none). A key the catalogue lacks falls back to the stored text.
 */
export function recommendationText(t: RecommendationTranslator, item: RecommendationItem): { title: string; body: string } {
  if (item.source !== "process" || !item.titleKey || !item.bodyKey) return { title: item.title, body: item.body };
  const values: Record<string, string | number> = {};
  for (const [name, value] of Object.entries(item.params ?? {})) values[name] = value ?? MASKED_VALUE;
  if (values.reason === undefined) values.reason = item.reasonKey && t.has(item.reasonKey) ? t(item.reasonKey) : item.reason ?? MASKED_VALUE;
  const compose = (key: string, fallback: string) => (t.has(key) ? t(key, values) : fallback);
  return { title: compose(item.titleKey, item.title), body: compose(item.bodyKey, item.body) };
}
