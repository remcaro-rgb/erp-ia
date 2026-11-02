import { ProcessError, type PostingFailureCode, type ProcessContext } from "@erp/kernel";
import { DIMENSIONS, DIMENSION_DEFS, type Dimension } from "../dimensions";
import { requireLeafDimension, settingsOf, type AccountRow } from "./common";

// The line rules of design §5.5 and the account security of §5.13, shared by the draft processes (Task 18), `entry.post`
// (Task 19), the posting provider (Task 20) and the opening balances. `draft` checks what can be checked while a person
// is still typing; `post` adds everything a ledger entry must satisfy.

export type RefusalCode = PostingFailureCode | "account_forbidden" | "same_user_approval" | "manual_journal_only";

/** One reason a comprobante cannot be saved or posted, in Spanish, naming the account or node. */
export interface Refusal {
  code: RefusalCode;
  lineNo?: number;
  detail: string;
}

export type EntryOrigin = "manual" | "auto" | "import" | "template";

/** The header facts the line rules need. */
export interface EntryHeader {
  journalId: string;
  /** `YYYY-MM-DD`. */
  date: string;
  businessUnitId?: string | null;
  origin: EntryOrigin;
  /** The year-close entries: dated in a period that is already closed and posted to the summary accounts without analytic dimensions (§5.7). */
  isClosing?: boolean;
}

/** A line as the processes receive it: the account by id or by code. Amounts are in company currency. */
export interface LineInput {
  accountId?: string | undefined;
  accountCode?: string | undefined;
  partyId?: string | null | undefined;
  costCenterId?: string | null | undefined;
  openAuxiliaryId?: string | null | undefined;
  itemId?: string | null | undefined;
  businessUnitId?: string | null | undefined;
  description?: string | null | undefined;
  debit: number;
  credit: number;
  /** Document-currency amounts when the source states them (the posting engine); else derived from the exchange rate. */
  debitDoc?: number | undefined;
  creditDoc?: number | undefined;
  taxCode?: string | null | undefined;
  taxRate?: number | null | undefined;
  taxBase?: number | null | undefined;
  reference?: string | null | undefined;
  dueDate?: string | null | undefined;
}

export interface LoadedAccount extends AccountRow {
  /** `accounting.can_post_account` for the caller. */
  canPost: boolean;
}

/** The accounts the lines name, by id and by code, with the caller's right to post to each (read from the table: a write sees every account). */
export async function loadAccounts(ctx: ProcessContext, lines: readonly LineInput[]): Promise<{ byId: Map<string, LoadedAccount>; byCode: Map<string, LoadedAccount> }> {
  const ids = [...new Set(lines.map((l) => l.accountId).filter((v): v is string => !!v))];
  const codes = [...new Set(lines.map((l) => l.accountCode).filter((v): v is string => !!v))];
  const byId = new Map<string, LoadedAccount>();
  const byCode = new Map<string, LoadedAccount>();
  if (ids.length + codes.length === 0) return { byId, byCode };
  const rows = await ctx.tx<
    {
      id: string; code: string; name: string; level: string; nature: "debit" | "credit"; allows_movement: boolean; requires_party: boolean; requires_invoice_ready: boolean;
      requires_cost_center: boolean; requires_open_auxiliary: boolean; requires_item: boolean; requires_business_unit: boolean;
      statement_section: string | null; is_active: boolean; can_post: boolean;
    }[]
  >`select id, code, name, level, nature, allows_movement, requires_party, requires_invoice_ready, requires_cost_center, requires_open_auxiliary, requires_item,
           requires_business_unit, statement_section, is_active, accounting.can_post_account(id) as can_post
    from accounting.accounts
    where company_id = ${ctx.companyId} and (id = any(${ids}::uuid[]) or code = any(${codes}::text[]))`;
  for (const row of rows) {
    const account: LoadedAccount = {
      id: row.id, code: row.code, name: row.name, level: row.level, nature: row.nature, allowsMovement: row.allows_movement,
      requiresParty: row.requires_party, requiresInvoiceReady: row.requires_invoice_ready, requiresCostCenter: row.requires_cost_center, requiresOpenAuxiliary: row.requires_open_auxiliary,
      requiresItem: row.requires_item, requiresBusinessUnit: row.requires_business_unit, statementSection: row.statement_section,
      isActive: row.is_active, canPost: row.can_post,
    };
    byId.set(account.id, account);
    byCode.set(account.code, account);
  }
  return { byId, byCode };
}

/** The account a line names, or undefined when the id or code is not the company's. */
export function accountOf(accounts: Awaited<ReturnType<typeof loadAccounts>>, line: LineInput): LoadedAccount | undefined {
  return line.accountId ? accounts.byId.get(line.accountId) : line.accountCode ? accounts.byCode.get(line.accountCode) : undefined;
}

const MISSING_CODE: Record<Dimension, RefusalCode> = {
  cost_center: "missing_cost_center",
  open_auxiliary: "missing_open_auxiliary",
  item: "missing_item",
  business_unit: "missing_business_unit",
};

const REQUIRES: Record<Dimension, "requiresCostCenter" | "requiresOpenAuxiliary" | "requiresItem" | "requiresBusinessUnit"> = {
  cost_center: "requiresCostCenter",
  open_auxiliary: "requiresOpenAuxiliary",
  item: "requiresItem",
  business_unit: "requiresBusinessUnit",
};

const LINE_COLUMN: Record<Dimension, keyof LineInput> = {
  cost_center: "costCenterId",
  open_auxiliary: "openAuxiliaryId",
  item: "itemId",
  business_unit: "businessUnitId",
};

const money = (value: number) => new Intl.NumberFormat("es-CO", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value);
const labelOf = (account: AccountRow) => `${account.code} · ${account.name}`;

/** Message of the refusal a dimension check raised (the detail the screens show). */
async function dimensionProblem(ctx: ProcessContext, dimension: Dimension, id: string): Promise<string | null> {
  try {
    await requireLeafDimension(ctx, dimension, id);
    return null;
  } catch (error) {
    if (error instanceof ProcessError && Array.isArray(error.details) && typeof error.details[0] === "string") return error.details[0];
    throw error;
  }
}

/**
 * Checks a comprobante's lines against the rules of §5.5 and §5.13. Returns every refusal, never throws for a rule.
 * `draft`: the accounts exist and take movement, the caller may post to each (the engine, origin `event` or `opts.engine`, is exempt),
 * the party and dimension nodes exist and are active leaves, the Fuente takes the entry. `post` adds: active accounts, the
 * party and each dimension where the account requires it, two lines, a balance within the rounding tolerance and an open period.
 */
export async function validateLines(
  ctx: ProcessContext,
  header: EntryHeader,
  lines: readonly LineInput[],
  mode: "draft" | "post",
  opts: { engine?: boolean } = {},
): Promise<Refusal[]> {
  const refusals: Refusal[] = [];
  const add = (code: RefusalCode, detail: string, lineNo?: number) => refusals.push(lineNo === undefined ? { code, detail } : { code, detail, lineNo });

  const [journal] = await ctx.tx<{ code: string; name: string; is_active: boolean; manual_entries: boolean }[]>`
    select code, name, is_active, manual_entries from accounting.journals where id = ${header.journalId} and company_id = ${ctx.companyId}`;
  if (!journal) add("no_journal", "La fuente indicada no existe");
  else {
    if (!journal.is_active) add("no_journal", `La fuente ${journal.code} · ${journal.name} está inactiva`);
    if (!journal.manual_entries && (header.origin === "manual" || header.origin === "template")) {
      add("manual_journal_only", `La fuente ${journal.code} · ${journal.name} no admite comprobantes manuales`);
    }
  }

  if (header.businessUnitId) {
    const problem = await dimensionProblem(ctx, "business_unit", header.businessUnitId);
    if (problem) add("inactive_dimension", problem);
  }

  const accounts = await loadAccounts(ctx, lines);
  const checked = new Map<string, string | null>();
  const dimensionOf = async (dimension: Dimension, id: string) => {
    const key = `${dimension}:${id}`;
    if (!checked.has(key)) checked.set(key, await dimensionProblem(ctx, dimension, id));
    return checked.get(key)!;
  };
  const partyIds = [...new Set(lines.map((l) => l.partyId).filter((v): v is string => !!v))];
  const knownParties = new Set(
    partyIds.length === 0 ? [] : (await ctx.tx<{ id: string }[]>`select id from core.v_parties where company_id = ${ctx.companyId} and id = any(${partyIds}::uuid[])`).map((r) => r.id),
  );
  // Rule 10: a party on an account flagged requires_invoice_ready must be invoice-ready. The flag is read unmasked from
  // core.v_party_readiness (core.v_parties masks it by field visibility), only for the parties those lines name.
  const gatedParties = [...new Set(lines.filter((l) => l.partyId && accountOf(accounts, l)?.requiresInvoiceReady).map((l) => l.partyId!))];
  const readiness = new Map<string, boolean>(
    gatedParties.length === 0
      ? []
      : (await ctx.tx<{ id: string; invoice_ready: boolean }[]>`select id, invoice_ready from core.v_party_readiness where company_id = ${ctx.companyId} and id = any(${gatedParties}::uuid[])`).map((r) => [r.id, r.invoice_ready]),
  );

  let debit = 0;
  let credit = 0;
  for (const [index, line] of lines.entries()) {
    const lineNo = index + 1;
    debit += line.debit;
    credit += line.credit;
    const account = accountOf(accounts, line);
    if (!account) {
      add("inactive_account", `La cuenta ${line.accountCode ?? line.accountId ?? ""} no existe en el plan de cuentas`, lineNo);
      continue;
    }
    if (!account.allowsMovement) add("inactive_account", `La cuenta ${labelOf(account)} no recibe movimientos: usa una cuenta de último nivel`, lineNo);
    if (mode === "post" && !account.isActive) add("inactive_account", `La cuenta ${labelOf(account)} está inactiva`, lineNo);
    if (ctx.origin !== "event" && !opts.engine && !account.canPost) {
      add("account_forbidden", `No tienes permiso para contabilizar en la cuenta ${labelOf(account)}`, lineNo);
    }
    if (line.partyId && !knownParties.has(line.partyId)) add("missing_party", `El tercero de la cuenta ${account.code} no existe o no es visible`, lineNo);
    else if (line.partyId && account.requiresInvoiceReady && readiness.get(line.partyId) === false) {
      add("missing_party", `El tercero de la cuenta ${account.code} no está listo para facturar: revisa sus datos DIAN y sus archivos requeridos`, lineNo);
    }
    if (mode === "post" && account.requiresParty && !line.partyId) add("missing_party", `La cuenta ${labelOf(account)} exige tercero`, lineNo);

    for (const dimension of DIMENSIONS) {
      const def = DIMENSION_DEFS[dimension];
      const own = line[LINE_COLUMN[dimension]] as string | null | undefined;
      // The business unit of the header is the default of its lines (§4.5).
      const effective = own ?? (dimension === "business_unit" ? header.businessUnitId : null);
      if (effective) {
        const problem = await dimensionOf(dimension, effective);
        if (problem) add("inactive_dimension", problem, lineNo);
      } else if (mode === "post" && !header.isClosing && account[REQUIRES[dimension]]) {
        add(MISSING_CODE[dimension], `La cuenta ${labelOf(account)} exige ${def.noun}`, lineNo);
      }
    }
  }

  if (mode === "post") {
    if (lines.length < 2) add("unbalanced", "Un comprobante lleva al menos dos líneas");
    const settings = await settingsOf(ctx);
    const tolerance = settings?.roundingTolerance ?? 0;
    const difference = Math.round(Math.abs(debit - credit) * 10_000) / 10_000;
    if (difference > tolerance) {
      add("unbalanced", `El comprobante no cuadra: débitos $ ${money(debit)}, créditos $ ${money(credit)}, diferencia $ ${money(difference)}`);
    }
    const [period] = await ctx.tx<{ status: string; reopened_for: string | null; starts_on: string }[]>`
      select status, reopened_for::text, starts_on::text from accounting.periods
      where company_id = ${ctx.companyId} and ${header.date}::date between starts_on and ends_on`;
    if (!period) add("closed_period", `No hay un período contable para la fecha ${header.date}`);
    else if (period.status === "closed" && !header.isClosing) add("closed_period", `El período de ${header.date} está cerrado`);
    else if (period.reopened_for && period.reopened_for !== header.date && !header.isClosing) {
      add("closed_period", `El período fue reabierto solo para el ${period.reopened_for}: la fecha ${header.date} está cerrada`);
    }
  }
  return refusals;
}

/** Throws the first refusal as `invalid_input`: the message leads with its code (the engine records it as the failure code), `details` list every refusal. */
export function assertValid(refusals: readonly Refusal[]): void {
  const first = refusals[0];
  if (!first) return;
  throw new ProcessError("invalid_input", `${first.code}: ${first.detail}`, {
    details: refusals.map((r) => (r.lineNo === undefined ? r.detail : `Línea ${r.lineNo}: ${r.detail}`)),
  });
}
