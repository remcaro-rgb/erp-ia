import { gridEntity, reasonKeyOf, type RecommendationOut, type Registry } from "@erp/kernel";
import { hasRecordPage, recordHref } from "@erp/kernel/href";
import type { RecommendationItem } from "@erp/ui";

// Pure rules of the home page: where a recent record opens, and which help shortcuts make sense for the screens the caller has.

/** The page of a record of `entity` (rule 21: where `recordHref` says), or null for an entity with no page of its own. */
export function recentHref(entity: { id: string; recordPage?: boolean } | null | undefined, id: string): string | null {
  return entity && hasRecordPage(entity) ? recordHref(entity.id, id) : null;
}

export interface HelpShortcutDef {
  id: string;
  labelKey: string;
  questionKey: string;
}

const shortcut = (id: string): HelpShortcutDef => ({ id, labelKey: `home.help.${id}.label`, questionKey: `home.help.${id}.question` });

/**
 * The guides the home offers as questions for the assistant: only for screens the caller can open (`navHrefs` are the
 * menu items the shell offers them), and the two-step verification one for everybody.
 */
export function helpShortcuts(navHrefs: readonly string[]): HelpShortcutDef[] {
  const has = (href: string) => navHrefs.includes(href);
  const ids: string[] = [];
  if (has("/parties")) ids.push("parties");
  if (has("/products")) ids.push("products");
  if (has("/parties") || has("/products")) ids.push("listings");
  if (has("/import")) ids.push("import");
  ids.push("two_factor");
  return ids.map(shortcut);
}

/**
 * Where the record a process recommendation is about opens (plan 2B Task 38, rule 21): its page; for an entity without one (a costing
 * cost_missing row) the list page of the entity among the caller's menu items; else nothing. A subject the kernel hid (null: the caller
 * may not consult it) opens nothing.
 */
export function subjectHref(registry: Registry, nav: readonly { entity?: string; href: string }[], subject: { entity: string; id: string } | null): string | null {
  if (!subject) return null;
  const entity = gridEntity(registry, subject.entity);
  if (!entity) return null;
  if (hasRecordPage(entity)) return recordHref(entity.id, subject.id);
  return nav.find((item) => item.entity === subject.entity)?.href ?? null;
}

/** What the card and the bell need of a recommendation the kernel listed: its keys, masked params, the reason's key and the link. */
export function recommendationItem(registry: Registry, nav: readonly { entity?: string; href: string }[], r: RecommendationOut): RecommendationItem {
  const base: RecommendationItem = { id: r.id, source: r.source, agentProfile: r.agentProfile, title: r.title, body: r.body, confidence: r.confidence, suggestedActions: r.suggestedActions };
  if (r.source !== "process") return base;
  return {
    ...base,
    module: r.module,
    titleKey: r.titleKey,
    bodyKey: r.bodyKey,
    reason: r.reason,
    reasonKey: reasonKeyOf(r.module, r.reason),
    params: r.params,
    href: subjectHref(registry, nav, r.subject),
  };
}
