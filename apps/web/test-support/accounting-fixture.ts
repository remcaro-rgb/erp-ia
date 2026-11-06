import type { Page } from "@playwright/test";
import { expect } from "./streamed";
import { totpCode, type AuthFixture } from "./auth-fixtures";

// What the accounting pages' end-to-end specs share (Task 29): a tenant entitled to the accounting module whose admin role may run the
// processes a spec names, a small hand-made chart (so a spec does not wait for the country's whole chart), the sign-in with the second
// step, the step-up code box, and the cleanup of every accounting row of the company.

export const REPORT_CONSULTS = [
  "trial_balance", "ledger", "balance_sheet", "income_statement", "cost_center_statement", "journal_book", "account_detail", "party_detail",
  "dimension_detail", "aging", "control_reconciliation", "manual_entries_audit", "exogena",
].map((name) => `accounting.report.${name}`);

/** Entitles the tenant to accounting and grants the admin role of the first company `processes`. */
export async function grantAccounting(fixture: AuthFixture, processes: readonly string[]): Promise<void> {
  const { sql } = fixture;
  const companyId = fixture.companyIds[0]!;
  // Accounting depends on core: both modules are the tenant's.
  for (const key of ["module:core", "module:accounting"]) await sql`insert into kernel.tenant_entitlements(tenant_id, key, source) values (${fixture.tenantId}, ${key}, 'manual')`;
  const [role] = await sql<{ id: string }[]>`select id from kernel.roles where company_id = ${companyId} and name = 'admin'`;
  for (const process of processes) await sql`insert into kernel.process_permissions(company_id, role_id, process_id) values (${companyId}, ${role!.id}, ${process})`;
}

export interface SmallLedger {
  accounts: Record<string, string>;
  journal: string;
  year: string;
  period: string;
}

/**
 * The company has run Configurar contabilidad, in small: settings, the NC Fuente, a short chart with a cost center on the sales account,
 * the fiscal year 2026 and its October period, and the closing roles mapped.
 */
export async function seedSmallLedger(fixture: AuthFixture): Promise<SmallLedger> {
  const { sql } = fixture;
  const companyId = fixture.companyIds[0]!;
  const [nc] = await sql<{ id: string }[]>`insert into accounting.journals (company_id, code, name, kind, manual_entries) values (${companyId}, 'NC', 'Notas contables', 'general', true) returning id`;
  await sql`insert into accounting.settings (company_id, manual_journal_id, ledger_starts_on) values (${companyId}, ${nc!.id}, '2026-01-01')`;
  const chart: [string, string, "debit" | "credit"][] = [
    ["1", "Activo", "debit"], ["11", "Efectivo y equivalentes", "debit"], ["1110", "Bancos", "debit"], ["111005", "Bancos nacionales", "debit"],
    ["3", "Patrimonio", "credit"], ["31", "Capital social", "credit"], ["3105", "Capital suscrito y pagado", "credit"], ["310505", "Capital autorizado", "credit"],
    ["36", "Resultados del ejercicio", "credit"], ["3605", "Utilidad del ejercicio", "credit"], ["360505", "Utilidad del ejercicio", "credit"],
    ["3610", "Pérdida del ejercicio", "debit"], ["361005", "Pérdida del ejercicio", "debit"],
    ["4", "Ingresos", "credit"], ["41", "Operacionales", "credit"], ["4135", "Comercio al por mayor y menor", "credit"], ["413595", "Otros", "credit"],
    ["5", "Gastos", "debit"], ["51", "Operacionales de administración", "debit"], ["5105", "Gastos de personal", "debit"], ["510506", "Sueldos", "debit"],
    ["59", "Ganancias y pérdidas", "credit"], ["5905", "Ganancias y pérdidas", "credit"], ["590505", "Ganancias y pérdidas", "credit"],
  ];
  const accounts: Record<string, string> = {};
  for (const [code, name, nature] of chart) {
    const section = code.startsWith("4") ? "revenue" : code.startsWith("5") && !code.startsWith("59") ? "operating_expenses" : null;
    const [row] = await sql<{ id: string }[]>`
      insert into accounting.accounts (company_id, code, name, nature, allows_movement, statement_section)
      values (${companyId}, ${code}, ${name}, ${nature}, ${code.length >= 6}, ${section}) returning id`;
    accounts[code] = row!.id;
  }
  const [year] = await sql<{ id: string }[]>`insert into accounting.fiscal_years (company_id, year, starts_on, ends_on) values (${companyId}, 2026, '2026-01-01', '2026-12-31') returning id`;
  const [period] = await sql<{ id: string }[]>`
    insert into accounting.periods (company_id, fiscal_year_id, number, starts_on, ends_on) values (${companyId}, ${year!.id}, 10, '2026-10-01', '2026-10-31') returning id`;
  for (const [role, code] of [["income_summary", "590505"], ["current_year_profit", "360505"], ["current_year_loss", "361005"]] as const) {
    await sql`insert into accounting.account_role_mappings (company_id, role, account_id) values (${companyId}, ${role}, ${accounts[code]!})`;
  }
  return { accounts, journal: nc!.id, year: year!.id, period: period!.id };
}

export interface YearLedger extends SmallLedger {
  /** The twelve periods of 2026, in order (index 0 is January; October is the one `seedSmallLedger` made). */
  periods: string[];
  closingJournal: string;
}

/**
 * `seedSmallLedger` plus periods 1–12 of 2026 (October reused), a `kind = 'closing'` Fuente CI "Cierre", and the role mapping already there.
 * Every period stays open: the spec posts first and closes them after.
 */
export async function seedYearLedger(fixture: AuthFixture): Promise<YearLedger> {
  const { sql } = fixture;
  const companyId = fixture.companyIds[0]!;
  const ledger = await seedSmallLedger(fixture);
  const [ci] = await sql<{ id: string }[]>`insert into accounting.journals (company_id, code, name, kind) values (${companyId}, 'CI', 'Cierre', 'closing') returning id`;
  const periods: string[] = [];
  for (let number = 1; number <= 12; number++) {
    if (number === 10) {
      periods.push(ledger.period);
      continue;
    }
    const start = new Date(Date.UTC(2026, number - 1, 1));
    const end = new Date(Date.UTC(2026, number, 0));
    const [row] = await sql<{ id: string }[]>`
      insert into accounting.periods (company_id, fiscal_year_id, number, starts_on, ends_on)
      values (${companyId}, ${ledger.year}, ${number}, ${start.toISOString().slice(0, 10)}, ${end.toISOString().slice(0, 10)}) returning id`;
    periods.push(row!.id);
  }
  return { ...ledger, periods, closingJournal: ci!.id };
}

/** A posted comprobante dated `date` in the open period: `debit` account against `credit` account; `partyId` is on the debit line. */
export async function postEntry(fixture: AuthFixture, ledger: SmallLedger, input: { date: string; debit: string; credit: string; amount: number; description?: string; partyId?: string }): Promise<string> {
  const { sql } = fixture;
  const companyId = fixture.companyIds[0]!;
  const [entry] = await sql<{ id: string }[]>`
    insert into accounting.entries (company_id, journal_id, date, period_id, status, origin, description)
    values (${companyId}, ${ledger.journal}, ${input.date}, ${ledger.period}, 'draft', 'manual', ${input.description ?? "Movimiento de prueba"})
    returning id`;
  await sql`insert into accounting.entry_lines (company_id, entry_id, line_no, account_id, party_id, debit, credit, debit_doc, credit_doc) values (${companyId}, ${entry!.id}, 1, ${ledger.accounts[input.debit]!}, ${input.partyId ?? null}, ${input.amount}, 0, ${input.amount}, 0)`;
  await sql`insert into accounting.entry_lines (company_id, entry_id, line_no, account_id, debit, credit, debit_doc, credit_doc) values (${companyId}, ${entry!.id}, 2, ${ledger.accounts[input.credit]!}, 0, ${input.amount}, 0, ${input.amount})`;
  // Lines can only be written while the comprobante is a draft: it is posted afterwards.
  await sql`
    update accounting.entries set status = 'posted', number = ${`NC-${input.date}-${Math.round(Math.random() * 1e6)}`}, total_debit = ${input.amount}, total_credit = ${input.amount}, posted_at = now()
    where id = ${entry!.id}`;
  return entry!.id;
}

const TABLES = [
  "skipped_events", "voided_sources", "period_close_checks", "posting_failures", "entry_template_lines", "entry_templates", "entry_lines", "entries", "posting_rules",
  "fiscal_concept_mappings", "account_permissions", "account_role_mappings", "settings", "periods", "fiscal_years", "journals", "cost_centers",
  "open_auxiliaries", "items", "business_units", "accounts",
];

/** Removes the accounting rows of the company (no triggers, no foreign key checks, so the order does not matter) and what the pages left. */
export async function cleanupAccounting(fixture: AuthFixture): Promise<void> {
  const { sql } = fixture;
  const companyId = fixture.companyIds[0]!;
  await sql.begin(async (tx) => {
    await tx`set local session_replication_role = replica`;
    for (const table of TABLES) await tx`delete from ${tx(`accounting.${table}`)} where company_id = ${companyId}`;
    for (const table of ["product_categories", "entity_sequences", "document_sequences"]) await tx`delete from ${tx(`core.${table}`)} where company_id = ${companyId}`;
  });
  await sql`delete from kernel.outbox where company_id = ${companyId}`;
  await sql`delete from kernel.step_up_verifications where company_id = ${companyId}`;
  await sql`delete from kernel.saved_views where company_id = ${companyId}`;
  await sql`delete from kernel.user_prefs where company_id = ${companyId}`;
  await sql`delete from kernel.process_permissions where company_id = ${companyId}`;
  await sql`delete from kernel.tenant_entitlements where tenant_id = ${fixture.tenantId}`;
}

/** Signs in with the second step, as the first run of a TOTP user does. */
export async function signInWithCode(page: Page, fixture: AuthFixture, secret: string): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("Correo").fill(fixture.email);
  await page.getByLabel("Contraseña", { exact: true }).fill(fixture.password);
  await page.getByRole("button", { name: "Entrar" }).click();
  await expect(page).toHaveURL(/\/mfa\/verify$/);
  await page.getByLabel("Dígito 1").fill(totpCode(secret));
  await expect(page).toHaveURL(/\/$/);
}

/** Answers the step-up prompt: the box has the caret and the 6th digit sends it. */
export async function confirmStepUp(page: Page, secret: string): Promise<void> {
  const code = page.getByLabel("Código de 6 dígitos");
  await expect(code).toBeFocused();
  await code.fill(totpCode(secret));
}
