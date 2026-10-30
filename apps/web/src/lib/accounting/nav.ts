import { withClaims, type JwtClaims, type RunProcessDeps } from "@erp/kernel";
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

/** The menu without the optional masters whose setting is off; a group left with no item is dropped. */
export function hideOptionalMasters(nav: readonly NavItem[], uses: OptionalMasters): NavItem[] {
  const hidden = new Set(GATES.filter((g) => !uses[g.uses]).map((g) => g.id));
  return nav.flatMap((item): NavItem[] => {
    if (hidden.has(item.id)) return [];
    if (!item.children) return [item];
    const children = hideOptionalMasters(item.children, uses);
    return children.length > 0 ? [{ ...item, children }] : [];
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
