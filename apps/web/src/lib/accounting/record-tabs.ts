import "server-only";
import { getLocale, getTranslations } from "next-intl/server";
import { ACCOUNT_ROLES, callerProfile, gridPageAccess, ProcessError, runnableProcesses, runProcess, withClaims, type Caller } from "@erp/kernel";
import { DIMENSION_DEFS, DIMENSIONS, accountBalances, nodeFigures, type AccountBalances, type Dimension, type NodeFigures } from "@erp/module-accounting";
import { formatDayTime, type CloseCheckRow, type CodeOption, type GridColumn, type PeriodSummaryRow, type RuleChange, type RuleTestEvent, type SecurityDraft, type Subject, type TimelineItem } from "@erp/ui";
import { gridDenial, gridEntity } from "@/lib/grid/access";
import { buildColumns } from "@/lib/grid/columns";
import { linkableEntities, refTargets } from "@/lib/grid/links";
import { presentationOf } from "@/lib/grid/presentation";
import { gridTables } from "@/lib/records/tables";
import { processDeps } from "@/lib/server/runtime";

// What the tabs of the accounting records need besides the record (accounting design §8, Task 28), read as the caller: the Saldos and
// Movimientos of a Cuenta or an analytic node, the Seguridad of a Cuenta (admin only), the Resumen, Comprobantes and Cierre of a
// Período, the Líneas, Probar and Historial of a Regla contable. Every read goes through the module's figures, the published views,
// the grid or a registered consult, so company RLS, account security and field masks apply as everywhere else.

/** A grid tab: the entity's columns as the caller sees them and the conditions that narrow it to the record. */
export interface GridTab {
  entity: string;
  title: string;
  columns: GridColumn[];
  filters: { field: string; op: "eq" | "in" | "starts" | "between"; value: unknown; value2?: unknown }[];
}

export interface SecurityTab {
  stored: SecurityDraft;
  effective: "open" | "restricted";
  inheritedFrom: string | null;
  subjects: Subject[];
}

export type AccountingTabs =
  | { kind: "account"; balances: AccountBalances | null; grid: GridTab | null; security: SecurityTab | null }
  | { kind: "dimension"; dimension: Dimension; figures: NodeFigures | null; grid: GridTab | null }
  | { kind: "period"; summary: PeriodSummaryRow[]; checks: CloseCheckRow[]; history: TimelineItem[] | null; grid: GridTab | null; closedBy: string | null; closedAt: string | null }
  | { kind: "rule"; roles: string[]; canTest: boolean; events: RuleTestEvent[]; history: RuleChange[] | null }
  | { kind: "template"; lines: TemplateLineView[] };

export interface TemplateLineView {
  lineNo: number;
  account: string;
  side: "debit" | "credit";
  amount: number | null;
  description: string | null;
}

/** The select options the master forms need besides the record. */
export interface MasterOptions {
  parents?: CodeOption[];
  journals?: CodeOption[];
}

type Row = Record<string, unknown> & { id: string };

const refused = (error: unknown): boolean => error instanceof ProcessError && (error.code === "forbidden" || error.code === "not_entitled");
const dimensionOf = (entityId: string): Dimension | null => DIMENSIONS.find((d) => DIMENSION_DEFS[d].entity === entityId) ?? null;

/** The grid of `entityId` for a tab, or null when the caller may not read it. */
export async function gridTab(caller: Caller, entityId: string, filters: GridTab["filters"]): Promise<GridTab | null> {
  const deps = processDeps();
  const entity = gridEntity(deps.registry, entityId);
  if (!entity || (await gridDenial(deps, caller.claims, entity))) return null;
  const [access, t, locale, linkable] = await Promise.all([
    gridPageAccess(deps.sql, caller.claims, entity),
    getTranslations(),
    getLocale(),
    linkableEntities(deps, caller.claims, refTargets(entity)),
  ]);
  return { entity: entity.id, title: t(entity.label), columns: buildColumns(entity, access, presentationOf(entity.id), (key) => t(key), gridTables(locale), linkable), filters };
}

/** The wall-clock text of an instant in the company's zone. */
async function clock(caller: Caller): Promise<(value: unknown) => string> {
  const profile = await callerProfile(processDeps().sql, caller.claims);
  const timeZone = profile.companies.find((c) => c.id === caller.claims.active_company_id)?.timeZone;
  return (value) => (value ? formatDayTime(value as string, timeZone) : "");
}

// ---- Cuenta ------------------------------------------------------------------------------------------------------------

async function securityOf(caller: Caller, accountId: string): Promise<SecurityTab | null> {
  const deps = processDeps();
  let consulted: { access: "open" | "restricted"; effective: "open" | "restricted"; inheritedFrom?: string; grants: { subjectKind: "role" | "user"; subjectId: string; subjectName: string | null; canView: boolean; canPost: boolean }[] };
  try {
    consulted = (await runProcess(deps, caller, "accounting.account_permission.consult", { accountId })) as typeof consulted;
  } catch (error) {
    if (refused(error)) return null;
    throw error;
  }
  const companyId = caller.claims.active_company_id;
  const [roles, users, parent] = await withClaims(deps.sql, caller.claims, async (tx) =>
    Promise.all([
      tx<{ id: string; name: string }[]>`select id, name from kernel.roles where company_id = ${companyId} order by name`,
      tx<{ id: string; full_name: string | null; email: string | null }[]>`select id, full_name, email from kernel.v_users order by full_name`,
      consulted.inheritedFrom ? tx<{ code: string; name: string }[]>`select code, name from accounting.v_accounts where id = ${consulted.inheritedFrom}` : Promise.resolve([] as { code: string; name: string }[]),
    ]),
  );
  return {
    stored: { access: consulted.access, grants: consulted.grants.map((g) => ({ subjectKind: g.subjectKind, subjectId: g.subjectId, subjectName: g.subjectName, canView: g.canView, canPost: g.canPost })) },
    effective: consulted.effective,
    inheritedFrom: parent[0] ? `${parent[0].code} · ${parent[0].name}` : null,
    subjects: [
      ...roles.map((r): Subject => ({ kind: "role", id: r.id, name: r.name })),
      ...users.map((u): Subject => ({ kind: "user", id: u.id, name: u.full_name ?? u.email ?? u.id })),
    ],
  };
}

async function accountTabs(caller: Caller, record: Row): Promise<AccountingTabs> {
  const deps = processDeps();
  const companyId = caller.claims.active_company_id;
  const code = String(record.code ?? "");
  const [balances, grid, security] = await Promise.all([
    withClaims(deps.sql, caller.claims, (tx) => accountBalances(tx, { companyId, accountId: record.id })),
    gridTab(caller, "accounting.ledger_line", [{ field: "account_code", op: "starts", value: code }]),
    securityOf(caller, record.id),
  ]);
  return { kind: "account", balances, grid, security };
}

// ---- Centro de costo, auxiliar abierto, ítem, unidad de negocio -------------------------------------------------------

async function dimensionTabs(caller: Caller, dimension: Dimension, record: Row): Promise<AccountingTabs> {
  const deps = processDeps();
  const companyId = caller.claims.active_company_id;
  const def = DIMENSION_DEFS[dimension];
  const [figures, ids] = await Promise.all([
    withClaims(deps.sql, caller.claims, (tx) => nodeFigures(tx, { dimension, companyId, nodeId: record.id })),
    // The node and everything below it: the Movimientos tab lists their lines.
    withClaims(deps.sql, caller.claims, (tx) =>
      tx<{ id: string }[]>`
        with recursive below as (
          select id from ${tx(`accounting.v_${def.table}`)} where id = ${record.id}
          union all
          select t.id from ${tx(`accounting.v_${def.table}`)} t join below b on t.parent_id = b.id
        )
        select id from below limit 100`,
    ),
  ]);
  const grid = await gridTab(caller, "accounting.ledger_line", [{ field: def.column, op: "in", value: ids.map((r) => r.id) }]);
  return { kind: "dimension", dimension, figures, grid };
}

// ---- Período -----------------------------------------------------------------------------------------------------------

async function periodTabs(caller: Caller, record: Row): Promise<AccountingTabs> {
  const deps = processDeps();
  const format = await clock(caller);
  const startsOn = String(record.starts_on);
  const endsOn = String(record.ends_on);
  const [summary, checks, names, grid, history] = await Promise.all([
    withClaims(deps.sql, caller.claims, (tx) =>
      tx<{ id: string; code: string; name: string; entries: number; debit: string | null; credit: string | null }[]>`
        select j.id, j.code, j.name, count(e.id)::int as entries, sum(e.total_debit) as debit, sum(e.total_credit) as credit
        from accounting.v_entries e join accounting.v_journals j on j.id = e.journal_id
        where e.period_id = ${record.id} and e.status = 'posted'
        group by j.id, j.code, j.name order by j.code`,
    ),
    withClaims(deps.sql, caller.claims, (tx) =>
      tx<{ id: string; check: string; value: Record<string, unknown> | null; passed: boolean; note: string | null; created_at: string }[]>`
        select id, "check", value, passed, note, created_at from accounting.v_period_close_checks where period_id = ${record.id} order by created_at, seq`,
    ),
    typeof record.closed_by === "string"
      ? withClaims(deps.sql, caller.claims, (tx) => tx<{ id: string; full_name: string | null; email: string | null }[]>`select id, full_name, email from kernel.v_users where id = ${record.closed_by as string}`)
      : Promise.resolve([] as { id: string; full_name: string | null; email: string | null }[]),
    gridTab(caller, "accounting.entry", [{ field: "date", op: "between", value: startsOn, value2: endsOn }]),
    periodHistory(caller, record.id, format),
  ]);
  // The recorded checks name no user (the sign-off is the run): the admin's audit says who ran the close nearest to each set.
  const signer = (at: string): string => {
    const near = history.raw.filter((h) => Math.abs(new Date(h.at).getTime() - new Date(at).getTime()) <= 120_000).sort((a, b) => Math.abs(new Date(a.at).getTime() - new Date(at).getTime()) - Math.abs(new Date(b.at).getTime() - new Date(at).getTime()));
    return near[0]?.actor || "—";
  };
  return {
    kind: "period",
    summary: summary.map((r) => ({ journalId: r.id, journalCode: r.code, journalName: r.name, entries: r.entries, debit: Number(r.debit ?? 0), credit: Number(r.credit ?? 0) })),
    checks: checks.map((c) => ({ id: c.id, check: c.check, passed: c.passed, value: c.value ?? {}, note: c.note, by: signer(c.created_at), at: format(c.created_at) })),
    history: history.items,
    grid,
    closedBy: names[0] ? (names[0].full_name ?? names[0].email) : null,
    closedAt: record.closed_at ? format(record.closed_at) : null,
  };
}

/** The audit of the period's runs, oldest first; none for a role that cannot read the audit. */
async function periodHistory(caller: Caller, periodId: string, format: (v: unknown) => string): Promise<{ items: TimelineItem[] | null; raw: { at: string; actor: string }[] }> {
  const deps = processDeps();
  const t = await getTranslations();
  try {
    const page = (await runProcess(deps, caller, "kernel.audit.consult", { filters: [{ field: "row_id", op: "eq", value: periodId }], sort: [{ field: "occurred_at", dir: "asc" }], page: 1, pageSize: 50 })) as { rows: Record<string, unknown>[] };
    const rows = page.rows.filter((r) => String(r.process_id ?? "").startsWith("accounting.period."));
    return {
      items: rows.map((r) => ({
        id: String(r.id),
        at: format(r.occurred_at),
        actor: String(r.actor ?? ""),
        process: deps.registry.processes().find((p) => p.id === r.process_id)?.description ?? String(r.process_id ?? ""),
        action: t.has(`grid.values.audit_action.${r.action}`) ? t(`grid.values.audit_action.${r.action}`) : String(r.action ?? ""),
        origin: String(r.origin ?? ""),
      })),
      raw: rows.map((r) => ({ at: String(r.occurred_at), actor: String(r.actor ?? "") })),
    };
  } catch (error) {
    if (refused(error)) return { items: null, raw: [] };
    throw error;
  }
}

// ---- Regla contable ----------------------------------------------------------------------------------------------------

/** A value of the audit's diff as short text. */
function short(value: unknown, yes: string, no: string): string {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "boolean") return value ? yes : no;
  if (typeof value === "object") {
    const text = JSON.stringify(value);
    return text.length > 80 ? `${text.slice(0, 77)}…` : text;
  }
  return String(value);
}

async function ruleTabs(caller: Caller, record: Row): Promise<AccountingTabs> {
  const deps = processDeps();
  const companyId = caller.claims.active_company_id;
  const format = await clock(caller);
  const t = await getTranslations();
  const [runnable, events] = await Promise.all([
    runnableProcesses(deps.sql, deps.registry, caller.claims, ["accounting.posting_rule.test"]),
    withClaims(deps.sql, caller.claims, (tx) =>
      tx<{ id: string; event: string; created_at: string }[]>`
        select id, event, created_at from kernel.outbox where company_id = ${companyId} and event = ${String(record.event)} order by created_at desc limit 20`,
    ),
  ]);

  let history: RuleChange[] | null;
  try {
    const page = (await runProcess(deps, caller, "kernel.audit.consult", { filters: [{ field: "row_id", op: "eq", value: record.id }], sort: [{ field: "occurred_at", dir: "desc" }], page: 1, pageSize: 20 })) as { rows: Record<string, unknown>[] };
    history = [];
    for (const r of page.rows) {
      const detail = (await runProcess(deps, caller, "kernel.audit.entry", { id: String(r.id) }).catch((error: unknown) => {
        if (refused(error)) return null;
        throw error;
      })) as { changes: { field: string; labelKey: string | null; labelText?: string; masked: boolean; before: unknown; after: unknown }[] } | null;
      history.push({
        id: String(r.id),
        at: format(r.occurred_at),
        actor: String(r.actor ?? ""),
        process: deps.registry.processes().find((p) => p.id === r.process_id)?.description ?? String(r.process_id ?? t(`grid.values.audit_action.${r.action}`)),
        origin: String(r.origin ?? ""),
        fields: (detail?.changes ?? [])
          .filter((c) => !["updated_at", "updated_by"].includes(c.field))
          .map((c) => ({
            label: c.labelText ?? (c.labelKey && t.has(c.labelKey) ? t(c.labelKey) : c.field),
            before: c.masked ? "••••" : short(c.before, t("common.yes"), t("common.no")),
            after: c.masked ? "••••" : short(c.after, t("common.yes"), t("common.no")),
          })),
      });
    }
  } catch (error) {
    if (!refused(error)) throw error;
    history = null;
  }

  return {
    kind: "rule",
    roles: [...new Set<string>([...ACCOUNT_ROLES, ...deps.registry.modules().flatMap((m) => m.accountRoles ?? [])])],
    canTest: runnable.has("accounting.posting_rule.test"),
    events: events.map((e) => ({ id: e.id, event: e.event, at: format(e.created_at) })),
    history,
  };
}

// ---- Plantilla de comprobante --------------------------------------------------------------------------------------------

function templateTabs(record: Row): AccountingTabs {
  const lines = Array.isArray(record.lines) ? (record.lines as Record<string, unknown>[]) : [];
  return {
    kind: "template",
    lines: lines.map((l) => ({
      lineNo: Number(l.line_no),
      account: [l.account_code, l.account_name].filter(Boolean).join(" · "),
      side: l.side === "credit" ? "credit" : "debit",
      amount: l.amount === null || l.amount === undefined ? null : Number(l.amount),
      description: typeof l.description === "string" ? l.description : null,
    })),
  };
}

/** The tabs of an accounting record, or null for an entity that has none beyond Datos (Fuente). */
export async function loadAccountingTabs(caller: Caller, entityId: string, record: Row): Promise<AccountingTabs | null> {
  if (entityId === "accounting.account") return accountTabs(caller, record);
  const dimension = dimensionOf(entityId);
  if (dimension) return dimensionTabs(caller, dimension, record);
  if (entityId === "accounting.period") return periodTabs(caller, record);
  if (entityId === "accounting.posting_rule") return ruleTabs(caller, record);
  if (entityId === "accounting.entry_template") return templateTabs(record);
  return null;
}

/** The options of the selects of the master forms: the groups a node can hang from, the Fuentes a plantilla or regla posts to. */
export async function loadMasterOptions(caller: Caller, entityId: string, recordId: string | null): Promise<MasterOptions> {
  const deps = processDeps();
  const dimension = dimensionOf(entityId);
  if (dimension) {
    const table = DIMENSION_DEFS[dimension].table;
    const rows = await withClaims(deps.sql, caller.claims, (tx) =>
      tx<{ id: string; code: string; name: string }[]>`select id, code, name from ${tx(`accounting.v_${table}`)} where kind = 'group' and is_active and id is distinct from ${recordId} order by code`,
    );
    return { parents: rows.map((r) => ({ code: r.id, name: `${r.code} · ${r.name}` })) };
  }
  if (entityId === "accounting.entry_template" || entityId === "accounting.posting_rule") {
    const rows = await withClaims(deps.sql, caller.claims, (tx) => tx<{ id: string; code: string; name: string }[]>`select id, code, name from accounting.v_journals where is_active order by code`);
    return { journals: rows.map((r) => ({ code: r.id, name: `${r.code} · ${r.name}` })) };
  }
  return {};
}
