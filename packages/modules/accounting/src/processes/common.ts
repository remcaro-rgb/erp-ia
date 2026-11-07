import { countryPack, ProcessError, type AccountingPack, type PostingMode, type ProcessContext } from "@erp/kernel";
import { DIMENSION_DEFS, type Dimension } from "../dimensions";

// Helpers every accounting handler shares: the company's accounting pack, the company settings, typed refusals and the
// lookups the entry validation reuses (account by code, analytic dimension leaf).

/**
 * The states of a comprobante that is not final yet (entity types spec §5.1): it may still be edited, approved or posted. Posted and
 * voided are final. An account or node with lines in one of these cannot be deactivated (§4.1).
 */
export const OPEN_ENTRY_STATES = ["draft", "saved", "pending", "rejected", "approved"] as const;
/** The states the close checks count as "comprobantes sin terminar" that a person still holds: being written or sent back. */
export const UNFINISHED_ENTRY_STATES = ["draft", "saved", "rejected"] as const;
/** The states that wait on an approver (§5.12): sent to approval, or approved and about to post. */
export const AWAITING_APPROVAL_STATES = ["pending", "approved"] as const;

/** A typed refusal of the input: `details` are the messages the screens show (es-419). */
export const invalid = (message: string, detail: string): ProcessError => new ProcessError("invalid_input", message, { details: [detail] });

/** Refuses a caller who holds no system admin role in the active company (`kernel.is_company_admin()`). */
export async function requireAdmin(ctx: ProcessContext): Promise<void> {
  const [row] = await ctx.tx<{ admin: boolean }[]>`select kernel.is_company_admin() as admin`;
  if (!row?.admin) throw new ProcessError("forbidden", "only the company admin may run this process");
}

/** The accounting pack of the caller's active company (`kernel.companies.country_code`, rule 5). */
export async function companyPack(ctx: ProcessContext): Promise<AccountingPack> {
  const [company] = await ctx.tx<{ country_code: string }[]>`select country_code from kernel.companies where id = ${ctx.companyId}`;
  if (!company) throw new ProcessError("not_found", `company ${ctx.companyId} is not visible to the caller`);
  return countryPack(company.country_code).accounting;
}

/** Refuses the run with `invalid_input` when there is any error; `details` lists them. */
export function rejectErrors(processId: string, errors: readonly string[]): void {
  if (errors.length > 0) throw new ProcessError("invalid_input", `invalid input for ${processId}`, { details: [...errors] });
}

/** SQLSTATE of a unique violation (written as a number so it is not mistaken for an account code, rule 5). */
const UNIQUE_VIOLATION = String(23505);

/**
 * Runs a write and turns a violation of the unique constraint or index `constraint` into `invalid_input` with `detail`,
 * so a concurrent duplicate is refused like a sequential one.
 */
export async function refuseDuplicate<T>(processId: string, constraint: string, detail: string, write: () => Promise<T>): Promise<T> {
  try {
    return await write();
  } catch (error) {
    const pg = error as { code?: string; constraint_name?: string };
    if (pg.code === UNIQUE_VIOLATION && pg.constraint_name === constraint) {
      throw new ProcessError("invalid_input", `duplicate in ${processId}`, { details: [detail], cause: error });
    }
    throw error;
  }
}

/** Copies `input` without the keys whose value is undefined: what a partial update actually sets. */
export function defined<T extends Record<string, unknown>>(input: T): Partial<T> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)) as Partial<T>;
}

export interface AccountingSettings {
  id: string;
  ledgerStartsOn: string | null;
  roundingTolerance: number;
  manualJournalId: string | null;
  requireAttachmentOnManual: boolean;
  niifGroup: "1" | "2" | "3";
  requireApprovalOnManual: boolean;
  useOpenAuxiliaries: boolean;
  useItems: boolean;
  useBusinessUnits: boolean;
  /** Days without a matching event after which a rule with a `when` is flagged stale (Task 50.6). */
  ruleStaleDays: number;
  /** How the contabiliza documentos reach the ledger (plan 2B Task 33): inline strict (the default) or asynchronous. */
  postingMode: PostingMode;
}

/** The company's settings row, or null while the accounting has not been configured (`chart.seed` not run). */
export async function settingsOf(ctx: ProcessContext): Promise<AccountingSettings | null> {
  const [row] = await ctx.tx<
    {
      id: string; ledger_starts_on: string | null; rounding_tolerance: string; manual_journal_id: string | null;
      require_attachment_on_manual: boolean; niif_group: "1" | "2" | "3"; require_approval_on_manual: boolean;
      use_open_auxiliaries: boolean; use_items: boolean; use_business_units: boolean; rule_stale_days: number; posting_mode: PostingMode;
    }[]
  >`select id, ledger_starts_on::text, rounding_tolerance, manual_journal_id, require_attachment_on_manual, niif_group,
           require_approval_on_manual, use_open_auxiliaries, use_items, use_business_units, rule_stale_days, posting_mode
    from accounting.settings where company_id = ${ctx.companyId}`;
  if (!row) return null;
  return {
    id: row.id,
    ledgerStartsOn: row.ledger_starts_on,
    roundingTolerance: Number(row.rounding_tolerance),
    manualJournalId: row.manual_journal_id,
    requireAttachmentOnManual: row.require_attachment_on_manual,
    niifGroup: row.niif_group,
    requireApprovalOnManual: row.require_approval_on_manual,
    useOpenAuxiliaries: row.use_open_auxiliaries,
    useItems: row.use_items,
    useBusinessUnits: row.use_business_units,
    ruleStaleDays: row.rule_stale_days,
    postingMode: row.posting_mode,
  };
}

export interface AccountRow {
  id: string;
  code: string;
  name: string;
  level: string;
  nature: "debit" | "credit";
  allowsMovement: boolean;
  requiresParty: boolean;
  requiresInvoiceReady: boolean;
  requiresCostCenter: boolean;
  requiresOpenAuxiliary: boolean;
  requiresItem: boolean;
  requiresBusinessUnit: boolean;
  statementSection: string | null;
  isActive: boolean;
}

/** An account of the company by its code (read from the table: the validation of a write sees every account, restricted or not), or null. */
export async function accountByCode(ctx: ProcessContext, code: string): Promise<AccountRow | null> {
  const [row] = await ctx.tx<
    {
      id: string; code: string; name: string; level: string; nature: "debit" | "credit"; allows_movement: boolean; requires_party: boolean; requires_invoice_ready: boolean;
      requires_cost_center: boolean; requires_open_auxiliary: boolean; requires_item: boolean; requires_business_unit: boolean;
      statement_section: string | null; is_active: boolean;
    }[]
  >`select id, code, name, level, nature, allows_movement, requires_party, requires_invoice_ready, requires_cost_center, requires_open_auxiliary, requires_item,
           requires_business_unit, statement_section, is_active
    from accounting.accounts where company_id = ${ctx.companyId} and code = ${code} and deleted_at is null`;
  if (!row) return null;
  return {
    id: row.id, code: row.code, name: row.name, level: row.level, nature: row.nature, allowsMovement: row.allows_movement,
    requiresParty: row.requires_party, requiresInvoiceReady: row.requires_invoice_ready, requiresCostCenter: row.requires_cost_center, requiresOpenAuxiliary: row.requires_open_auxiliary,
    requiresItem: row.requires_item, requiresBusinessUnit: row.requires_business_unit, statementSection: row.statement_section, isActive: row.is_active,
  };
}

/**
 * A node of an analytic dimension that may receive lines: it exists in the company, is a leaf and is active. `inactive_dimension`
 * and "debe ser una hoja" are the refusals the entry validation and the posting provider surface (design §4.5, §5.5).
 */
export async function requireLeafDimension(ctx: ProcessContext, dimension: Dimension, id: string): Promise<void> {
  const def = DIMENSION_DEFS[dimension];
  const [node] = await ctx.tx<{ code: string; name: string; kind: string; is_active: boolean }[]>`
    select code, name, kind, is_active from ${ctx.tx(`accounting.${def.table}`)} where id = ${id} and company_id = ${ctx.companyId} and deleted_at is null`;
  if (!node) throw invalid(`${def.noun} ${id} not found`, `No existe el ${def.noun} indicado`);
  if (!node.is_active) throw invalid(`inactive_dimension: ${def.entity} ${node.code} is inactive`, `El ${def.noun} ${node.code} · ${node.name} está inactivo`);
  if (node.kind !== "leaf") throw invalid(`${def.entity} ${node.code} is a group`, `El ${def.noun} ${node.code} · ${node.name} debe ser una hoja, no un grupo`);
}
