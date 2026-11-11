import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildConsumerContext, consumers } from "@erp/kernel";
import { accountingHarness, newId, type AccountingHarness } from "./helpers";

// Comprobantes on the typed-entity lifecycle (entity types spec 2026-11-02 §5, §8, D2, D3, D8, D9, §10.2; Phase 2A.5 Task 8b,
// migration 0043). A comprobante is a documento that posts itself: Grabar posts it in the same run when it needs no approval;
// with Requiere aprobación (require_approval_on_manual for manual entries) it goes Grabado → Pendiente de Aprobación → Aprobado →
// Contabilizado; No Aprobar (reason required) replaces Devolver a borrador. A refusal at posting rolls the whole action back.

let h: AccountingHarness;
let ccLeaf: string;
let year: number;
beforeAll(async () => {
  h = await accountingHarness();
  await h.runStepUp(h.admin, "accounting.chart.seed", {});
  ccLeaf = (await h.sql<{ id: string }[]>`insert into accounting.cost_centers (company_id, code, name, kind) values (${h.companyId}, 'ADM', 'Administración', 'leaf') returning id`)[0]!.id;
  year = (await h.sql<{ year: number }[]>`select year from accounting.fiscal_years where company_id = ${h.companyId}`)[0]!.year;
}, 180_000);
afterAll(async () => {
  await h.sql`delete from kernel.entity_type_settings where company_id = ${h.companyId}`;
  await h.sql`delete from kernel.attachments where company_id = ${h.companyId}`;
  await h.cleanup();
});

const dateIn = (month: number, day = 15) => `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
const expense = (amount = 100) => [
  { accountCode: "510506", debit: amount, credit: 0, costCenterId: ccLeaf },
  { accountCode: "111005", debit: 0, credit: amount },
];
const create = (caller: typeof h.contador, amount = 100, extra: object = {}) =>
  h.run<{ id: string }>(caller, "accounting.entry.create", { date: dateIn(2), description: "Gasto de prueba", lines: expense(amount), ...extra }).then((r) => r.id);
const row = async (id: string) => (await h.sql`select * from accounting.entries where id = ${id}`)[0]!;
const snapshots = async (id: string) =>
  (await h.sql<{ status: string; reason: string | null; payload: { lines: { debit: string; line_no: number }[] } }[]>`
    select status, reason, payload from kernel.record_snapshots where entity = 'accounting.entry' and record_id = ${id} order by seq`);
/** Lines in their line number order: the comparison never depends on the snapshot's own order. */
const byLine = <T extends { line_no: number }>(lines: T[]) => [...lines].sort((a, b) => a.line_no - b.line_no);
const outbox = async (event: string, id: string) =>
  h.sql<{ id: string; event: string; payload: Record<string, unknown> }[]>`
    select id, event, payload from kernel.outbox where company_id = ${h.companyId} and event = ${event} and (payload->>'id' = ${id} or payload->>'entryId' = ${id}) order by created_at`;
const nextNumber = async (code = "NC") => (await h.sql<{ next_number: number }[]>`select next_number from accounting.journals where company_id = ${h.companyId} and code = ${code}`)[0]!.next_number;
const approvalOnManual = (on: boolean) => h.runStepUp(h.admin, "accounting.settings.update", { requireApprovalOnManual: on });

describe("comprobantes on the typed lifecycle", () => {
  it("without approval, Grabar takes a draft to Contabilizado in one run: numbered, saved and posted snapshots, one ready_to_post event", async () => {
    const id = await create(h.contador);
    expect(await row(id)).toMatchObject({ status: "draft", requires_approval: false, posts: true, number: null });
    const out = await h.run<{ id: string; status: string; number?: string }>(h.contador, "accounting.entry.save", { id });
    expect(out).toMatchObject({ id, status: "posted", number: expect.stringMatching(/^NC-\d+$/) });
    expect(await row(id)).toMatchObject({ status: "posted", number: out.number, posted_by: h.contador.userId });
    expect((await snapshots(id)).map((s) => s.status)).toEqual(["saved", "posted"]);
    expect(await outbox("accounting.entry.ready_to_post", id)).toHaveLength(1);
    expect(await outbox("accounting.entry.posted", id)).toHaveLength(1);
    // Contabilizado is final for the lifecycle: Grabar, Anular and Eliminar are refused (a posted comprobante is reversed).
    for (const [verb, input] of [["save", { id }], ["void", { id, reason: "x" }], ["delete", { id }]] as const) {
      await expect(h.run(h.contador, `accounting.entry.${verb}`, input)).rejects.toMatchObject({ code: "invalid_state" });
    }
  });

  it("the old processes are gone: entry.post and entry.return_to_draft are no longer registered (D2)", () => {
    const ids = h.deps.registry.processes({ module: "accounting" }).map((p) => p.id);
    expect(ids).not.toContain("accounting.entry.post");
    expect(ids).not.toContain("accounting.entry.return_to_draft");
    for (const verb of ["save", "submit", "approve", "reject", "void", "delete"]) expect(ids).toContain(`accounting.entry.${verb}`);
  });

  it("with approval: draft → Grabado → Pendiente de Aprobación → Aprobado → Contabilizado, numbered only when Aprobar posts it", async () => {
    await approvalOnManual(true);
    try {
      const id = await create(h.auxiliar);
      expect(await row(id)).toMatchObject({ status: "draft", requires_approval: true, posts: true });
      const before = await nextNumber();
      expect(await h.run(h.auxiliar, "accounting.entry.save", { id })).toMatchObject({ status: "saved" });
      expect(await row(id)).toMatchObject({ status: "saved", number: null });
      expect(await nextNumber()).toBe(before);
      await h.run(h.auxiliar, "accounting.entry.submit", { id });
      expect(await row(id)).toMatchObject({ status: "pending", submitted_by: h.auxiliar.userId });
      expect(await outbox("accounting.entry.submitted", id)).toHaveLength(1);
      const out = await h.run<{ status: string; number?: string }>(h.contador, "accounting.entry.approve", { id });
      expect(out).toMatchObject({ status: "posted", number: `NC-${before}` });
      expect(await row(id)).toMatchObject({ status: "posted", posted_by: h.contador.userId, created_by: h.auxiliar.userId });
      expect((await snapshots(id)).map((s) => s.status)).toEqual(["saved", "pending", "approved", "posted"]);
    } finally {
      await approvalOnManual(false);
    }
  });

  it("No Aprobar needs a reason → No Aprobado; the creator edits (a snapshot of the new lines), Grabar → Grabado, and sends it again", async () => {
    await approvalOnManual(true);
    try {
      const id = await create(h.auxiliar, 40);
      await h.run(h.auxiliar, "accounting.entry.save", { id });
      await h.run(h.auxiliar, "accounting.entry.submit", { id });
      await expect(h.run(h.contador, "accounting.entry.reject", { id })).rejects.toMatchObject({ code: "invalid_input" });
      await expect(h.run(h.contador, "accounting.entry.reject", { id, reason: "  " })).rejects.toMatchObject({ code: "invalid_input" });
      expect(await h.run(h.contador, "accounting.entry.reject", { id, reason: "Falta el soporte" })).toMatchObject({ status: "rejected" });
      // One status change on the header (OD-1); who sent it last stays until the next Enviar a aprobación.
      expect(await row(id)).toMatchObject({ status: "rejected", submitted_by: h.auxiliar.userId });
      expect((await snapshots(id)).at(-1)).toMatchObject({ status: "rejected", reason: "Falta el soporte" });
      // Pendiente refuses edits (D3); No Aprobado takes them through the lines process, which snapshots the change.
      await h.run(h.auxiliar, "accounting.entry.update", { id, date: dateIn(2), description: "Gasto corregido", lines: expense(45) });
      expect(await row(id)).toMatchObject({ status: "rejected", description: "Gasto corregido", total_debit: "45.0000" });
      const afterEdit = await snapshots(id);
      expect(afterEdit.at(-1)).toMatchObject({ status: "rejected" });
      expect(byLine(afterEdit.at(-1)!.payload.lines).map((l) => Number(l.debit))).toEqual([45, 0]);
      expect(await h.run(h.auxiliar, "accounting.entry.save", { id })).toMatchObject({ status: "saved" });
      await h.run(h.auxiliar, "accounting.entry.submit", { id });
      expect(await row(id)).toMatchObject({ status: "pending", total_debit: "45.0000" });
      await expect(h.run(h.auxiliar, "accounting.entry.update", { id, date: dateIn(2), description: "Otra", lines: expense(46) })).rejects.toMatchObject({ code: "invalid_state" });
    } finally {
      await approvalOnManual(false);
    }
  });

  it("an edit of a Grabado comprobante writes exactly one snapshot with the new lines and keeps the state (spec §8)", async () => {
    await approvalOnManual(true);
    try {
      const id = await create(h.auxiliar, 50);
      await h.run(h.auxiliar, "accounting.entry.save", { id });
      const before = (await snapshots(id)).length;
      await h.run(h.auxiliar, "accounting.entry.update", { id, date: dateIn(2), description: "Gasto de prueba", lines: expense(55) });
      const after = await snapshots(id);
      expect(after).toHaveLength(before + 1);
      expect(after.at(-1)).toMatchObject({ status: "saved" });
      expect(byLine(after.at(-1)!.payload.lines).map((l) => Number(l.debit))).toEqual([55, 0]);
      expect(await row(id)).toMatchObject({ status: "saved", total_debit: "55.0000" });
      // A draft's edits write none (§8: only once past Borrador).
      const fresh = await create(h.auxiliar, 5);
      await h.run(h.auxiliar, "accounting.entry.update", { id: fresh, date: dateIn(2), description: "Borrador", lines: expense(6) });
      expect(await snapshots(fresh)).toHaveLength(0);
    } finally {
      await approvalOnManual(false);
    }
  });

  it("four-eyes is optional and off by default: approval from Parámetros lets the creator approve; require_approval_on_manual adds the second person", async () => {
    // Approval required through the kernel setting only (Parámetros): the generic lifecycle has no four-eyes.
    await h.sql`insert into kernel.entity_type_settings (company_id, entity, requires_approval) values (${h.companyId}, 'accounting.entry', true)
                on conflict (company_id, entity) do update set requires_approval = true`;
    try {
      const own = await create(h.auxiliar, 7);
      expect(await row(own)).toMatchObject({ requires_approval: true });
      await h.run(h.auxiliar, "accounting.entry.save", { id: own });
      await h.run(h.auxiliar, "accounting.entry.submit", { id: own });
      expect(await h.run(h.auxiliar, "accounting.entry.approve", { id: own })).toMatchObject({ status: "posted" });
    } finally {
      await h.sql`delete from kernel.entity_type_settings where company_id = ${h.companyId} and entity = 'accounting.entry'`;
    }
    // The accounting control (require_approval_on_manual) refuses the creator's own approval and keeps it pending.
    await approvalOnManual(true);
    try {
      const id = await create(h.auxiliar, 8);
      await h.run(h.auxiliar, "accounting.entry.save", { id });
      await h.run(h.auxiliar, "accounting.entry.submit", { id });
      await expect(h.run(h.auxiliar, "accounting.entry.approve", { id })).rejects.toMatchObject({ code: "invalid_input", message: expect.stringContaining("same_user_approval") });
      expect(await row(id)).toMatchObject({ status: "pending", number: null });
      expect(await h.run(h.contador, "accounting.entry.approve", { id })).toMatchObject({ status: "posted" });
    } finally {
      await approvalOnManual(false);
    }
  });

  it("requires_approval is written by the create process from require_approval_on_manual (not left to the trigger); automatic entries never need it", async () => {
    // The kernel setting says no approval, the accounting setting says manual entries need it: the explicit value wins.
    await h.sql`insert into kernel.entity_type_settings (company_id, entity, requires_approval) values (${h.companyId}, 'accounting.entry', false)
                on conflict (company_id, entity) do update set requires_approval = false`;
    await approvalOnManual(true);
    try {
      const manual = await create(h.contador, 9);
      expect(await row(manual)).toMatchObject({ requires_approval: true, posts: true, origin: "manual" });
      const [template] = await h.sql<{ id: string }[]>`
        insert into accounting.entry_templates (company_id, name, journal_id) select ${h.companyId}, 'Arriendo', id from accounting.journals where company_id = ${h.companyId} and code = 'NC' returning id`;
      const [exp] = await h.sql<{ id: string }[]>`select id from accounting.accounts where company_id = ${h.companyId} and code = '510506'`;
      const [cash] = await h.sql<{ id: string }[]>`select id from accounting.accounts where company_id = ${h.companyId} and code = '111005'`;
      await h.sql`insert into accounting.entry_template_lines (company_id, template_id, line_no, account_id, cost_center_id, side, amount)
                  values (${h.companyId}, ${template!.id}, 1, ${exp!.id}, ${ccLeaf}, 'debit', 10), (${h.companyId}, ${template!.id}, 2, ${cash!.id}, null, 'credit', 10)`;
      const fromTemplate = await h.run<{ id: string }>(h.contador, "accounting.entry.from_template", { templateId: template!.id, date: dateIn(2) });
      expect(await row(fromTemplate.id)).toMatchObject({ requires_approval: true, origin: "template" });
    } finally {
      await approvalOnManual(false);
      await h.sql`delete from kernel.entity_type_settings where company_id = ${h.companyId} and entity = 'accounting.entry'`;
    }
    expect(await row(await create(h.contador, 3))).toMatchObject({ requires_approval: false });
  });

  it("a refusal at posting rolls the whole action back: Grabar on a closed period stays Borrador, Aprobar stays Pendiente; no number, snapshot or event", async () => {
    const closed = await create(h.contador, 12, { date: dateIn(1, 10) });
    await h.sql`update accounting.periods set status = 'closed' where company_id = ${h.companyId} and number = 1`;
    try {
      const before = await nextNumber();
      const stamp = (await row(closed)).updated_at;
      await expect(h.run(h.contador, "accounting.entry.save", { id: closed, data: { description: "Editado" } })).rejects.toMatchObject({ code: "invalid_input", message: expect.stringContaining("closed_period") });
      expect(await row(closed)).toMatchObject({ status: "draft", number: null, description: "Gasto de prueba", updated_at: stamp });
      expect(await nextNumber()).toBe(before);
      expect(await snapshots(closed)).toHaveLength(0);
      expect(await outbox("accounting.entry.ready_to_post", closed)).toHaveLength(0);

      // Aprobar: the period closes while the comprobante waits for approval.
      await h.sql`update accounting.periods set status = 'open' where company_id = ${h.companyId} and number = 1`;
      await approvalOnManual(true);
      const waiting = await create(h.auxiliar, 13, { date: dateIn(1, 11) });
      await h.run(h.auxiliar, "accounting.entry.save", { id: waiting });
      await h.run(h.auxiliar, "accounting.entry.submit", { id: waiting });
      await h.sql`update accounting.periods set status = 'closed' where company_id = ${h.companyId} and number = 1`;
      const taken = (await snapshots(waiting)).length;
      await expect(h.run(h.contador, "accounting.entry.approve", { id: waiting })).rejects.toMatchObject({ code: "invalid_input", message: expect.stringContaining("closed_period") });
      expect(await row(waiting)).toMatchObject({ status: "pending", number: null });
      expect(await snapshots(waiting)).toHaveLength(taken);
      expect(await nextNumber()).toBe(before);
      await h.sql`update accounting.periods set status = 'open' where company_id = ${h.companyId} and number = 1`;
      expect(await h.run(h.contador, "accounting.entry.approve", { id: waiting })).toMatchObject({ status: "posted", number: `NC-${before}` });
    } finally {
      await h.sql`update accounting.periods set status = 'open' where company_id = ${h.companyId} and number = 1`;
      await approvalOnManual(false);
    }
  });

  it("the posting engine's catch-all consumer ignores accounting.entry.ready_to_post, even with a rule on it: a comprobante is never posted twice", async () => {
    await h.sql`update accounting.settings set ledger_starts_on = ${`${year}-01-01`} where company_id = ${h.companyId}`;
    const [journal] = await h.sql<{ id: string }[]>`select id from accounting.journals where company_id = ${h.companyId} and code = 'NC'`;
    await h.sql`insert into accounting.posting_rules (company_id, event, name, journal_id, template) values (${h.companyId}, 'accounting.entry.ready_to_post', 'Trampa', ${journal!.id}, ${h.sql.json({ lines: [] })})`;
    const id = await create(h.contador, 14);
    await h.run(h.contador, "accounting.entry.save", { id });
    const [event] = await outbox("accounting.entry.ready_to_post", id);
    const entries = async () => (await h.sql`select count(*)::int as n from accounting.entries where company_id = ${h.companyId}`)[0]!.n;
    const failures = async () => (await h.sql`select count(*)::int as n from accounting.posting_failures where company_id = ${h.companyId}`)[0]!.n;
    const skipped = async () => (await h.sql`select count(*)::int as n from accounting.skipped_events where company_id = ${h.companyId}`)[0]!.n;
    const before = { entries: await entries(), failures: await failures(), skipped: await skipped(), number: await nextNumber() };
    const [outboxRow] = await h.sql<{ created_at: Date; chain_id: string }[]>`select created_at, chain_id from kernel.outbox where id = ${event!.id}`;
    const ctx = buildConsumerContext(h.sql, { id: event!.id, event: event!.event, createdAt: outboxRow!.created_at, companyId: h.companyId, chainId: outboxRow!.chain_id }, h.deps.registry);
    const consumer = consumers.for(event!.event).find((c) => c.moduleId === "accounting");
    await consumer!.fn(ctx, event!.payload);
    expect({ entries: await entries(), failures: await failures(), skipped: await skipped(), number: await nextNumber() }).toEqual(before);
    expect(await row(id)).toMatchObject({ status: "posted" });
    await h.sql`delete from accounting.posting_rules where company_id = ${h.companyId} and event = 'accounting.entry.ready_to_post'`;
  });

  it("Eliminar removes a Borrador with its lines, but not an automatic reversal nor one with files; Anular takes Grabado / Pendiente, not a Borrador", async () => {
    const id = await create(h.contador, 15);
    expect(await h.run(h.contador, "accounting.entry.delete", { id })).toMatchObject({ deleted: true });
    expect(await h.sql`select 1 from accounting.entries where id = ${id}`).toHaveLength(0);
    expect(await h.sql`select 1 from accounting.entry_lines where entry_id = ${id}`).toHaveLength(0);
    await expect(h.run(h.contador, "accounting.entry.delete", { id: newId() })).rejects.toMatchObject({ code: "not_found" });

    // The automatic reversal of an accrual is part of the original's chain (§5.12): it cannot be deleted.
    const accrual = await create(h.contador, 16, { date: dateIn(3, 31), reverseOn: dateIn(4, 1) });
    await h.run(h.contador, "accounting.entry.save", { id: accrual });
    const [auto] = await h.sql<{ id: string }[]>`select id from accounting.entries where reversal_of_id = ${accrual} and is_auto_reversal`;
    await expect(h.run(h.contador, "accounting.entry.delete", { id: auto!.id })).rejects.toMatchObject({ code: "invalid_input" });
    expect(await row(auto!.id)).toMatchObject({ status: "draft" });
    // Grabar posts it and marks the accrual reversed (it stays Contabilizado, with the mark).
    expect(await h.run(h.contador, "accounting.entry.save", { id: auto!.id })).toMatchObject({ status: "posted" });
    expect(await row(accrual)).toMatchObject({ status: "posted", reversed_by_id: auto!.id, extra: expect.objectContaining({ reversed: true }) });

    // A draft that holds files keeps them in the audit: remove the files first.
    const withFile = await create(h.contador, 17);
    await h.sql`insert into kernel.attachments (company_id, entity, record_id, tag, file_name, mime_type, size_bytes, storage_path)
                values (${h.companyId}, 'accounting.entry', ${withFile}, 'Soporte', 'soporte.pdf', 'application/pdf', 10, ${`${h.seed.tenantId}/${h.companyId}/accounting.entry/${withFile}/soporte.pdf`})`;
    await expect(h.run(h.contador, "accounting.entry.delete", { id: withFile })).rejects.toMatchObject({ code: "invalid_input" });
    expect(await row(withFile)).toMatchObject({ status: "draft" });

    // Anular: a Borrador is deleted, not voided; a Grabado or a Pendiente is voided with its reason.
    await expect(h.run(h.contador, "accounting.entry.void", { id: withFile, reason: "x" })).rejects.toMatchObject({ code: "invalid_state" });
    await approvalOnManual(true);
    try {
      const saved = await create(h.auxiliar, 18);
      await h.run(h.auxiliar, "accounting.entry.save", { id: saved });
      await expect(h.run(h.auxiliar, "accounting.entry.delete", { id: saved })).rejects.toMatchObject({ code: "invalid_state" });
      expect(await h.run(h.auxiliar, "accounting.entry.void", { id: saved, reason: "Duplicado" })).toMatchObject({ status: "voided" });
      expect(await row(saved)).toMatchObject({ status: "voided", void_reason: "Duplicado" });
      expect((await snapshots(saved)).at(-1)).toMatchObject({ status: "voided", reason: "Duplicado" });
    } finally {
      await approvalOnManual(false);
    }
  });

  it("the generic Grabar writes only the header fields of the update process; derived and system columns are refused", async () => {
    const id = await create(h.contador, 19);
    for (const data of [{ number: "NC-999" }, { total_debit: 1 }, { origin: "auto" }, { period_id: newId() }, { posted_by: h.contador.userId }, { is_opening: true }, { reversal_of_id: newId() }, { description: "ok", source_entity: "x" }]) {
      await expect(h.run(h.contador, "accounting.entry.save", { id, data }), JSON.stringify(data)).rejects.toMatchObject({ code: "invalid_input" });
    }
    expect(await row(id)).toMatchObject({ status: "draft", description: "Gasto de prueba" });
    // A reverse_on on or before the date is refused as by entry.update.
    await expect(h.run(h.contador, "accounting.entry.save", { id, data: { reverse_on: dateIn(2) } })).rejects.toMatchObject({ code: "invalid_input" });
    const out = await h.run<{ status: string }>(h.contador, "accounting.entry.save", { id, data: { description: "Gasto grabado" } });
    expect(out.status).toBe("posted");
    expect(await row(id)).toMatchObject({ status: "posted", description: "Gasto grabado" });
  });

  it("saldos iniciales are posted only by opening.post (step-up): the generic Grabar refuses an opening draft", async () => {
    const opening = await h.run<{ id: string }>(h.contador, "accounting.opening.create", {
      date: dateIn(1, 2), lines: [{ accountCode: "111005", debit: 20, credit: 0 }, { accountCode: "310505", debit: 0, credit: 20 }],
    });
    expect(await row(opening.id)).toMatchObject({ status: "draft", is_opening: true, requires_approval: false });
    await expect(h.run(h.contador, "accounting.entry.save", { id: opening.id })).rejects.toMatchObject({ code: "invalid_input" });
    expect(await row(opening.id)).toMatchObject({ status: "draft" });
  });

  it("entry.reverse keeps the original Contabilizado with the reversal mark (D2) and refuses a second reversal", async () => {
    const id = await create(h.contador, 21);
    await h.run(h.contador, "accounting.entry.save", { id });
    const out = await h.run<{ id: string }>(h.contador, "accounting.entry.reverse", { id, date: dateIn(2, 20), reason: "Error" });
    expect(await row(id)).toMatchObject({ status: "posted", reversed_by_id: out.id, extra: expect.objectContaining({ reversed: true }) });
    expect(await row(out.id)).toMatchObject({ status: "posted", reversal_of_id: id });
    // A second request is the idempotent replay (key reverse:<id>): the same reversal, no second one.
    expect(await h.run<{ id: string }>(h.contador, "accounting.entry.reverse", { id, date: dateIn(2, 21), reason: "Otra vez" })).toMatchObject({ id: out.id });
    expect(await h.sql`select 1 from accounting.entries where reversal_of_id = ${id}`).toHaveLength(1);
    // Without the replay (its key gone), the mark itself refuses: the original stays Contabilizado but is already reversed.
    await h.sql`delete from kernel.process_idempotency where company_id = ${h.companyId} and process_id = 'accounting.entry.reverse' and key = ${`reverse:${id}`}`;
    await expect(h.run(h.contador, "accounting.entry.reverse", { id, date: dateIn(2, 21), reason: "Otra vez" })).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("the data migration (0043) maps the old states without producing Grabado: draft, pending, posted (reversed → posted), voided", async () => {
    const mapped = await h.sql<{ from: string; to: string }[]>`
      select s as from, accounting.legacy_entry_status(s) as to from unnest(array['draft', 'pending', 'posted', 'reversed', 'voided']) s`;
    expect(Object.fromEntries(mapped.map((m) => [m.from, m.to]))).toEqual({ draft: "draft", pending: "pending", posted: "posted", reversed: "posted", voided: "voided" });
    // Nothing unexpected: an unknown value fails instead of becoming Grabado.
    await expect(h.sql`select accounting.legacy_entry_status('saved')`).rejects.toThrow();
    const [check] = await h.sql<{ def: string }[]>`select pg_get_constraintdef(oid) as def from pg_constraint where conrelid = 'accounting.entries'::regclass and conname = 'entries_status_check'`;
    for (const state of ["draft", "saved", "pending", "rejected", "approved", "posted", "voided"]) expect(check!.def).toContain(`'${state}'`);
    expect(check!.def).not.toContain("'reversed'");
    const [posts] = await h.sql<{ column_default: string | null }[]>`select column_default from information_schema.columns where table_schema = 'accounting' and table_name = 'entries' and column_name = 'posts'`;
    expect(posts!.column_default).toBe("true");
  });

  it("0043 carries grants and step-up on the removed ids forward: post → save + approve, return_to_draft → reject, void → void + delete", async () => {
    const [role] = await h.sql<{ id: string }[]>`insert into kernel.roles (company_id, name) values (${h.companyId}, ${`legacy-${newId().slice(0, 8)}`}) returning id`;
    try {
      for (const process of ["accounting.entry.post", "accounting.entry.return_to_draft", "accounting.entry.void"]) {
        await h.sql`insert into kernel.process_permissions (company_id, role_id, process_id) values (${h.companyId}, ${role!.id}, ${process})`;
      }
      await h.sql`insert into kernel.sensitive_processes (company_id, process_id, mode) values (${h.companyId}, 'accounting.entry.return_to_draft', 'self_2fa') on conflict do nothing`;
      await h.sql`select accounting.migrate_entry_process_ids()`;
      const held = await h.sql<{ process_id: string }[]>`select process_id from kernel.process_permissions where role_id = ${role!.id} order by process_id`;
      expect(held.map((r) => r.process_id)).toEqual(["accounting.entry.approve", "accounting.entry.delete", "accounting.entry.reject", "accounting.entry.save", "accounting.entry.void"]);
      const raised = await h.sql<{ process_id: string; mode: string }[]>`
        select process_id, mode from kernel.sensitive_processes where company_id = ${h.companyId} and process_id in ('accounting.entry.reject', 'accounting.entry.return_to_draft')`;
      expect(raised).toEqual([{ process_id: "accounting.entry.reject", mode: "self_2fa" }]);
      // Idempotent: a second run changes nothing.
      await h.sql`select accounting.migrate_entry_process_ids()`;
      expect(await h.sql`select 1 from kernel.process_permissions where role_id = ${role!.id}`).toHaveLength(5);
    } finally {
      await h.sql`delete from kernel.sensitive_processes where company_id = ${h.companyId} and process_id in ('accounting.entry.reject', 'accounting.entry.return_to_draft')`;
      await h.sql`delete from kernel.roles where id = ${role!.id}`;
    }
  });
});
