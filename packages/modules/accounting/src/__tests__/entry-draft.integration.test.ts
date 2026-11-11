import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { accountingHarness, newId, type AccountingHarness } from "./helpers";

let h: AccountingHarness;
let ccLeaf: string;
let ccInactive: string;
let ccGroup: string;
beforeAll(async () => {
  h = await accountingHarness({ companies: 2 });
  await h.runStepUp(h.admin, "accounting.chart.seed", {});
  const cc = async (code: string, kind: string, active: boolean) =>
    (await h.sql<{ id: string }[]>`insert into accounting.cost_centers (company_id, code, name, kind, is_active) values (${h.companyId}, ${code}, ${`CC ${code}`}, ${kind}, ${active}) returning id`)[0]!.id;
  ccLeaf = await cc("ADM", "leaf", true);
  ccInactive = await cc("OLD", "leaf", false);
  ccGroup = await cc("GRP", "group", true);
}, 180_000);
afterAll(async () => {
  await h.cleanup();
});

const accountId = async (code: string) => (await h.sql<{ id: string }[]>`select id from accounting.accounts where company_id = ${h.companyId} and code = ${code}`)[0]!.id;
const draft = (lines: object[], extra: object = {}) => ({ date: "2026-10-15", description: "Gasto de prueba", lines, ...extra });
const pair = (debitCode = "510506", extra: object = {}) => [
  { accountCode: debitCode, debit: 100, credit: 0, costCenterId: ccLeaf, ...extra },
  { accountCode: "111005", debit: 0, credit: 100 },
];
const entryRow = async (id: string) => (await h.sql`select * from accounting.entries where id = ${id}`)[0]!;

describe("entry-draft", () => {
  it("creates a draft in NC with two lines, no number, totals by trigger; update replaces lines; a draft is deleted, not voided; void keeps a Grabado row with status voided", async () => {
    const { id } = await h.run<{ id: string }>(h.contador, "accounting.entry.create", draft(pair()));
    const row = await entryRow(id);
    expect(row).toMatchObject({ status: "draft", origin: "manual", number: null, total_debit: "100.0000", total_credit: "100.0000" });
    const [nc] = await h.sql`select id from accounting.journals where company_id = ${h.companyId} and code = 'NC'`;
    expect(row.journal_id).toBe(nc!.id);
    const lines = await h.sql`select line_no, debit, credit, debit_doc from accounting.entry_lines where entry_id = ${id} order by line_no`;
    expect(lines).toEqual([
      { line_no: 1, debit: "100.0000", credit: "0.0000", debit_doc: "100.0000" },
      { line_no: 2, debit: "0.0000", credit: "100.0000", debit_doc: "0.0000" },
    ]);

    await h.run(h.contador, "accounting.entry.update", {
      id, ...draft([{ accountCode: "510506", debit: 250, credit: 0, costCenterId: ccLeaf }, { accountCode: "111005", debit: 0, credit: 250 }, { accountCode: "111005", debit: 5, credit: 0 }], { description: "Corregido" }),
    });
    expect(await entryRow(id)).toMatchObject({ description: "Corregido", total_debit: "255.0000", total_credit: "250.0000" });
    expect(await h.sql`select 1 from accounting.entry_lines where entry_id = ${id}`).toHaveLength(3);

    // Anular does not apply to a Borrador (D1): it is deleted with its lines.
    await expect(h.run(h.contador, "accounting.entry.void", { id, reason: "Duplicado" })).rejects.toMatchObject({ code: "invalid_state" });
    expect(await h.run(h.contador, "accounting.entry.delete", { id })).toMatchObject({ deleted: true });
    expect(await h.sql`select 1 from accounting.entry_lines where entry_id = ${id}`).toHaveLength(0);
    await expect(h.run(h.contador, "accounting.entry.update", { id, ...draft(pair()) })).rejects.toMatchObject({ code: "not_found" });

    // A Grabado comprobante (it waits for approval) is voided: the row stays, with its reason and no number.
    const waiting = (await h.run<{ id: string }>(h.contador, "accounting.entry.create", draft([{ accountCode: "510506", debit: 100, credit: 0, costCenterId: ccLeaf }, { accountCode: "111005", debit: 0, credit: 100 }]))).id;
    await h.sql`update accounting.entries set requires_approval = true where id = ${waiting}`;
    expect(await h.run(h.contador, "accounting.entry.save", { id: waiting })).toMatchObject({ status: "saved" });
    await h.run(h.contador, "accounting.entry.void", { id: waiting, reason: "Duplicado" });
    expect(await entryRow(waiting)).toMatchObject({ status: "voided", number: null, void_reason: "Duplicado" });
    await expect(h.run(h.contador, "accounting.entry.update", { id: waiting, ...draft(pair()) })).rejects.toMatchObject({ code: "invalid_state" });
  });

  it("accepts an empty draft, takes the manual journal and header business unit, and a pending entry is not approved (No Aprobar) before it is updated", async () => {
    const { id } = await h.run<{ id: string }>(h.contador, "accounting.entry.create", draft([]));
    expect(await entryRow(id)).toMatchObject({ status: "draft", total_debit: "0.0000" });
    await h.sql`update accounting.entries set status = 'pending', submitted_by = ${h.contador.userId}, submitted_at = now() where id = ${id}`;
    await expect(h.run(h.contador, "accounting.entry.update", { id, ...draft(pair()) })).rejects.toMatchObject({ code: "invalid_state" });
    await h.run(h.contador, "accounting.entry.reject", { id, reason: "Incompleto" });
    expect(await entryRow(id)).toMatchObject({ status: "rejected", submitted_by: h.contador.userId });
    await h.run(h.contador, "accounting.entry.update", { id, ...draft(pair()) });
    expect(await entryRow(id)).toMatchObject({ status: "rejected", total_debit: "100.0000" });
    await h.run(h.contador, "accounting.entry.void", { id, reason: "Prueba" });
    expect(await entryRow(id)).toMatchObject({ status: "voided", void_reason: "Prueba" });
  });

  it("refuses a line on a forbidden account by name, an inactive leaf, a group node, a journal without manual entries and a malformed line", async () => {
    await h.runStepUp(h.admin, "accounting.account_permission.update", {
      accountId: await accountId("5105"), access: "restricted", grants: [{ subjectKind: "role", subjectId: h.contador.roleId, canView: true, canPost: true }],
    });
    await expect(h.run(h.auxiliar, "accounting.entry.create", draft(pair("510506")))).rejects.toMatchObject({ code: "invalid_input", details: [expect.stringContaining("510506")] });
    await expect(h.run(h.auxiliar, "accounting.entry.create", draft(pair("510506")))).rejects.toThrow(/account_forbidden/);
    // The one who may post to it can.
    const ok = await h.run<{ id: string }>(h.contador, "accounting.entry.create", draft(pair("510506")));
    expect(ok.id).toBeTruthy();
    // The admin may override the restriction on the whole chart.
    await h.runStepUp(h.admin, "accounting.account_permission.update", { accountId: await accountId("5105"), access: "open", grants: [] });

    await expect(h.run(h.contador, "accounting.entry.create", draft(pair("510506", { costCenterId: ccInactive })))).rejects.toMatchObject({ code: "invalid_input", details: [expect.stringContaining("OLD")] });
    await expect(h.run(h.contador, "accounting.entry.create", draft(pair("510506", { costCenterId: ccGroup })))).rejects.toMatchObject({ code: "invalid_input", details: [expect.stringContaining("hoja")] });
    await expect(h.run(h.contador, "accounting.entry.create", draft(pair("510506", { costCenterId: newId() })))).rejects.toMatchObject({ code: "invalid_input" });

    const [ap] = await h.sql<{ id: string }[]>`select id from accounting.journals where company_id = ${h.companyId} and code = 'AP'`;
    await expect(h.run(h.contador, "accounting.entry.create", draft(pair(), { journalId: ap!.id }))).rejects.toMatchObject({ code: "invalid_input", details: [expect.stringContaining("AP")] });

    await expect(h.run(h.contador, "accounting.entry.create", draft([{ accountCode: "999999", debit: 1, credit: 0 }]))).rejects.toMatchObject({ code: "invalid_input", details: [expect.stringContaining("999999")] });
    // A class or group (no movement) account.
    await expect(h.run(h.contador, "accounting.entry.create", draft([{ accountCode: "5105", debit: 1, credit: 0 }]))).rejects.toMatchObject({ code: "invalid_input", details: [expect.stringContaining("5105")] });
    // Both sides or neither on one line, and no account at all.
    await expect(h.run(h.contador, "accounting.entry.create", draft([{ accountCode: "111005", debit: 1, credit: 1 }]))).rejects.toMatchObject({ code: "invalid_input" });
    await expect(h.run(h.contador, "accounting.entry.create", draft([{ accountCode: "111005", debit: 0, credit: 0 }]))).rejects.toMatchObject({ code: "invalid_input" });
    await expect(h.run(h.contador, "accounting.entry.create", draft([{ debit: 1, credit: 0 }]))).rejects.toMatchObject({ code: "invalid_input" });
    // A party that is not the company's.
    await expect(h.run(h.contador, "accounting.entry.create", draft(pair("510506", { partyId: newId() })))).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("consult returns the header and lines with a restricted line masked and the totals intact; entry_line.consult lists the lines", async () => {
    const { id } = await h.run<{ id: string }>(h.contador, "accounting.entry.create", draft(pair("510506")));
    await h.runStepUp(h.admin, "accounting.account_permission.update", {
      accountId: await accountId("5105"), access: "restricted", grants: [{ subjectKind: "role", subjectId: h.contador.roleId, canView: true, canPost: true }],
    });
    type Consult = { id: string; created_by: string | null; status: string; total_debit: string; lines: { line_no: number; account_code: string | null; debit: string | null; is_restricted: boolean }[] };
    const full = await h.run<Consult>(h.contador, "accounting.entry.consult", { id });
    expect(full.lines.map((l) => [l.line_no, l.account_code, l.is_restricted])).toEqual([[1, "510506", false], [2, "111005", false]]);
    const masked = await h.run<Consult>(h.auxiliar, "accounting.entry.consult", { id });
    expect(masked.lines.map((l) => [l.line_no, l.account_code, l.debit, l.is_restricted])).toEqual([[1, null, null, true], [2, "111005", "0.0000", false]]);
    expect(masked.total_debit).toBe("100.0000");
    // The creator rides along for the approval screen (four-eyes), though it is not a field of the entity.
    expect(masked).toMatchObject({ created_by: h.contador.userId });
    const lines = await h.run<{ lines: { line_no: number; is_restricted: boolean }[] }>(h.auxiliar, "accounting.entry_line.consult", { entryId: id });
    expect(lines.lines.map((l) => [l.line_no, l.is_restricted])).toEqual([[1, true], [2, false]]);
    await expect(h.run(h.contador, "accounting.entry.consult", { id: newId() })).rejects.toMatchObject({ code: "not_found" });
    await h.runStepUp(h.admin, "accounting.account_permission.update", { accountId: await accountId("5105"), access: "open", grants: [] });
  });

  it("a posted entry cannot be updated or voided, and the company of the caller owns the entry", async () => {
    const { id } = await h.run<{ id: string }>(h.contador, "accounting.entry.create", draft(pair()));
    await h.sql`update accounting.entries set status = 'posted', number = 'NC-9000' where id = ${id}`;
    await expect(h.run(h.contador, "accounting.entry.update", { id, ...draft(pair()) })).rejects.toMatchObject({ code: "invalid_state" });
    await expect(h.run(h.contador, "accounting.entry.void", { id, reason: "x" })).rejects.toMatchObject({ code: "invalid_state" });
    await expect(h.run(h.contador, "accounting.entry.void", { id: newId(), reason: "x" })).rejects.toMatchObject({ code: "not_found" });
  });
});
