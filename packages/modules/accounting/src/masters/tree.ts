import { countryPack, type Tx } from "@erp/kernel";
import { DIMENSION_DEFS, DIMENSIONS, type Dimension } from "../dimensions";
import { INCOME_SECTIONS } from "../reports/income-statement";

// The tree pane's data (accounting design §8, Task 26): the nodes of the chart or of one analytic dimension with the
// figure of the selected period beside each: accounts show their balance, cost centers their result, the other dimensions
// their net movement. A group adds up its descendants. The nodes shown come from the published views (`v_accounts`, the dimension
// views), so a restricted account the caller may not view is neither a node nor part of a figure (§5.13, §4.15). The figures come
// from `v_account_balances` and the tree's structure from `accounting.master_tree` (0046): a node a record rule hides from the caller
// is not shown, but its amounts stay in its ancestors' figures (D11, Task 9 review I1); a shown node under a hidden one hangs from
// its nearest shown ancestor, and every node shows at the root when parent_id is masked or hidden for the caller (rule 14).

export type MasterFigure = "balance" | "result" | "movement";

export interface MasterTreeItem {
  id: string;
  parentId: string | null;
  code: string;
  name: string;
  /** Level of an account (`class` … `auxiliary`), kind of a dimension node (`group | leaf`). */
  level: string;
  /** The account is restricted, or lies under a restricted account. */
  restricted: boolean;
  inactive: boolean;
  /** Pesos with two decimals, or null when no period is chosen. */
  figure: number | null;
}

export interface MasterTree {
  figure: MasterFigure;
  items: MasterTreeItem[];
}

export const MASTER_ENTITIES = ["accounting.account", ...Object.values(DIMENSION_DEFS).map((d) => d.entity)] as const;
export type MasterEntity = (typeof MASTER_ENTITIES)[number];

/** The figure each master shows beside its nodes (design §8). */
export const figureOf = (entity: MasterEntity): MasterFigure => (entity === "accounting.account" ? "balance" : entity === "accounting.cost_center" ? "result" : "movement");

const cents = (n: number) => Math.round(n * 100) / 100;

interface Node {
  id: string;
  parent_id: string | null;
  code: string;
  name: string;
  is_active: boolean;
  level?: string;
  kind?: string;
  nature?: "debit" | "credit";
  access?: string;
}

type Link = Pick<Node, "id" | "parent_id">;

/** The whole tree of `kind` (readable or not), and the shown nodes re-hung from their nearest shown ancestor. */
async function structure(tx: Tx, kind: string, shown: readonly Node[]): Promise<{ all: Link[]; linked: Node[]; nodes: Node[] }> {
  const all = await tx<Link[]>`select id, parent_id from accounting.master_tree(${kind})`;
  const parentOf = new Map(all.map((n) => [n.id, n.parent_id]));
  const visible = new Set(shown.map((n) => n.id));
  const nearest = (id: string | null): string | null => {
    for (let cur = id, steps = 0; cur && steps <= all.length; steps++) {
      if (visible.has(cur)) return cur;
      cur = parentOf.get(cur) ?? null;
    }
    return null;
  };
  // A caller for whom parent_id is masked or hidden sees no structure (rule 14): every node at the root; the figures still add up
  // the whole tree (D11, ruling of 2026-11-02).
  const [field] = await tx<{ visible: boolean }[]>`select kernel.field_visible(${`accounting.${kind}`}, 'parent_id') as visible`;
  const linked = shown.map((n) => ({ ...n, parent_id: nearest(parentOf.has(n.id) ? (parentOf.get(n.id) ?? null) : n.parent_id) }));
  return { all, linked, nodes: field?.visible ? linked : shown.map((n) => ({ ...n, parent_id: null })) };
}

/** Sums `own` (raw per node) over each node and its descendants. */
function rollUp(nodes: readonly Link[], own: ReadonlyMap<string, number>): Map<string, number> {
  const children = new Map<string | null, Link[]>();
  for (const n of nodes) children.set(n.parent_id, [...(children.get(n.parent_id) ?? []), n]);
  const total = new Map<string, number>();
  const visit = (node: Link, seen: Set<string>): number => {
    if (seen.has(node.id)) return 0;
    seen.add(node.id);
    const sum = (children.get(node.id) ?? []).reduce((acc, c) => acc + visit(c, seen), own.get(node.id) ?? 0);
    total.set(node.id, sum);
    return sum;
  };
  const seen = new Set<string>();
  for (const root of nodes.filter((n) => n.parent_id === null || !nodes.some((m) => m.id === n.parent_id))) visit(root, seen);
  return total;
}

/** The ids of the nodes marked restricted or below a restricted one, among `nodes`. */
function restrictedIds(nodes: readonly Node[]): Set<string> {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const out = new Set<string>();
  for (const node of nodes) {
    for (let cur: Node | undefined = node, steps = 0; cur && steps <= nodes.length; steps++) {
      if (cur.access === "restricted") {
        out.add(node.id);
        break;
      }
      cur = cur.parent_id ? byId.get(cur.parent_id) : undefined;
    }
  }
  return out;
}

/** The nodes of `entity` for `companyId` with the figure of `periodId` (none when null), read under the caller's claims. */
export async function masterTree(tx: Tx, input: { entity: MasterEntity; companyId: string; periodId: string | null }): Promise<MasterTree> {
  const { entity, companyId, periodId } = input;
  const figure = figureOf(entity);
  const [period] = periodId
    ? await tx<{ starts_on: string }[]>`select starts_on::text from accounting.v_periods where id = ${periodId} and company_id = ${companyId}`
    : [];

  if (entity === "accounting.account") {
    const shown = await tx<Node[]>`
      select id, parent_id, code, name, is_active, level, nature, access from accounting.v_accounts where company_id = ${companyId} order by code`;
    const { all, linked, nodes } = await structure(tx, "account", shown);
    const own = new Map<string, number>();
    if (period) {
      // The balance at the end of the period: every posted line up to it, debit minus credit, signed by nature after adding up.
      const sums = await tx<{ account_id: string; debit: string; credit: string }[]>`
        select b.account_id, sum(b.debit) as debit, sum(b.credit) as credit
        from accounting.v_account_balances b join accounting.v_periods p on p.id = b.period_id
        where b.company_id = ${companyId} and p.starts_on <= ${period.starts_on}::date
        group by b.account_id`;
      for (const s of sums) own.set(s.account_id, Number(s.debit) - Number(s.credit));
    }
    const total = rollUp(all, own);
    // Inherited restriction follows the real structure, whether or not the caller sees it.
    const restricted = restrictedIds(linked);
    return {
      figure,
      items: nodes.map((n) => ({
        id: n.id,
        parentId: n.parent_id,
        code: n.code,
        name: n.name,
        level: n.level ?? "",
        restricted: restricted.has(n.id),
        inactive: !n.is_active,
        figure: period ? cents(n.nature === "credit" ? -(total.get(n.id) ?? 0) : (total.get(n.id) ?? 0)) : null,
      })),
    };
  }

  const dimension = DIMENSIONS.find((d) => DIMENSION_DEFS[d].entity === entity) as Dimension | undefined;
  if (!dimension) throw new Error(`${entity} is not a master with a tree`);
  const def = DIMENSION_DEFS[dimension];
  const shown = await tx<Node[]>`
    select id, parent_id, code, name, is_active, kind from ${tx(`accounting.v_${def.table}`)} where company_id = ${companyId} order by code`;
  const { all, nodes } = await structure(tx, dimension, shown);
  const own = new Map<string, number>();
  if (period && periodId) {
    if (figure === "result") {
      const [company] = await tx<{ country_code: string }[]>`select country_code from kernel.companies where id = ${companyId}`;
      const sections = company ? countryPack(company.country_code).accounting.statementLayouts().incomeStatement.map((s) => s.code) : [];
      const sums = await tx<{ node: string; section: string; debit: string; credit: string }[]>`
        select b.${tx(def.column)} as node, b.statement_section as section, sum(b.debit) as debit, sum(b.credit) as credit
        from accounting.v_account_balances b
        where b.company_id = ${companyId} and b.period_id = ${periodId} and not b.is_opening and not b.is_closing
          and b.${tx(def.column)} is not null and b.statement_section = any(${sections}::text[])
        group by b.${tx(def.column)}, b.statement_section`;
      for (const s of sums) {
        const value = INCOME_SECTIONS.has(s.section) ? Number(s.credit) - Number(s.debit) : Number(s.debit) - Number(s.credit);
        own.set(s.node, (own.get(s.node) ?? 0) + (INCOME_SECTIONS.has(s.section) ? value : -value));
      }
    } else {
      const sums = await tx<{ node: string; debit: string; credit: string }[]>`
        select b.${tx(def.column)} as node, sum(b.debit) as debit, sum(b.credit) as credit
        from accounting.v_account_balances b
        where b.company_id = ${companyId} and b.period_id = ${periodId} and not b.is_opening and not b.is_closing and b.${tx(def.column)} is not null
        group by b.${tx(def.column)}`;
      for (const s of sums) own.set(s.node, Number(s.debit) - Number(s.credit));
    }
  }
  const total = rollUp(all, own);
  return {
    figure,
    items: nodes.map((n) => ({ id: n.id, parentId: n.parent_id, code: n.code, name: n.name, level: n.kind ?? "", restricted: false, inactive: !n.is_active, figure: period ? cents(total.get(n.id) ?? 0) : null })),
  };
}
