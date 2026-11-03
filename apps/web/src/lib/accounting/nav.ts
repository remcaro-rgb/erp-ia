import { runnableProcesses, withClaims, type JwtClaims, type RunProcessDeps } from "@erp/kernel";
import type { NavItem } from "@erp/ui";

// The three optional analytic masters stay out of the Maestros menu while the company does not use them (accounting design §4.11, §8):
// Auxiliares abiertos, Ítems and Unidades de negocio follow `use_open_auxiliaries`, `use_items` and `use_business_units`. The pages
// still open by their address; only the menu hides them.

export interface OptionalMasters {
  openAuxiliaries: boolean;
  items: boolean;
  businessUnits: boolean;
}

/** The menu item of each optional master and the setting that shows it. */
const GATES: readonly { id: string; uses: keyof OptionalMasters }[] = [
  { id: "accounting.open_auxiliaries", uses: "openAuxiliaries" },
  { id: "accounting.items", uses: "items" },
  { id: "accounting.business_units", uses: "businessUnits" },
];

/** True when the menu holds one of the optional masters (so the settings are worth reading). */
export const hasOptionalMasters = (nav: readonly NavItem[]): boolean => nav.some((item) => GATES.some((g) => g.id === item.id) || (item.children ? hasOptionalMasters(item.children) : false));

/** The menu without the optional masters whose setting is off; a group left with no item is dropped, except a menu section (its empty state shows). */
export function hideOptionalMasters(nav: readonly NavItem[], uses: OptionalMasters): NavItem[] {
  const hidden = new Set(GATES.filter((g) => !uses[g.uses]).map((g) => g.id));
  return nav.flatMap((item): NavItem[] => {
    if (hidden.has(item.id)) return [];
    if (!item.children) return [item];
    const children = hideOptionalMasters(item.children, uses);
    return children.length > 0 || item.section ? [{ ...item, children }] : [];
  });
}

/** The company's settings as the caller sees them; every optional master is off when there is no settings row or the field is not visible. */
export async function readOptionalMasters(sql: RunProcessDeps["sql"], claims: JwtClaims): Promise<OptionalMasters> {
  const [row] = await withClaims(sql, claims, (tx) =>
    tx<{ use_open_auxiliaries: boolean | null; use_items: boolean | null; use_business_units: boolean | null }[]>`
      select use_open_auxiliaries, use_items, use_business_units from accounting.v_settings where company_id = ${claims.active_company_id}`,
  );
  return { openAuxiliaries: row?.use_open_auxiliaries === true, items: row?.use_items === true, businessUnits: row?.use_business_units === true };
}

// Reglas contables carries the number of events waiting to be posted (accounting design §8, §10b.16): the bar item shows it as a badge.

const POSTING_ITEM = "accounting.posting";

/** True when the menu holds Reglas contables (so the pending count is worth reading). */
export const hasPostingItem = (nav: readonly NavItem[]): boolean => nav.some((item) => item.id === POSTING_ITEM || (item.children ? hasPostingItem(item.children) : false));

/** The menu with `pending` on the Reglas contables item; nothing changes while there is none. */
export function withPostingBadge(nav: readonly NavItem[], pending: number): NavItem[] {
  if (pending <= 0) return [...nav];
  return nav.map((item) => (item.id === POSTING_ITEM ? { ...item, badge: pending } : item.children ? { ...item, children: withPostingBadge(item.children, pending) } : item));
}

/** Pending postings the caller can see, 0 when their roles may not consult the inbox (`accounting.posting_failure.consult`). */
export async function readPendingPostings(sql: RunProcessDeps["sql"], registry: RunProcessDeps["registry"], claims: JwtClaims): Promise<number> {
  const runnable = await runnableProcesses(sql, registry, claims, ["accounting.posting_failure.consult"]);
  if (!runnable.has("accounting.posting_failure.consult")) return 0;
  const [row] = await withClaims(sql, claims, (tx) => tx<{ n: number }[]>`select count(*)::int as n from accounting.v_posting_failures where company_id = ${claims.active_company_id} and status = 'pending'`);
  return row?.n ?? 0;
}
