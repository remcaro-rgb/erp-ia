// The five hierarchical masters of the accounting module and the page of each (accounting design §8): Plan de cuentas and the
// four analytic dimensions share one page with a Tabla · Árbol toggle. Pure, so the pages, the actions and the tests agree.

export interface MasterPage {
  entity: string;
  /** Where the page lives; the menu item names the grid. */
  href: string;
  /** The process behind "Nuevo" / "Nueva cuenta auxiliar" and the import. */
  create: string;
  /** Which figure the tree shows (design §8): balance, result or net movement. */
  figure: "balance" | "result" | "movement";
}

export const MASTER_PAGES: readonly MasterPage[] = [
  { entity: "accounting.account", href: "/accounting/accounts", create: "accounting.account.create", figure: "balance" },
  { entity: "accounting.cost_center", href: "/accounting/cost-centers", create: "accounting.cost_center.create", figure: "result" },
  { entity: "accounting.open_auxiliary", href: "/accounting/open-auxiliaries", create: "accounting.open_auxiliary.create", figure: "movement" },
  { entity: "accounting.item", href: "/accounting/items", create: "accounting.item.create", figure: "movement" },
  { entity: "accounting.business_unit", href: "/accounting/business-units", create: "accounting.business_unit.create", figure: "movement" },
];

export const masterPage = (entity: string): MasterPage | null => MASTER_PAGES.find((m) => m.entity === entity) ?? null;

export type MasterView = "table" | "tree";

/** The `kernel.user_prefs` key of the Tabla · Árbol choice: `master_view.<entity>` (preference keys are dotted snake_case, the plan's colon is not one). */
export const masterViewKey = (entity: string): string => `master_view.${entity}`;

/** The view a stored preference names; Tabla when there is none or it is not one of the two. */
export function parseMasterView(stored: unknown): MasterView {
  const value = typeof stored === "object" && stored !== null && "value" in stored ? (stored as { value: unknown }).value : stored;
  return value === "tree" ? "tree" : "table";
}

/** The levels of the chart an auxiliary account may hang from (design §4.1): a subcuenta or another auxiliary. */
export const canHangAuxiliary = (level: string | undefined): boolean => level === "subaccount" || level === "auxiliary";

export interface NodeInput {
  code: string;
  name: string;
  parentId?: string | null;
  kind?: "group" | "leaf";
  isActive?: boolean;
}

/** The input of the create process of `entity` for what the dialog collected. */
export function createInputFor(entity: string, input: NodeInput): Record<string, unknown> {
  const code = input.code.trim();
  const name = input.name.trim();
  if (entity === "accounting.account") return { code, name };
  return { code, name, parentId: input.parentId || null, kind: input.kind ?? "leaf", isActive: input.isActive ?? true };
}
