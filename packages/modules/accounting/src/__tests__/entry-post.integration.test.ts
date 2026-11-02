import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { accountingHarness, newId, type AccountingHarness, markInvoiceReady } from "./helpers";

let h: AccountingHarness;
let ccLeaf: string;
let buLeaf: string;
let partyId: string;
let year: number;
beforeAll(async () => {
  h = await accountingHarness();
  await h.runStepUp(h.admin, "accounting.chart.seed", {});
  ccLeaf = (await h.sql<{ id: string }[]>`insert into accounting.cost_centers (company_id, code, name, kind) values (${h.companyId}, 'ADM', 'Administración', 'leaf') returning id`)[0]!.id;
  buLeaf = (await h.sql<{ id: string }[]>`insert into accounting.business_units (company_id, code, name, kind) values (${h.companyId}, 'CON', 'Consumo', 'leaf') returning id`)[0]!.id;
  partyId = (await h.sql<{ id: string }[]>`
    insert into core.parties (company_id, kind, person_type, document_type, document_number, legal_name, dian_status)
    values (${h.companyId}, '{customer}', '2', '13', '900111222', 'Cliente de prueba S.A.S.', 'errors') returning id`)[0]!.id;
  await markInvoiceReady(h, partyId, "2");
  year = (await h.sql<{ year: number }[]>`select year from accounting.fiscal_years where company_id = ${h.companyId}`)[0]!.year;
}, 180_000);
afterAll(async () => {
  await h.cleanup();
});

const dateIn = (month: number, day = 15) => `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
const draft = (lines: object[], extra: object = {}) => ({ date: dateIn(2), description: "Gasto de prueba", lines, ...extra });
const expense = (amount = 100, extra: object = {}) => [
  { accountCode: "510506", debit: amount, credit: 0, costCenterId: ccLeaf, ...extra },
  { accountCode: "111005", debit: 0, credit: amount },
];
const create = (caller: typeof h.contador | typeof h.auxiliar, lines: object[], extra: object = {}) =>
  h.run<{ id: string }>(caller, "accounting.entry.create", draft(lines, extra)).then((r) => r.id);
const entryRow = async (id: string) => (await h.sql`select * from accounting.entries where id = ${id}`)[0]!;
const refusal = (code: string) => ({ code: "invalid_input", message: expect.stringContaining(code) });

describe("entry post", () => {
  it("posts a balanced draft: NC-1, period set, lines carry the header business unit, event emitted; a second post is refused", async () => {
    const id = await create(h.contador, expense(), { businessUnitId: buLeaf });
    const out = await h.run<{ id: string; number: string }>(h.contador, "accounting.entry.post", { id });
    expect(out).toMatchObject({ id, number: "NC-1" });
    const row = await entryRow(id);
    expect(row).toMatchObject({ status: "posted", number: "NC-1", posted_by: h.contador.userId, total_debit: "100.0000" });
    expect(row.period_id).toBeTruthy();
    expect(row.posted_at).toBeTruthy();
    const [period] = await h.sql`select number from accounting.periods where id = ${row.period_id}`;
    expect(period!.number).toBe(2);
    const lines = await h.sql`select business_unit_id from accounting.entry_lines where entry_id = ${id}`;
    expect(lines.map((l) => l.business_unit_id)).toEqual([buLeaf, buLeaf]);
    const events = await h.sql`select payload from kernel.outbox where company_id = ${h.companyId} and event = 'accounting.entry.posted'`;
    expect(events.map((e) => e.payload)).toEqual([expect.objectContaining({ entryId: id, number: "NC-1" })]);
    await expect(h.run(h.contador, "accounting.entry.post", { id })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(h.run(h.contador, "accounting.entry.post", { id: newId() })).rejects.toMatchObject({ code: "not_found" });
    // The next entry takes the next consecutivo.
    const next = await h.run<{ number: string }>(h.contador, "accounting.entry.post", { id: await create(h.contador, expense(5)) });
    expect(next.number).toBe("NC-2");
  });

  it("post refuses: unbalanced above tolerance, 0.5 COP rounds to 530595, closed period, missing party on 130505, missing cost center on 510506, group dimension", async () => {
    // Above the tolerance of 1.00 COP.
    const unbalanced = await create(h.contador, [{ accountCode: "510506", debit: 105, credit: 0, costCenterId: ccLeaf }, { accountCode: "111005", debit: 0, credit: 100 }]);
    await expect(h.run(h.contador, "accounting.entry.post", { id: unbalanced })).rejects.toMatchObject(refusal("unbalanced"));
    expect(await entryRow(unbalanced)).toMatchObject({ status: "draft", number: null });

    // Half a peso: the difference is posted to the rounding account.
    const rounding = await create(h.contador, [{ accountCode: "510506", debit: 100.5, credit: 0, costCenterId: ccLeaf }, { accountCode: "111005", debit: 0, credit: 100 }]);
    await h.run(h.contador, "accounting.entry.post", { id: rounding });
    const lines = await h.sql`select a.code, l.debit, l.credit from accounting.entry_lines l join accounting.accounts a on a.id = l.account_id where l.entry_id = ${rounding} order by l.line_no`;
    expect(lines.map((l) => [l.code, l.debit, l.credit])).toEqual([["510506", "100.5000", "0.0000"], ["111005", "0.0000", "100.0000"], ["530595", "0.0000", "0.5000"]]);
    expect(await entryRow(rounding)).toMatchObject({ status: "posted", total_debit: "100.5000", total_credit: "100.5000" });

    // Missing party where the account requires one, missing cost center where it is required.
    const noParty = await create(h.contador, [{ accountCode: "130505", debit: 50, credit: 0 }, { accountCode: "111005", debit: 0, credit: 50 }]);
    await expect(h.run(h.contador, "accounting.entry.post", { id: noParty })).rejects.toMatchObject(refusal("missing_party"));
    const noCenter = await create(h.contador, [{ accountCode: "510506", debit: 50, credit: 0 }, { accountCode: "111005", debit: 0, credit: 50 }]);
    await expect(h.run(h.contador, "accounting.entry.post", { id: noCenter })).rejects.toMatchObject({ code: "invalid_input", message: expect.stringContaining("missing_cost_center"), details: [expect.stringContaining("510506")] });
    const okParty = await create(h.contador, [{ accountCode: "130505", debit: 50, credit: 0, partyId }, { accountCode: "111005", debit: 0, credit: 50 }]);
    await h.run(h.contador, "accounting.entry.post", { id: okParty });

    // A node turned into a group after the draft was saved.
    const grouped = await create(h.contador, expense(10));
    await h.sql`update accounting.cost_centers set kind = 'group' where id = ${ccLeaf}`;
    await expect(h.run(h.contador, "accounting.entry.post", { id: grouped })).rejects.toMatchObject(refusal("inactive_dimension"));
    await h.sql`update accounting.cost_centers set kind = 'leaf' where id = ${ccLeaf}`;

    // Closed period; a reopened one that admits only its day.
    const closed = await create(h.contador, expense(20), { date: dateIn(1, 10) });
    await h.sql`update accounting.periods set status = 'closed' where company_id = ${h.companyId} and number = 1`;
    await expect(h.run(h.contador, "accounting.entry.post", { id: closed })).rejects.toMatchObject(refusal("closed_period"));
    await h.sql`update accounting.periods set status = 'open', reopened_for = ${dateIn(1, 11)} where company_id = ${h.companyId} and number = 1`;
    await expect(h.run(h.contador, "accounting.entry.post", { id: closed })).rejects.toMatchObject(refusal("closed_period"));
    await h.sql`update accounting.periods set reopened_for = null where company_id = ${h.companyId} and number = 1`;
    await h.run(h.contador, "accounting.entry.post", { id: closed });
  });

  it("four-eyes: creator cannot post own pending entry (same_user_approval); another user can; a draft must be submitted first; automatic entries are exempt", async () => {
    await h.runStepUp(h.admin, "accounting.settings.update", { requireApprovalOnManual: true });
    try {
      const id = await create(h.auxiliar, expense(30));
      await expect(h.run(h.auxiliar, "accounting.entry.post", { id })).rejects.toMatchObject(refusal("pending_approval"));
      await h.run(h.auxiliar, "accounting.entry.submit", { id });
      expect(await entryRow(id)).toMatchObject({ status: "pending", submitted_by: h.auxiliar.userId });
      const submitted = await h.sql`select payload from kernel.outbox where company_id = ${h.companyId} and event = 'accounting.entry.submitted'`;
      expect(submitted.length).toBeGreaterThan(0);
      await expect(h.run(h.auxiliar, "accounting.entry.post", { id })).rejects.toMatchObject(refusal("same_user_approval"));
      expect(await entryRow(id)).toMatchObject({ status: "pending" });
      await h.run(h.contador, "accounting.entry.post", { id });
      expect(await entryRow(id)).toMatchObject({ status: "posted", posted_by: h.contador.userId, created_by: h.auxiliar.userId });

      // Devolver a borrador is its own process; update no longer takes a pending entry.
      const back = await create(h.auxiliar, expense(31));
      await h.run(h.auxiliar, "accounting.entry.submit", { id: back });
      await h.run(h.contador, "accounting.entry.return_to_draft", { id: back });
      expect(await entryRow(back)).toMatchObject({ status: "draft", submitted_by: null });

      // Submit is for drafts only.
      await expect(h.run(h.auxiliar, "accounting.entry.submit", { id })).rejects.toMatchObject({ code: "invalid_input" });

      // An automatic entry (origin auto) is not subject to the control: its creator may post it.
      const [journal] = await h.sql<{ id: string }[]>`select id from accounting.journals where company_id = ${h.companyId} and code = 'NC'`;
      const [auto] = await h.sql<{ id: string }[]>`insert into accounting.entries (company_id, journal_id, date, description, origin, created_by) values (${h.companyId}, ${journal!.id}, ${dateIn(2)}, 'Auto', 'auto', ${h.contador.userId}) returning id`;
      const [cash] = await h.sql<{ id: string }[]>`select id from accounting.accounts where company_id = ${h.companyId} and code = '111005'`;
      const [exp] = await h.sql<{ id: string }[]>`select id from accounting.accounts where company_id = ${h.companyId} and code = '510506'`;
      await h.sql`insert into accounting.entry_lines (company_id, entry_id, line_no, account_id, cost_center_id, debit, credit) values (${h.companyId}, ${auto!.id}, 1, ${exp!.id}, ${ccLeaf}, 9, 0), (${h.companyId}, ${auto!.id}, 2, ${cash!.id}, null, 0, 9)`;
      await h.run(h.contador, "accounting.entry.post", { id: auto!.id });
      expect(await entryRow(auto!.id)).toMatchObject({ status: "posted" });
    } finally {
      await h.runStepUp(h.admin, "accounting.settings.update", { requireApprovalOnManual: false });
    }
    // With the control off, submit is refused: there is nobody to approve.
    await expect(h.run(h.auxiliar, "accounting.entry.submit", { id: await create(h.auxiliar, expense(1)) })).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("reverse_on creates exactly one mirrored draft dated reverse_on, also when post is replayed; posting it marks the original reversed", async () => {
    const id = await create(h.contador, expense(80), { date: dateIn(3, 31), reverseOn: dateIn(4, 1) });
    await h.run(h.contador, "accounting.entry.post", { id });
    await expect(h.run(h.contador, "accounting.entry.post", { id })).rejects.toMatchObject({ code: "invalid_input" });
    const drafts = await h.sql`select id, status, date::text as date, origin, is_auto_reversal, reversal_of_id, journal_id from accounting.entries where reversal_of_id = ${id}`;
    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({ status: "draft", date: dateIn(4, 1), origin: "auto", is_auto_reversal: true, reversal_of_id: id });
    expect(await entryRow(id)).toMatchObject({ reversed_by_id: drafts[0]!.id, status: "posted" });
    const mirrored = await h.sql`select a.code, l.debit, l.credit, l.cost_center_id from accounting.entry_lines l join accounting.accounts a on a.id = l.account_id where l.entry_id = ${drafts[0]!.id} order by l.line_no`;
    expect(mirrored.map((l) => [l.code, l.debit, l.credit])).toEqual([["510506", "0.0000", "80.0000"], ["111005", "80.0000", "0.0000"]]);
    expect(mirrored[0]!.cost_center_id).toBe(ccLeaf);
    // The unique index keeps it at one even if a second mirrored draft were attempted.
    await expect(h.sql`insert into accounting.entries (company_id, journal_id, date, origin, is_auto_reversal, reversal_of_id) values (${h.companyId}, ${drafts[0]!.journal_id}, ${dateIn(4, 2)}, 'auto', true, ${id})`).rejects.toThrow();

    await h.run(h.contador, "accounting.entry.post", { id: drafts[0]!.id });
    expect(await entryRow(id)).toMatchObject({ status: "reversed" });
    expect(await entryRow(drafts[0]!.id as string)).toMatchObject({ status: "posted" });
    // A reverse_on that is not after the date is refused.
    await expect(h.run(h.contador, "accounting.entry.create", draft(expense(1), { reverseOn: dateIn(2) }))).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("entry.reverse mirrors lines, links both ways and dates in an open period; replay answers the same reversal; a reversal and a draft cannot be reversed", async () => {
    const id = await create(h.contador, [{ accountCode: "130505", debit: 60, credit: 0, partyId }, { accountCode: "111005", debit: 0, credit: 60 }]);
    await h.run(h.contador, "accounting.entry.post", { id });
    const out = await h.run<{ id: string; number: string }>(h.contador, "accounting.entry.reverse", { id, date: dateIn(5, 2), reason: "Error de digitación" });
    const reversal = await entryRow(out.id);
    expect(reversal).toMatchObject({ status: "posted", reversal_of_id: id, is_auto_reversal: false, origin: "auto", total_debit: "60.0000" });
    expect(reversal.date.toISOString().slice(0, 10)).toBe(dateIn(5, 2));
    expect(reversal.number).toBeTruthy();
    expect(await entryRow(id)).toMatchObject({ status: "reversed", reversed_by_id: out.id });
    const lines = await h.sql`select a.code, l.debit, l.credit, l.party_id from accounting.entry_lines l join accounting.accounts a on a.id = l.account_id where l.entry_id = ${out.id} order by l.line_no`;
    expect(lines.map((l) => [l.code, l.debit, l.credit, l.party_id])).toEqual([["130505", "0.0000", "60.0000", partyId], ["111005", "60.0000", "0.0000", null]]);
    const events = await h.sql`select payload from kernel.outbox where company_id = ${h.companyId} and event = 'accounting.entry.reversed'`;
    expect(events.map((e) => e.payload)).toEqual([expect.objectContaining({ entryId: id, reversalId: out.id })]);

    // Same key: the first answer, no second reversal.
    const again = await h.run<{ id: string }>(h.contador, "accounting.entry.reverse", { id, date: dateIn(5, 2), reason: "Error de digitación" });
    expect(again.id).toBe(out.id);
    expect(await h.sql`select 1 from accounting.entries where reversal_of_id = ${id}`).toHaveLength(1);

    await expect(h.run(h.contador, "accounting.entry.reverse", { id: out.id, reason: "x" })).rejects.toMatchObject({ code: "invalid_input" });
    const notPosted = await create(h.contador, expense(5));
    await expect(h.run(h.contador, "accounting.entry.reverse", { id: notPosted, reason: "x" })).rejects.toMatchObject({ code: "invalid_input" });
    // The reversal date must fall in an open period.
    const other = await create(h.contador, expense(7));
    await h.run(h.contador, "accounting.entry.post", { id: other });
    await h.sql`update accounting.periods set status = 'closed' where company_id = ${h.companyId} and number = 6`;
    await expect(h.run(h.contador, "accounting.entry.reverse", { id: other, date: dateIn(6, 1), reason: "x" })).rejects.toMatchObject(refusal("closed_period"));
    expect(await entryRow(other)).toMatchObject({ status: "posted" });
    await h.sql`update accounting.periods set status = 'open' where company_id = ${h.companyId} and number = 6`;
  });

  it("reversing an entry that has a pending auto-reversal voids that draft instead of reversing twice", async () => {
    const id = await create(h.contador, expense(11), { date: dateIn(7, 1), reverseOn: dateIn(8, 1) });
    await h.run(h.contador, "accounting.entry.post", { id });
    const [auto] = await h.sql<{ id: string }[]>`select id from accounting.entries where reversal_of_id = ${id}`;
    const out = await h.run<{ id: string }>(h.contador, "accounting.entry.reverse", { id, date: dateIn(7, 2), reason: "Antes" });
    expect(await entryRow(auto!.id)).toMatchObject({ status: "voided" });
    expect(await entryRow(id)).toMatchObject({ status: "reversed", reversed_by_id: out.id });
  });
  describe("return_to_draft", () => {
    const lineIds = async (id: string) => (await h.sql<{ id: string }[]>`select id from accounting.entry_lines where entry_id = ${id} order by line_no`).map((l) => l.id);
    const auditRows = (table: string, rowIds: string[]) =>
      h.sql`select id from kernel.audit_log where company_id = ${h.companyId} and entity = ${table} and row_id = any(${rowIds}::uuid[])`;

    const pending = async (lines: object[] = expense(40)) => {
      const id = await create(h.auxiliar, lines);
      await h.run(h.auxiliar, "accounting.entry.submit", { id });
      return id;
    };

    it("return_to_draft returns in place: same line ids, one audit row on the entry, none on the lines, reason kept", async () => {
      await h.runStepUp(h.admin, "accounting.settings.update", { requireApprovalOnManual: true });
      try {
        const id = await pending();
        const before = await lineIds(id);
        const entryAuditBefore = (await auditRows("accounting.entries", [id])).length;
        const lineAuditBefore = (await auditRows("accounting.entry_lines", before)).length;
        await expect(h.run(h.contador, "accounting.entry.return_to_draft", { id, reason: "Falta el soporte" })).resolves.toEqual({ id });
        expect(await lineIds(id)).toEqual(before);
        expect(await entryRow(id)).toMatchObject({ status: "draft", submitted_by: null, submitted_at: null, extra: { return_reason: "Falta el soporte" } });
        expect((await auditRows("accounting.entries", [id])).length - entryAuditBefore).toBe(1);
        expect((await auditRows("accounting.entry_lines", before)).length - lineAuditBefore).toBe(0);
        // The creator edits and resubmits.
        await h.run(h.auxiliar, "accounting.entry.submit", { id });
        expect(await entryRow(id)).toMatchObject({ status: "pending" });

        // Two returns at once leave one change: the second finds a draft.
        const results = await Promise.allSettled([
          h.run(h.contador, "accounting.entry.return_to_draft", { id }),
          h.run(h.contador, "accounting.entry.return_to_draft", { id }),
        ]);
        expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
        expect(results.find((r) => r.status === "rejected")).toMatchObject({ reason: { code: "invalid_input" } });
      } finally {
        await h.runStepUp(h.admin, "accounting.settings.update", { requireApprovalOnManual: false });
      }
    });

    it("return_to_draft works on an entry with a restricted line for an approver without view on it", async () => {
      await h.runStepUp(h.admin, "accounting.settings.update", { requireApprovalOnManual: true });
      const [acct] = await h.sql<{ id: string }[]>`select id from accounting.accounts where company_id = ${h.companyId} and code = '510506'`;
      try {
        const id = await pending(expense(41));
        await h.runStepUp(h.admin, "accounting.account_permission.update", { accountId: acct!.id, access: "restricted", grants: [] });
        const before = await lineIds(id);
        await expect(h.run(h.contador, "accounting.entry.return_to_draft", { id })).resolves.toEqual({ id });
        expect(await entryRow(id)).toMatchObject({ status: "draft" });
        expect(await lineIds(id)).toEqual(before);
        const [first] = await h.sql`select debit, account_id from accounting.entry_lines where entry_id = ${id} and line_no = 1`;
        expect(Number(first!.debit)).toBe(41);
        expect(first!.account_id).toBe(acct!.id);
      } finally {
        await h.runStepUp(h.admin, "accounting.account_permission.update", { accountId: acct!.id, access: "open", grants: [] });
        await h.runStepUp(h.admin, "accounting.settings.update", { requireApprovalOnManual: false });
      }
    });

    it("return_to_draft refuses a draft, a posted and a voided entry; entry.update refuses a pending entry", async () => {
      const refused = { code: "invalid_input", details: [expect.stringContaining("Solo un comprobante pendiente de aprobación vuelve a borrador")] };
      const draftId = await create(h.auxiliar, expense(5));
      await expect(h.run(h.contador, "accounting.entry.return_to_draft", { id: draftId })).rejects.toMatchObject(refused);
      const posted = await create(h.contador, expense(6));
      await h.run(h.contador, "accounting.entry.post", { id: posted });
      await expect(h.run(h.contador, "accounting.entry.return_to_draft", { id: posted })).rejects.toMatchObject(refused);
      const voided = await create(h.contador, expense(7));
      await h.run(h.contador, "accounting.entry.void", { id: voided, reason: "Prueba" });
      await expect(h.run(h.contador, "accounting.entry.return_to_draft", { id: voided })).rejects.toMatchObject(refused);
      await expect(h.run(h.contador, "accounting.entry.return_to_draft", { id: newId() })).rejects.toMatchObject({ code: "not_found" });

      await h.runStepUp(h.admin, "accounting.settings.update", { requireApprovalOnManual: true });
      try {
        const id = await pending();
        await expect(h.run(h.contador, "accounting.entry.update", { id, ...draft(expense(8)) })).rejects.toMatchObject({
          code: "invalid_input",
          details: [expect.stringContaining("Devuelve el comprobante a borrador antes de modificarlo")],
        });
        expect(await entryRow(id)).toMatchObject({ status: "pending" });
      } finally {
        await h.runStepUp(h.admin, "accounting.settings.update", { requireApprovalOnManual: false });
      }
    });
  });
});
