import { hasRecordPage, recordHref } from "@erp/kernel/href";

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
