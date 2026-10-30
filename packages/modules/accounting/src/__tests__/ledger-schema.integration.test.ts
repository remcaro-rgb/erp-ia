import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { accountingHarness, newId, type AccountingHarness } from "./helpers";

let h: AccountingHarness;
let journalId: string;
let accountA: string;
let accountB: string;
beforeAll(async () => {
  h = await accountingHarness();
  const [journal] = await h.sql<{ id: string }[]>`insert into accounting.journals (company_id, code, name, kind) values (${h.companyId}, 'NC', 'Notas de contabilidad', 'general') returning id`;
  journalId = journal!.id;
  const account = async (code: string) =>
    (await h.sql<{ id: string }[]>`insert into accounting.accounts (company_id, code, name, nature, level, allows_movement) values (${h.companyId}, ${code}, ${`Cuenta ${code}`}, 'debit', 'subaccount', true) returning id`)[0]!.id;
  accountA = await account("111005");
  accountB = await account("413505");
});
afterAll(async () => {
  await h.cleanup();
});

const newEntry = async (fields: { source_event_id?: string; posting_rule_id?: string } = {}) =>
  (await h.sql<{ id: string }[]>`
    insert into accounting.entries (company_id, journal_id, date, description, source_event_id, posting_rule_id)
    values (${h.companyId}, ${journalId}, '2026-10-15', 'Prueba', ${fields.source_event_id ?? null}, ${fields.posting_rule_id ?? null}) returning id`)[0]!.id;
const newLine = (entryId: string, lineNo: number, debit: number, credit: number) =>
  h.sql`insert into accounting.entry_lines (company_id, entry_id, line_no, account_id, debit, credit)
        values (${h.companyId}, ${entryId}, ${lineNo}, ${lineNo % 2 ? accountA : accountB}, ${debit}, ${credit})`;

describe("ledger-schema", () => {
  it("next_entry_number is gap-free under 20 concurrent calls on one journal", async () => {
    const numbers = await Promise.all(
      Array.from({ length: 20 }, () => h.sql.begin(async (tx) => (await tx<{ n: string }[]>`select accounting.next_entry_number(${journalId}) as n`)[0]!.n)),
    );
    expect(new Set(numbers).size).toBe(20);
    expect([...numbers].sort((a, b) => Number(a.slice(3)) - Number(b.slice(3)))).toEqual(Array.from({ length: 20 }, (_, i) => `NC-${i + 1}`));
    const [journal] = await h.sql<{ next_number: string }[]>`select next_number from accounting.journals where id = ${journalId}`;
    expect(journal!.next_number).toBe("21");
  });

  it("a rolled-back post returns its number, and the caller's company must own the journal", async () => {
    await expect(
      h.sql.begin(async (tx) => {
        await tx`select accounting.next_entry_number(${journalId})`;
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");
    const [journal] = await h.sql<{ next_number: string }[]>`select next_number from accounting.journals where id = ${journalId}`;
    expect(journal!.next_number).toBe("21");
    await expect(h.sql`select accounting.next_entry_number(${newId()})`).rejects.toThrow(/not found/);
  });

  it("a line with both sides or neither is refused; lines of a posted entry cannot change", async () => {
    const entry = await newEntry();
    await expect(newLine(entry, 1, 100, 100)).rejects.toThrow();
    await expect(newLine(entry, 1, 0, 0)).rejects.toThrow();
    await newLine(entry, 1, 100, 0);
    await newLine(entry, 2, 0, 100);
    await h.sql`update accounting.entries set status = 'posted', number = 'NC-100' where id = ${entry}`;
    await expect(newLine(entry, 3, 5, 0)).rejects.toThrow(/borrador/);
    await expect(h.sql`update accounting.entry_lines set debit = 7 where entry_id = ${entry} and line_no = 1`).rejects.toThrow(/borrador/);
    await expect(h.sql`delete from accounting.entry_lines where entry_id = ${entry}`).rejects.toThrow(/borrador/);
  });

  it("an entry that left draft must be balanced", async () => {
    const entry = await newEntry();
    await newLine(entry, 1, 100, 0);
    await expect(h.sql`update accounting.entries set status = 'posted' where id = ${entry}`).rejects.toThrow();
    await h.sql`update accounting.entries set status = 'voided' where id = ${entry}`;
  });

  it("entries.total_debit follows the lines; the unique index refuses a second entry for one (event, rule)", async () => {
    const entry = await newEntry();
    await newLine(entry, 1, 100, 0);
    await newLine(entry, 2, 0, 60);
    await newLine(entry, 3, 0, 40);
    const totals = async () => (await h.sql<{ total_debit: string; total_credit: string }[]>`select total_debit, total_credit from accounting.entries where id = ${entry}`)[0]!;
    expect(await totals()).toEqual({ total_debit: "100.0000", total_credit: "100.0000" });
    await h.sql`update accounting.entry_lines set credit = 30 where entry_id = ${entry} and line_no = 3`;
    expect(await totals()).toEqual({ total_debit: "100.0000", total_credit: "90.0000" });
    await h.sql`delete from accounting.entry_lines where entry_id = ${entry} and line_no = 3`;
    expect(await totals()).toEqual({ total_debit: "100.0000", total_credit: "60.0000" });

    const [rule] = await h.sql<{ id: string }[]>`insert into accounting.posting_rules (company_id, event, name, journal_id, template) values (${h.companyId}, 'probe.event', 'Prueba', ${journalId}, '{}'::jsonb) returning id`;
    const event = newId();
    await newEntry({ source_event_id: event, posting_rule_id: rule!.id });
    await expect(newEntry({ source_event_id: event, posting_rule_id: rule!.id })).rejects.toThrow(/entries_event_rule_key/);
    const [other] = await h.sql<{ id: string }[]>`insert into accounting.posting_rules (company_id, event, name, journal_id, template) values (${h.companyId}, 'probe.event', 'Otra', ${journalId}, '{}'::jsonb) returning id`;
    await newEntry({ source_event_id: event, posting_rule_id: other!.id });
  });

  it("an entry number is unique per journal", async () => {
    const a = await newEntry();
    const b = await newEntry();
    await h.sql`update accounting.entries set number = 'NC-9000' where id = ${a}`;
    await expect(h.sql`update accounting.entries set number = 'NC-9000' where id = ${b}`).rejects.toThrow(/entries_journal_number_key/);
  });

  it("period_close_checks refuses update and delete", async () => {
    const [year] = await h.sql<{ id: string }[]>`insert into accounting.fiscal_years (company_id, year, starts_on, ends_on) values (${h.companyId}, 2026, '2026-01-01', '2026-12-31') returning id`;
    const [period] = await h.sql<{ id: string }[]>`insert into accounting.periods (company_id, fiscal_year_id, number, starts_on, ends_on) values (${h.companyId}, ${year!.id}, 10, '2026-10-01', '2026-10-31') returning id`;
    const [check] = await h.sql<{ id: string }[]>`insert into accounting.period_close_checks (company_id, period_id, "check", value, passed) values (${h.companyId}, ${period!.id}, 'drafts', '{"drafts": 0}'::jsonb, true) returning id`;
    await expect(h.sql`update accounting.period_close_checks set passed = false where id = ${check!.id}`).rejects.toThrow(/append-only/);
    await expect(h.sql`delete from accounting.period_close_checks where id = ${check!.id}`).rejects.toThrow(/append-only/);
    await expect(h.sql`truncate accounting.period_close_checks`).rejects.toThrow(/append-only/);
    await expect(h.sql`insert into accounting.period_close_checks (company_id, period_id, "check", passed) values (${h.companyId}, ${period!.id}, 'nonsense', true)`).rejects.toThrow();
  });

  it("skipped_events counts an outbox event once", async () => {
    const outbox = newId();
    await h.sql`insert into accounting.skipped_events (company_id, outbox_id, event) values (${h.companyId}, ${outbox}, 'probe.event')`;
    await expect(h.sql`insert into accounting.skipped_events (company_id, outbox_id, event) values (${h.companyId}, ${outbox}, 'probe.event')`).rejects.toThrow();
  });
});
