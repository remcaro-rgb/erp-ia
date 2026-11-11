import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { defineEntity, kernelModule, loadModules, maskedViewSql, menuItemsOf, Registry, uncoveredMenuProcesses, uncoveredRecordWrites } from "@erp/kernel";
import { core } from "@erp/module-core";
import { sales, SALES_ENTITIES } from "../index";

// The sales manifest (design §8): the pricing parametros (sales.settings, sales.customer_terms) and the price resolution (Task 12), the
// pedido documento with its lines and processes (Task 13), the entrega and the devolución with theirs (Task 14). Every view is the
// generated masked view of its entity (rule 14), in its latest migration: 0082 for the pricing parametros, redefined by 0084 with their new
// columns, 0084 for the pedido, 0085 for the entrega and the devolución.

const migration = readFileSync(new URL("../../../../../supabase/migrations/0082_sales_quotes.sql", import.meta.url), "utf8");
const orders = readFileSync(new URL("../../../../../supabase/migrations/0084_sales_orders.sql", import.meta.url), "utf8");
const deliveries = readFileSync(new URL("../../../../../supabase/migrations/0085_sales_deliveries.sql", import.meta.url), "utf8");
// The entrega's view was regenerated for the void's re-reservation columns (Task 43: 0133 adds them, 0134 recreates the view).
const reReserveColumns = readFileSync(new URL("../../../../../supabase/migrations/0133_sales_delivery_re_reserve.sql", import.meta.url), "utf8");
const reReserveView = readFileSync(new URL("../../../../../supabase/migrations/0134_sales_delivery_re_reserve_view.sql", import.meta.url), "utf8");
// Order owner isolation (Task 39): 0139 regenerates the entrega's view with order_owner_id appended.
const ownerIsolation = readFileSync(new URL("../../../../../supabase/migrations/0139_sales_order_owner_isolation.sql", import.meta.url), "utf8");
// Review fix round 1 (0140): the approver branch of owner_scope and the owner rule in sales.lock_orders_for_invoice.
const ownerFixes = readFileSync(new URL("../../../../../supabase/migrations/0140_sales_order_owner_isolation_fixes.sql", import.meta.url), "utf8");
// Commissions (Task 30.1): 0156 creates the plans, bases and commissions and regenerates the settings' view with commission_basis.
const commissions = readFileSync(new URL("../../../../../supabase/migrations/0156_sales_commissions.sql", import.meta.url), "utf8");
// Lots and serials (Task 28.3): 0165 regenerates the entrega and devolución lines' views and creates sales.v_delivery_line_lots.
const deliveryLots = readFileSync(new URL("../../../../../supabase/migrations/0165_sales_delivery_lots.sql", import.meta.url), "utf8");
// Task 28.3/28.4 review: 0169 regenerates the entrega lines' view (a serial that sits in a lot reads «lot · serial»).
const serialInLot = readFileSync(new URL("../../../../../supabase/migrations/0169_lots_serial_in_lot_views.sql", import.meta.url), "utf8");
/** The migration holding the latest masked view of each entity. */
const viewMigration = (entityId: string) =>
  entityId === "sales.settings" || entityId.startsWith("sales.commission") ? commissions
    : entityId === "sales.delivery_line" ? serialInLot
    : /^sales\.(return_line|delivery_line_lot)$/.test(entityId) ? deliveryLots
    : entityId === "sales.delivery" ? ownerIsolation : entityId === "sales.return" ? deliveries : orders;

const loaded = () => {
  const registry = new Registry();
  loadModules(registry, [kernelModule, core, sales]);
  return registry;
};

describe("sales manifest", () => {
  it("depends on core, declares the four menu sections, its features, emits the pedido, entrega and devolución events and consumes inventory movements and refusals and the issued invoices", () => {
    expect(sales.dependsOn).toEqual(["core"]);
    expect(sales.navigation.map((n) => n.id)).toEqual(["sales.maestros", "sales.documentos", "sales.reportes", "sales.parametros"]);
    expect(sales.features.map((f) => f.id)).toEqual(["sales.pricing", "sales.orders", "sales.deliveries", "sales.returns", "sales.commissions"]);
    expect(Object.fromEntries(SALES_ENTITIES.map((e) => [e.id, e.entityType]))).toEqual({
      "sales.settings": "parametro", "sales.customer_terms": "parametro", "sales.order": "documento", "sales.order_line": "lines",
      "sales.delivery": "documento", "sales.delivery_line": "lines", "sales.return": "documento", "sales.return_line": "lines",
      "sales.commission_plan": "maestro", "sales.commission_base": "sistema", "sales.commission": "documento", "sales.commission_line": "lines",
      // Task 28.3: what inventory issued of each lot and serial of an entrega line.
      "sales.delivery_line_lot": "sistema",
    });
    expect(sales.events.emits).toEqual([
      "sales.order.created", "sales.order.confirmed", "sales.order.cancelled",
      "sales.delivery.shipped", "sales.delivery.voided", "sales.return.received", "sales.return.voided", "sales.commission.due",
      // Tasks 30.2 and 30.3: the provision and its reversal, posted by the module's rules.
      "sales.commission.accrued", "sales.commission.reversed",
    ]);
    // The sale issue inventory posted for an entrega is recorded on its lines, and what inventory refused (a despacho it could not issue,
    // the Anular of a devolución it could not take back) puts the document back with the reason: by event, sales never calls inventory (rule 3).
    expect(Object.keys(sales.events.consumes)).toEqual(["inventory.movement.posted", "inventory.sale_issue.refused", "inventory.sale_issue.allocated", "inventory.sale_return_void.refused", "inventory.delivery_reservation.restored",
      // Task 29.2: inventory's answer to a confirmed alistamiento (RG-8: sales reacts to inventory, never to the pick).
      "inventory.reservation.allocated", "invoicing.invoice.issued", "invoicing.invoice.annulled",
      // The commissions (Tasks 30.2, 30.3): accrued on the due event and the collections, adjusted by the notes, reversed by the voids.
      "invoicing.note.issued", "payments.payment.voided", "payments.advance.unapplied", "sales.commission.due", "payments.received", "payments.advance.applied"]);
  });

  it("the pedido numbers on save, sets its own approval flag, never posts, and lists its lines", () => {
    const order = SALES_ENTITIES.find((e) => e.id === "sales.order")!;
    expect(order.typed).toEqual({
      numbering: "on_save",
      lines: { entity: "sales.order_line", parentField: "order_id" },
      ownFlags: { requiresApproval: "sales.order.own_flags.requires_approval", posts: "sales.order.own_flags.posts" },
    });
    expect(sales.typedHooks?.["sales.order"]?.number).toBeTypeOf("function");
    expect(sales.typedHooks?.["sales.order"]?.validate).toBeTypeOf("function");
  });

  it("the entrega and the devolución number on save, never ask approval, never post, and list their lines", () => {
    for (const [id, lines, parentField] of [["sales.delivery", "sales.delivery_line", "delivery_id"], ["sales.return", "sales.return_line", "return_id"]] as const) {
      expect(SALES_ENTITIES.find((e) => e.id === id)!.typed).toEqual({
        numbering: "on_save",
        lines: { entity: lines, parentField },
        ownFlags: { requiresApproval: `${id}.own_flags.requires_approval`, posts: `${id}.own_flags.posts` },
      });
      expect(sales.typedHooks?.[id]?.number).toBeTypeOf("function");
    }
  });

  it("loads with the pricing, pedido, entrega and devolución processes, each under its feature, a menu item and a record guard", () => {
    const registry = loaded();
    const module = registry.module("sales");
    expect(registry.processes({ module: "sales" }).map((p) => p.id).sort()).toEqual(
      [
        "sales.settings.update", "sales.settings.consult", "sales.customer_terms.set", "sales.customer_terms.consult", "sales.price.resolve", "sales.discount.resolve",
        "sales.order.create", "sales.order.from_quote", "sales.order.update", "sales.order.confirm", "sales.order.cancel", "sales.order.void", "sales.order.reassign",
        "sales.order.consult", "sales.order_line.consult",
        // The kernel's generic lifecycle verbs the module does not declare itself (void is its own: it releases the reservations).
        "sales.order.save", "sales.order.submit", "sales.order.approve", "sales.order.reject", "sales.order.delete",
        "sales.delivery.create", "sales.delivery.update", "sales.delivery.ship", "sales.delivery.void", "sales.delivery.record_stock", "sales.delivery.record_lots", "sales.delivery.record_invoiced", "sales.delivery.reopen", "sales.delivery.record_re_reservation",
        "sales.delivery.consult", "sales.delivery_line.consult",
        "sales.delivery.save", "sales.delivery.submit", "sales.delivery.approve", "sales.delivery.reject", "sales.delivery.delete",
        "sales.return.create", "sales.return.receive", "sales.return.void", "sales.return.restore", "sales.return.consult", "sales.return_line.consult",
        "sales.return.save", "sales.return.submit", "sales.return.approve", "sales.return.reject", "sales.return.delete",
        // Commissions (Task 30.1): the plans (a maestro, with the generic verbs), the bases' compute and the «all commissions» permission.
        "sales.commission_plan.create", "sales.commission_plan.update", "sales.commission_plan.consult",
        "sales.commission_plan.save", "sales.commission_plan.submit", "sales.commission_plan.approve", "sales.commission_plan.reject", "sales.commission_plan.void", "sales.commission_plan.delete",
        "sales.commission.compute", "sales.commission.consult_all",
        // Tasks 30.2, 30.3: the accrual, the reversal and the credit-note adjustment.
        "sales.commission.accrue", "sales.commission.reverse", "sales.commission.adjust_for_note",
        "sales.commission.save", "sales.commission.submit", "sales.commission.approve", "sales.commission.reject", "sales.commission.void", "sales.commission.delete",
        // Task 30.4: the commission's record (Comisiones) and the report Comisiones por vendedor.
        "sales.commission.consult", "sales.report.commissions",
      ].sort(),
    );
    expect(module.features.flatMap((f) => f.processes).sort()).toEqual(module.processes.map((p) => p.id).sort());
    expect(uncoveredMenuProcesses(module)).toEqual([]);
    expect(uncoveredRecordWrites(registry).filter((id) => id.startsWith("sales."))).toEqual([]);
    const rows = menuItemsOf(module).filter((r) => r.href);
    expect(rows.map((r) => [r.navKey, r.parentKey, r.href])).toEqual([
      ["sales.commission_plans", "sales.maestros", "/sales/commission-plans"],
      ["sales.orders", "sales.documentos", "/sales/orders"],
      ["sales.deliveries", "sales.documentos", "/sales/deliveries"],
      ["sales.returns", "sales.documentos", "/sales/returns"],
      // Task 30.4: the commission documents and the report «Comisiones por vendedor».
      ["sales.commissions", "sales.documentos", "/sales/commissions"],
      ["sales.commission_report", "sales.reportes", "/sales/reports/commissions"],
      ["sales.customer_terms", "sales.parametros", "/sales/customer-terms"],
      ["sales.settings", "sales.parametros", "/sales/settings"],
      // A module with a documento gets the kernel's Parámetros pages of its documentos (entity types spec §9.2).
      ["sales.entity_types", "sales.parametros", "/sales/parametros/tipos"],
      ["sales.state_recipients", "sales.parametros", "/sales/parametros/destinatarios"],
      ["sales.doc_templates", "sales.parametros", "/sales/parametros/plantillas"],
    ]);
  });

  it("labels are i18n keys of their kind's namespace", () => {
    for (const entity of SALES_ENTITIES) {
      const resolved = defineEntity(entity);
      expect(resolved.label).toBe(`entity.${entity.id}`);
      for (const field of resolved.fields) expect(field.label).toBe(`field.${entity.id}.${field.name}`);
    }
  });
});

describe("sales never names crm in its manifest (rule 3, plan 2B Task 42)", () => {
  const strip = (code: string) => code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  // The manifest and its menu; crm's published views are read by sales.order.from_quote (migration 0084) by view name, a pre-existing, sanctioned read.
  for (const file of ["../index.ts", "../features.ts"]) {
    it(`${file} has no crm in code`, () => {
      expect(strip(readFileSync(new URL(file, import.meta.url), "utf8"))).not.toMatch(/crm/i);
    });
  }
  it("the manifest declares no shortcuts: the crm module contributes its own", () => {
    expect((sales as { shortcuts?: unknown }).shortcuts).toBeUndefined();
  });

  it("the pedido's cotización is a ref to crm.quote by number (Task 53.2), yet sales loads without crm and needs nothing of it", () => {
    const order = loaded().entity("sales.order");
    expect(order.fields.find((f) => f.name === "quote_id")).toMatchObject({ type: "ref", ref: { entity: "crm.quote", display: "number" } });
    // The oportunidad and the bodega stay raw ids.
    expect(order.fields.find((f) => f.name === "opportunity_id")?.type).toBe("uuid");
    expect(order.fields.find((f) => f.name === "warehouse_id")?.type).toBe("uuid");
    expect(sales.dependsOn).not.toContain("crm");
    expect(sales.needs ?? []).not.toContain("crm");
    expect(JSON.stringify([sales.navigation, sales.features, sales.dependsOn, sales.needs ?? []])).not.toMatch(/crm/i);
  });
});

describe("sales masked views, migrations 0082, 0084, 0085 and 0156", () => {
  for (const entity of SALES_ENTITIES) {
    it(`sales.v_${entity.table} is the generated masked view of ${entity.id} in its latest migration`, () => {
      const generated = maskedViewSql(defineEntity(entity));
      const sql = viewMigration(entity.id);
      expect(sql).toContain(generated.slice(0, generated.indexOf(`from ${entity.schema}.${entity.table}`)));
      expect(sql).toContain(`grant select on ${entity.schema}.v_${entity.table} to authenticated;`);
    });
  }

  it("0156 marks the commission rates and amounts confidential and masks them in the views, the plan lines' rate too (Task 30.1, RG-14)", () => {
    const confidential = Object.fromEntries(SALES_ENTITIES.filter((e) => e.id.startsWith("sales.commission"))
      .map((e) => [e.id, defineEntity(e).fields.filter((f) => f.sensitivity === "confidential").map((f) => f.name)]));
    expect(confidential).toEqual({
      "sales.commission_plan": ["default_rate_pct"],
      "sales.commission_base": ["rate_pct", "base", "base_doc", "commission", "commission_doc", "accrued", "reversed"],
      "sales.commission": ["amount"],
      "sales.commission_line": ["amount"],
    });
    for (const [entity, fields] of Object.entries(confidential)) {
      for (const field of fields) expect(commissions).toContain(`(select kernel.field_visible('${entity}', '${field}'))`);
    }
    // The plan lines are no entity of their own: their view masks the rate under the plan's default rate.
    expect(commissions).toMatch(/create or replace view sales\.v_commission_plan_lines[\s\S]*kernel\.field_visible\('sales\.commission_plan', ?'default_rate_pct'\)/);
  });

  it("Comisiones por vendedor (Task 30.4, PG §5.5): a report over sales.report.commissions by payee, period and status, every money column in pesos", () => {
    const registry = loaded();
    const report = registry.report("sales.commissions");
    expect(report).toMatchObject({ module: "sales", feature: "sales.commissions", consult: "sales.report.commissions", label: "report.sales.commissions" });
    expect(report.columns.map((c) => c.field)).toEqual(["payee_name", "plan_name", "invoice_number", "invoice_date", "product_name", "base", "rate_pct", "commission", "accrued", "reversed", "open"]);
    for (const c of report.columns.filter((c) => c.type === "money")) expect(c.currency, c.field).toBe("company");
    expect(report.totals).toEqual(["base", "commission", "accrued", "reversed", "open"]);
    expect(Object.keys(report.params.shape)).toEqual(["from", "to", "payeePartyId", "status"]);
    expect(registry.process("sales.report.commissions")).toMatchObject({ kind: "consult", feature: "sales.commissions" });
    expect(registry.process("sales.commission.consult")).toMatchObject({ kind: "consult", feature: "sales.commissions" });
  });

  it("the plan and the commission open in the record frame; the commission prints with its default template (Task 30.4)", () => {
    for (const id of ["sales.commission_plan", "sales.commission"]) expect(SALES_ENTITIES.find((e) => e.id === id)!.recordPage, id).toBe(true);
    for (const id of ["sales.commission_base", "sales.commission_line"]) expect(SALES_ENTITIES.find((e) => e.id === id)!.recordPage ?? false, id).toBe(false);
    const template = sales.printTemplates?.["sales.commission"]?.record?.({ title: "Comisión" } as never);
    const fields = template!.blocks.filter((b) => b.kind === "field").map((b) => (b as { value: string }).value);
    expect(fields).toEqual(["number", "date", "due_date", "payee_party_id", "payee_kind", "plan_id", "source_kind", "currency", "amount", "stage", "notes"]);
    expect(template!.blocks.find((b) => b.kind === "lines")).toMatchObject({ columns: ["line_no", "amount"] });
  });

  it("sales.commission.consult_all is the «all commissions» permission: an update, so no new role gets it by default (owner item 167)", () => {
    const consultAll = loaded().process("sales.commission.consult_all");
    expect(consultAll).toMatchObject({ module: "sales", kind: "update", feature: "sales.commissions", recordAccess: "none" });
    expect(loaded().process("sales.commission.compute")).toMatchObject({ kind: "create", origins: ["event"], emits: ["sales.commission.due"] });
  });

  it("0139 isolates the pedidos by owner: restrictive owner_scope on the pedido and its lines, the owners view, the entrega's order_owner_id (Task 39)", () => {
    expect(ownerIsolation).toContain(
      "create policy owner_scope on sales.orders as restrictive for select to authenticated\n  using (owner_id = (select kernel.current_user_id()) or (select kernel.can_run_process('sales.order.reassign')));",
    );
    expect(ownerIsolation).toContain(
      "create policy owner_scope on sales.order_lines as restrictive for select to authenticated\n  using (exists (select 1 from sales.orders o where o.id = order_id));",
    );
    // A pedido without owner is not visible to everyone (unlike the cotizaciones): no `owner_id is null` branch.
    expect(ownerIsolation).not.toMatch(/owner_id is null or/);
    expect(ownerIsolation).toMatch(/owner_source in \('direct', 'quote', 'reassigned', 'backfill_quote', 'backfill_audit', 'backfill_none'\)/);
    expect(ownerIsolation).toContain("case when (select kernel.field_visible('sales.order', 'owner_id')) then o.owner_id else null end as owner_id");
    expect(ownerIsolation).not.toMatch(/references (core|crm|inventory|invoicing|accounting|costing)\./);
    const order = SALES_ENTITIES.find((e) => e.id === "sales.order")!;
    // owner_source is internal provenance: not a field of the pedido, not in v_orders.
    expect(order.fields.map((f) => f.name)).not.toContain("owner_source");
    expect(order.fields.find((f) => f.name === "owner_id")).toMatchObject({ type: "uuid", filterable: true });
    const delivery = SALES_ENTITIES.find((e) => e.id === "sales.delivery")!;
    expect(delivery.fields.at(-1)).toMatchObject({ name: "order_owner_id", type: "uuid", viewExpr: expect.stringContaining("sales.v_order_owners") });
    expect(delivery.cloneReset).toContain("order_owner_id");
  });

  it("0140 lets the approvers read a pedido that needs approval and keeps the owner rule in the definer lock of invoicing (Task 39 fix round 1)", () => {
    expect(ownerFixes).toContain("drop policy owner_scope on sales.orders;");
    expect(ownerFixes).toContain("or (requires_approval and ((select kernel.can_run_process('sales.order.approve')) or (select kernel.can_run_process('sales.order.reject'))))");
    expect(ownerFixes).toContain("and (v_all or o.owner_id = v_user or (o.requires_approval and v_approver))");
    expect(ownerFixes).not.toMatch(/owner_id is null or/);
  });

  it("sales.order.reassign is the «all orders» permission: an update of the pedido feature, not step-up, taking only the id and the owner (Task 39)", () => {
    const registry = loaded();
    const reassign = registry.process("sales.order.reassign");
    expect(reassign).toMatchObject({ module: "sales", kind: "update", feature: "sales.orders" });
    expect(reassign.sensitivity ?? "normal").toBe("normal");
    expect(Object.keys((reassign.input as unknown as { shape: Record<string, unknown> }).shape).sort()).toEqual(["id", "ownerId"]);
    // The owner changes only through it: sales.order.update takes no owner.
    expect(Object.keys((registry.process("sales.order.update").input as unknown as { shape: Record<string, unknown> }).shape)).not.toContain("ownerId");
  });

  it("0133 adds the three re-reservation columns of the entrega (result checked) and 0134 recreates its masked view with them (Task 43)", () => {
    const entity = SALES_ENTITIES.find((e) => e.id === "sales.delivery")!;
    expect(entity.fields.map((f) => f.name)).toEqual(expect.arrayContaining(["re_reserve_requested", "re_reserve_result", "re_reserve_note"]));
    for (const column of ["re_reserve_requested", "re_reserve_result", "re_reserve_note"]) {
      expect(reReserveColumns).toContain(`add column if not exists ${column}`);
      expect(reReserveView).toContain(`as "${column}"`);
    }
    expect(reReserveColumns).toMatch(/re_reserve_result in \('reserved', 'insufficient', 'not_permitted', 'none'\)/);
    expect(reReserveColumns).not.toMatch(/references (core|crm|inventory|accounting|costing)\./);
    // A clone starts without the original's outcome.
    expect(entity.cloneReset).toEqual(expect.arrayContaining(["re_reserve_requested", "re_reserve_result", "re_reserve_note"]));
  });

  it("0085 references no other schema by foreign key and writes only through the sales processes (rule 3)", () => {
    expect(deliveries).not.toMatch(/references (core|crm|inventory|accounting|costing)\./);
    expect(deliveries).toMatch(/create policy via_process_insert on sales\.%I as restrictive for insert/);
    expect(deliveries).toMatch(/create policy via_process_delete on sales\.%I as restrictive for delete/);
  });

  it("0084 references no other schema by foreign key and writes only through the sales processes (rule 3)", () => {
    expect(orders).not.toMatch(/references (core|crm|inventory)\./);
    expect(orders).toMatch(/create policy via_process_insert on sales\.%I as restrictive for insert/);
    expect(orders).toMatch(/create policy via_process_delete on sales\.%I as restrictive for delete/);
    // crm's part is two read views published for the pedido, nothing written.
    const crmPart = orders.slice(orders.indexOf("-- crm: the cotizaciones as published"), orders.indexOf("-- Masked read views"));
    expect(crmPart).not.toMatch(/\b(insert into|update|alter table|create table|create policy|create trigger)\b/i);
  });

  it("writes only through the sales processes and references no other schema by foreign key (rule 3)", () => {
    expect(migration).toMatch(/create policy via_process_insert on sales\.%I as restrictive for insert/);
    const salesPart = migration.slice(0, migration.indexOf("-- crm: cotizaciones"));
    expect(salesPart).not.toMatch(/references (core|crm|inventory)\./);
  });
});

describe("sales print templates (plan 2B Task 14b)", () => {
  it("ships its own template for the pedido and the entrega (what the customer reads)", async () => {
    const { ORDER_PRINT_FIELDS, ORDER_PRINT_LINE_COLUMNS, DELIVERY_PRINT_FIELDS, DELIVERY_PRINT_LINE_COLUMNS, orderRecordTemplate, deliveryRecordTemplate } = await import("../print");
    expect(sales.printTemplates?.["sales.order"]?.record).toBe(orderRecordTemplate);
    expect(sales.printTemplates?.["sales.delivery"]?.record).toBe(deliveryRecordTemplate);
    const order = orderRecordTemplate({ title: "Pedido" });
    expect(order.blocks.filter((b) => b.kind === "field").map((b) => b.value)).toEqual(ORDER_PRINT_FIELDS);
    expect(order.blocks.find((b) => b.kind === "lines")?.columns).toEqual(ORDER_PRINT_LINE_COLUMNS);
    const delivery = deliveryRecordTemplate({ title: "Entrega" });
    expect(delivery.blocks.filter((b) => b.kind === "field").map((b) => b.value)).toEqual(DELIVERY_PRINT_FIELDS);
    expect(delivery.blocks.find((b) => b.kind === "lines")?.columns).toEqual(DELIVERY_PRINT_LINE_COLUMNS);
  });

  it("the entrega prints titled «Remisión de entrega» (Task 50.33) while the screen keeps «Entrega»", async () => {
    const { deliveryRecordTemplate } = await import("../print");
    const read = (locale: string) => JSON.parse(readFileSync(new URL(`../../../../i18n/messages/${locale}.json`, import.meta.url), "utf8")) as { sales: { print: { delivery_title: string } } };
    expect(read("es-419").sales.print.delivery_title).toBe("Remisión de entrega");
    expect(read("en").sales.print.delivery_title).toBe("Delivery note");
    const t = (key: string) => (key === "sales.print.delivery_title" ? "Remisión de entrega" : undefined);
    const delivery = deliveryRecordTemplate({ title: "Entrega", t });
    const titles = delivery.blocks.filter((b) => b.kind === "text" && b.font?.size === 14).map((b) => b.value);
    expect(titles).toEqual(["Remisión de entrega"]);
    expect(delivery.name).toBe("Remisión de entrega");
  });

  it("ships one for the devolución too (fix round 1): what came back, without prices", async () => {
    const print = (await import("../print")) as Record<string, unknown>;
    const returnRecordTemplate = print.returnRecordTemplate as ((p: { title: string }) => { blocks: { kind: string; value?: string; columns?: string[] }[] }) | undefined;
    expect(returnRecordTemplate).toBeTypeOf("function");
    expect(sales.printTemplates?.["sales.return"]?.record).toBe(returnRecordTemplate);
    const ret = returnRecordTemplate!({ title: "Devolución" });
    expect(ret.blocks.filter((b) => b.kind === "field").map((b) => b.value)).toEqual(["number", "delivery_id", "party_id", "date", "reason", "notes"]);
    expect(ret.blocks.find((b) => b.kind === "lines")?.columns).toEqual(["line_no", "product_id", "description", "qty"]);
  });
});

describe("Duplicar a pedido (rule 37, plan 2B Task 14b fix 1)", () => {
  it("a copy starts today: its issue and delivery dates, number, stage and cotización are not copied", async () => {
    const { cloneDraft } = await import("@erp/kernel");
    const registry = new Registry();
    loadModules(registry, [kernelModule, core, sales]);
    const draft = cloneDraft(registry, "sales.order", { party_id: "p1", issue_date: "2026-10-01", delivery_date: "2026-10-10", number: "PED-1", stage: "delivered", notes: "N", currency: "COP" });
    expect(draft).not.toHaveProperty("issueDate");
    expect(draft).not.toHaveProperty("deliveryDate");
    expect(draft).toMatchObject({ partyId: "p1", notes: "N" });
  });
});
