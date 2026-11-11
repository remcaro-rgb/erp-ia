import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { crm } from "../index";
import { crmHarness, good, newId, prospect, salesPipeline, type CrmHarness } from "./helpers";

// Pipelines, oportunidades, activities and the two consumers (plan 2B Task 11).

describe("crm pipelines, opportunities and activities", () => {
  let h: CrmHarness;
  let pipeline: { id: string; stages: { id: string; lineNo: number; name: string }[] };
  let partyId: string;

  beforeAll(async () => {
    h = await crmHarness();
    pipeline = await h.run(h.admin, "crm.pipeline.create", salesPipeline());
    const lead = await h.run<{ id: string }>(h.admin, "crm.lead.create", prospect("Cliente de prueba", { documentNumber: "860002964" }));
    ({ partyId } = await h.run<{ partyId: string }>(h.admin, "crm.lead.convert", { id: lead.id, pipelineId: pipeline.id }));
  });
  afterAll(async () => {
    await h.cleanup();
  });

  const stage = (name: string) => pipeline.stages.find((s) => s.name === name)!.id;
  const newDeal = async (caller = h.admin, overrides: Record<string, unknown> = {}) =>
    h.run<{ id: string; number: string; stageId: string }>(caller, "crm.opportunity.create", { title: "Venta de café", partyId, pipelineId: pipeline.id, amount: 2000000, ...overrides });

  it("creates the embudo with its etapas in order; the first one becomes the default", async () => {
    expect(pipeline.stages.map((s) => s.name)).toEqual(["Nuevo", "Propuesta", "Ganada", "Perdida"]);
    const [row] = await h.sql`select is_default, status from crm.pipelines where id = ${pipeline.id}`;
    expect(row).toEqual({ is_default: true, status: "saved" });
    const kinds = await h.sql`select name, kind, probability from crm.stages where pipeline_id = ${pipeline.id} order by line_no`;
    expect(kinds.map((k) => [k.kind, Number(k.probability)])).toEqual([["open", 10], ["open", 60], ["won", 100], ["lost", 0]]);
  });

  it("refuses an unsound embudo: no winning etapa, open after closing, repeated names, duplicate code", async () => {
    const base = salesPipeline("MAL");
    await expect(h.run(h.admin, "crm.pipeline.create", { ...base, stages: base.stages.filter((s) => s.kind !== "won").concat({ name: "Extra", probability: 20, kind: "open" }) })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(h.run(h.admin, "crm.pipeline.create", { ...base, stages: [base.stages[0], base.stages[2], base.stages[1], base.stages[3]] })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(h.run(h.admin, "crm.pipeline.create", { ...base, stages: [base.stages[0], { ...base.stages[1], name: "nuevo" }, base.stages[2], base.stages[3]] })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(h.run(h.admin, "crm.pipeline.create", salesPipeline("ventas"))).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("updates an embudo: renames, reorders, adds an etapa and refuses to drop one with deals", async () => {
    const other = await h.run<{ id: string; stages: { id: string; name: string }[] }>(h.admin, "crm.pipeline.create", salesPipeline("OTRO"));
    await h.run(h.admin, "crm.pipeline.update", {
      id: other.id,
      name: "Otro embudo",
      stages: [
        { id: other.stages[1]!.id, name: "Cotizado", probability: 50, kind: "open" },
        { id: other.stages[0]!.id, name: "Nuevo", probability: 10, kind: "open" },
        { name: "Negociación", probability: 80, kind: "open" },
        { id: other.stages[2]!.id, name: "Ganada", probability: 100, kind: "won" },
        { id: other.stages[3]!.id, name: "Perdida", probability: 0, kind: "lost" },
      ],
    });
    const rows = await h.sql`select name from crm.stages where pipeline_id = ${other.id} order by line_no`;
    expect(rows.map((r) => r.name)).toEqual(["Cotizado", "Nuevo", "Negociación", "Ganada", "Perdida"]);
    const deal = await h.run<{ id: string }>(h.admin, "crm.opportunity.create", { title: "En otro", partyId, pipelineId: other.id });
    const drop = await h.run(h.admin, "crm.pipeline.update", {
      id: other.id,
      stages: [{ id: other.stages[0]!.id, name: "Nuevo", probability: 10, kind: "open" }, { id: other.stages[2]!.id, name: "Ganada", probability: 100, kind: "won" }, { id: other.stages[3]!.id, name: "Perdida", probability: 0, kind: "lost" }],
    }).catch((e: unknown) => e);
    // The deal sits in the first etapa (Cotizado): it cannot be dropped.
    expect(drop).toMatchObject({ code: "invalid_input" });
    expect((await h.sql`select stage_id from crm.opportunities where id = ${deal.id}`)[0]!.stage_id).toBe(other.stages[1]!.id);
  });

  it("creates an oportunidad numbered OP- in the first open etapa, owned by the caller", async () => {
    const a = await newDeal(h.vendedor);
    const b = await newDeal(h.vendedor);
    expect(a.number).toMatch(/^OP-\d+$/);
    expect(Number(b.number.slice(3))).toBe(Number(a.number.slice(3)) + 1);
    const [row] = await h.sql`select stage_id, probability, outcome, owner_id, status, posts, requires_approval from crm.opportunities where id = ${a.id}`;
    expect(row).toMatchObject({ stage_id: stage("Nuevo"), outcome: "open", status: "saved", posts: false, requires_approval: false });
    expect(Number(row!.probability)).toBe(10);
    expect(row!.owner_id).toBe(h.vendedor.claims.sub);
    await expect(h.run(h.admin, "crm.opportunity.create", { title: "Sin nadie" })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(newDeal(h.admin, { stageId: stage("Ganada") })).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("keeps the lines the deal is about, sums them into the amount and freezes them once saved", async () => {
    const product = await h.run<{ id: string }>(h.admin, "core.product.create", good("CAFE-250"));
    const deal = await h.run<{ id: string }>(h.vendedor, "crm.opportunity.create", {
      title: "Con líneas", partyId, pipelineId: pipeline.id,
      lines: [{ productId: product.id, qty: 10, unitPrice: 28500 }, { description: "Capacitación de barismo", qty: 1, unitPrice: 400000 }],
    });
    const lines = await h.sql`select line_no, product_id, description, qty, unit_price from crm.opportunity_lines where opportunity_id = ${deal.id} order by line_no`;
    expect(lines.map((l) => [l.line_no, l.product_id, l.description, Number(l.qty), Number(l.unit_price)])).toEqual([[1, product.id, null, 10, 28500], [2, null, "Capacitación de barismo", 1, 400000]]);
    expect(Number((await h.sql`select amount from crm.opportunities where id = ${deal.id}`)[0]!.amount)).toBe(685000);
    await expect(h.sql`update crm.opportunity_lines set qty = 99 where opportunity_id = ${deal.id}`).rejects.toThrow(/no cambian/);
    await expect(h.run(h.vendedor, "crm.opportunity.create", { title: "Producto ajeno", partyId, lines: [{ productId: newId(), qty: 1 }] })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(h.run(h.vendedor, "crm.opportunity.create", { title: "Línea vacía", partyId, lines: [{ qty: 1 }] })).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("stage_move is audited with the etapa before and after, emits its event and is idempotent", async () => {
    const deal = await newDeal(h.vendedor);
    const moved = await h.run<{ changed: boolean; outcome: string }>(h.vendedor, "crm.opportunity.stage_move", { id: deal.id, stageId: stage("Propuesta") });
    expect(moved).toMatchObject({ changed: true, outcome: "open" });
    const [audit] = await h.sql`
      select diff, process_id, origin, actor_user_id from kernel.audit_log
      where entity = 'crm.opportunities' and row_id = ${deal.id} and action = 'update' and process_id = 'crm.opportunity.stage_move'`;
    expect(audit!.diff).toMatchObject({ stage_id: { old: stage("Nuevo"), new: stage("Propuesta") } });
    expect(Number((audit!.diff as { probability: { old: string; new: string } }).probability.new)).toBe(60);
    expect(audit).toMatchObject({ origin: "ui", actor_user_id: h.vendedor.claims.sub });
    const [event] = await h.sql`select payload from kernel.outbox where event = 'crm.opportunity.stage_moved' and payload->>'opportunityId' = ${deal.id}`;
    expect(event!.payload).toMatchObject({ fromStageId: stage("Nuevo"), toStageId: stage("Propuesta"), outcome: "open" });

    // The same etapa again writes nothing.
    const again = await h.run<{ changed: boolean }>(h.vendedor, "crm.opportunity.stage_move", { id: deal.id, stageId: stage("Propuesta") });
    expect(again.changed).toBe(false);
    expect((await h.sql`select 1 from kernel.audit_log where entity = 'crm.opportunities' and row_id = ${deal.id} and process_id = 'crm.opportunity.stage_move'`).length).toBe(1);
  });

  it("closing as lost asks the reason; a closed deal does not move; an etapa of another embudo is refused", async () => {
    const deal = await newDeal(h.admin);
    const noReason = await h.run(h.admin, "crm.opportunity.stage_move", { id: deal.id, stageId: stage("Perdida") }).catch((e: unknown) => e);
    expect(noReason).toMatchObject({ code: "invalid_input" });
    expect((noReason as Error).message).toContain("lost_reason_required");
    expect((await h.sql`select stage_id, outcome from crm.opportunities where id = ${deal.id}`)[0]).toMatchObject({ stage_id: stage("Nuevo"), outcome: "open" });
    const lost = await h.run<{ outcome: string }>(h.admin, "crm.opportunity.stage_move", { id: deal.id, stageId: stage("Perdida"), lostReason: "Precio" });
    expect(lost.outcome).toBe("lost");
    const [row] = await h.sql`select outcome, lost_reason, closed_at, probability from crm.opportunities where id = ${deal.id}`;
    expect(row).toMatchObject({ outcome: "lost", lost_reason: "Precio" });
    expect(row!.closed_at).not.toBeNull();
    await expect(h.run(h.admin, "crm.opportunity.stage_move", { id: deal.id, stageId: stage("Nuevo") })).rejects.toMatchObject({ code: "invalid_input" });
    const alien = await h.run<{ stages: { id: string }[] }>(h.admin, "crm.pipeline.create", salesPipeline("AJENO"));
    const open = await newDeal(h.admin);
    await expect(h.run(h.admin, "crm.opportunity.stage_move", { id: open.id, stageId: alien.stages[1]!.id })).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("row isolation: a salesperson sees only their own oportunidades; reassign (a manager's process) shows all and hands them over", async () => {
    const mine = await newDeal(h.vendedor, { title: "Del vendedor" });
    const theirs = await newDeal(h.vendedora, { title: "De la vendedora" });
    const visible = async (caller: typeof h.vendedor) => {
      const { withClaims } = await import("@erp/kernel/testing");
      return withClaims(h.sql, caller.claims, (tx) => tx<{ id: string }[]>`select id from crm.v_opportunities where id = any(${[mine.id, theirs.id]}::uuid[])`);
    };
    expect((await visible(h.vendedor)).map((r) => r.id)).toEqual([mine.id]);
    expect((await visible(h.vendedora)).map((r) => r.id)).toEqual([theirs.id]);
    expect((await visible(h.admin)).map((r) => r.id).sort()).toEqual([mine.id, theirs.id].sort());
    // Their neighbour's deal does not exist for them, to read or to move.
    await expect(h.run(h.vendedor, "crm.opportunity.consult", { id: theirs.id })).rejects.toMatchObject({ code: "not_found" });
    await expect(h.run(h.vendedor, "crm.opportunity.stage_move", { id: theirs.id, stageId: stage("Propuesta") })).rejects.toMatchObject({ code: "not_found" });
    // Only whoever holds reassign hands deals over.
    await expect(h.run(h.vendedor, "crm.opportunity.reassign", { id: mine.id, ownerId: h.vendedora.claims.sub })).rejects.toMatchObject({ code: "forbidden" });
    await h.run(h.admin, "crm.opportunity.reassign", { id: mine.id, ownerId: h.vendedora.claims.sub });
    expect((await visible(h.vendedora)).map((r) => r.id).sort()).toEqual([mine.id, theirs.id].sort());
    expect((await visible(h.vendedor)).map((r) => r.id)).toEqual([]);
    await expect(h.run(h.admin, "crm.opportunity.reassign", { id: mine.id, ownerId: newId() })).rejects.toMatchObject({ code: "invalid_input" });
    // Company 1 sees none of company 0.
    await expect(h.run(h.other, "crm.opportunity.consult", { id: mine.id })).rejects.toMatchObject({ code: "not_found" });
  });

  it("row isolation reaches the lines and the activities: a neighbour's lines and activities read as no rows", async () => {
    const { withClaims } = await import("@erp/kernel/testing");
    const deal = await h.run<{ id: string }>(h.vendedor, "crm.opportunity.create", { title: "Con líneas privadas", partyId, pipelineId: pipeline.id, lines: [{ description: "Café especial", qty: 5, unitPrice: 30000 }] });
    const call = await h.run<{ id: string }>(h.vendedor, "crm.activity.create", { kind: "call", subject: "Llamada privada", opportunityId: deal.id });
    const count = (caller: typeof h.vendedor, view: string, column: string, id: string) =>
      withClaims(h.sql, caller.claims, (tx) => tx.unsafe<{ n: string }[]>(`select count(*)::text as n from crm.${view} where ${column} = $1`, [id] as never[])).then((r) => Number(r[0]!.n));
    expect(await count(h.vendedor, "v_opportunity_lines", "opportunity_id", deal.id)).toBe(1);
    expect(await count(h.vendedora, "v_opportunity_lines", "opportunity_id", deal.id)).toBe(0);
    expect(await count(h.admin, "v_opportunity_lines", "opportunity_id", deal.id)).toBe(1);
    expect(await count(h.vendedor, "v_activities", "id", call.id)).toBe(1);
    expect(await count(h.vendedora, "v_activities", "id", call.id)).toBe(0);
    // The base table is closed to them too (the views are security_invoker).
    expect(await count(h.vendedora, "opportunity_lines", "opportunity_id", deal.id)).toBe(0);
  });

  it("reassign validates the owner through the definer helper: a member is accepted, a stranger refused", async () => {
    const deal = await newDeal(h.vendedor);
    await h.run(h.admin, "crm.opportunity.reassign", { id: deal.id, ownerId: h.vendedora.claims.sub });
    expect((await h.sql`select owner_id from crm.opportunities where id = ${deal.id}`)[0]!.owner_id).toBe(h.vendedora.claims.sub);
    // Someone who is no member of the company is not a valid owner.
    await expect(h.run(h.admin, "crm.opportunity.reassign", { id: deal.id, ownerId: newId() })).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("a voided deal is not won by an order: nothing changes and no event is emitted", async () => {
    const deal = await newDeal(h.admin);
    await h.run(h.admin, "crm.opportunity.void", { id: deal.id, reason: "Duplicada" });
    expect((await h.sql`select status from crm.opportunities where id = ${deal.id}`)[0]!.status).toBe("voided");
    await crm.events.consumes["sales.order.confirmed"]!(h.consumer("sales.order.confirmed"), { orderId: newId(), opportunityId: deal.id });
    const [row] = await h.sql`select outcome, order_id, closed_at from crm.opportunities where id = ${deal.id}`;
    expect(row).toEqual({ outcome: "open", order_id: null, closed_at: null });
    expect((await h.sql`select 1 from kernel.outbox where event = 'crm.opportunity.won' and payload->>'opportunityId' = ${deal.id}`).length).toBe(0);
  });

  it("is won when sales.order.confirmed names the oportunidad (synthetic payload); a redelivery and an unrelated order change nothing", async () => {
    const deal = await newDeal(h.vendedor);
    const orderId = newId();
    const consume = crm.events.consumes["sales.order.confirmed"]!;
    await consume(h.consumer("sales.order.confirmed"), { orderId, opportunityId: deal.id, number: "PV-1", total: 2000000 });
    const [won] = await h.sql`select outcome, order_id, probability, stage_id, closed_at, lost_reason from crm.opportunities where id = ${deal.id}`;
    expect(won).toMatchObject({ outcome: "won", order_id: orderId, stage_id: stage("Ganada"), lost_reason: null });
    expect(Number(won!.probability)).toBe(100);
    expect(won!.closed_at).not.toBeNull();
    const [audit] = await h.sql`select origin, process_id from kernel.audit_log where entity = 'crm.opportunities' and row_id = ${deal.id} and action = 'update' and process_id = 'crm.opportunity.mark_won'`;
    expect(audit).toEqual({ origin: "event", process_id: "crm.opportunity.mark_won" });
    expect((await h.sql`select 1 from kernel.outbox where event = 'crm.opportunity.won' and payload->>'opportunityId' = ${deal.id}`).length).toBe(1);

    // Redelivery and a second order of the same deal: still the first order, no second event.
    await consume(h.consumer("sales.order.confirmed"), { orderId, opportunityId: deal.id });
    await consume(h.consumer("sales.order.confirmed"), { orderId: newId(), opportunityId: deal.id });
    expect((await h.sql`select order_id from crm.opportunities where id = ${deal.id}`)[0]!.order_id).toBe(orderId);
    expect((await h.sql`select 1 from kernel.outbox where event = 'crm.opportunity.won' and payload->>'opportunityId' = ${deal.id}`).length).toBe(1);

    // An order that came from no deal is ignored; a malformed payload and a missing deal are refused.
    await expect(consume(h.consumer("sales.order.confirmed"), { orderId: newId() })).resolves.toBeUndefined();
    await expect(consume(h.consumer("sales.order.confirmed"), { opportunityId: deal.id })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(consume(h.consumer("sales.order.confirmed"), { orderId: newId(), opportunityId: newId() })).rejects.toMatchObject({ code: "not_found" });
    // Only an event may run mark_won.
    await expect(h.run(h.admin, "crm.opportunity.mark_won", { opportunityId: deal.id, orderId: newId() })).rejects.toMatchObject({ code: "forbidden" });
  });

  it("logs a payment activity when invoicing.invoice.paid names the deal, once per invoice", async () => {
    const deal = await newDeal(h.vendedor);
    const invoiceId = newId();
    const consume = crm.events.consumes["invoicing.invoice.paid"]!;
    const payload = { invoiceId, number: "FE-1001", opportunityId: deal.id, amount: 2000000 };
    await consume(h.consumer("invoicing.invoice.paid"), payload);
    await consume(h.consumer("invoicing.invoice.paid"), payload);
    const rows = await h.sql`select kind, subject, opportunity_id, party_id, owner_id, done_at, source_entity from crm.activities where source_id = ${invoiceId}`;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "payment", subject: "Factura FE-1001 pagada", opportunity_id: deal.id, party_id: partyId, source_entity: "invoicing.invoice" });
    expect(rows[0]!.owner_id).toBe(h.vendedor.claims.sub);
    expect(rows[0]!.done_at).not.toBeNull();
    // Nothing to attach to: ignored.
    await expect(consume(h.consumer("invoicing.invoice.paid"), { invoiceId: newId(), number: "FE-2" })).resolves.toBeUndefined();
    await expect(consume(h.consumer("invoicing.invoice.paid"), { number: "FE-3" })).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("lets a person log an activity on their deal; the neighbour's activity stays hidden", async () => {
    const deal = await newDeal(h.vendedor);
    const call = await h.run<{ id: string; created: boolean }>(h.vendedor, "crm.activity.create", { kind: "call", subject: "Llamada de seguimiento", opportunityId: deal.id, done: true });
    expect(call.created).toBe(true);
    await expect(h.run(h.vendedor, "crm.activity.create", { kind: "note", subject: "Sin destino" })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(h.run(h.vendedor, "crm.activity.create", { kind: "note", subject: "Ajena", opportunityId: newId() })).rejects.toMatchObject({ code: "not_found" });
    await expect(h.run(h.vendedora, "crm.activity.consult", { id: call.id })).rejects.toMatchObject({ code: "not_found" });
    expect((await h.run<{ subject: string }>(h.admin, "crm.activity.consult", { id: call.id })).subject).toBe("Llamada de seguimiento");
  });
});
