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
/** The migration holding the latest masked view of each entity. */
const viewMigration = (entityId: string) =>
  entityId === "sales.delivery" ? reReserveView : /^sales\.(delivery_line|return|return_line)$/.test(entityId) ? deliveries : orders;

const loaded = () => {
  const registry = new Registry();
  loadModules(registry, [kernelModule, core, sales]);
  return registry;
};

describe("sales manifest", () => {
  it("depends on core, declares the four menu sections, its features, emits the pedido, entrega and devolución events and consumes inventory movements and refusals and the issued invoices", () => {
    expect(sales.dependsOn).toEqual(["core"]);
    expect(sales.navigation.map((n) => n.id)).toEqual(["sales.maestros", "sales.documentos", "sales.reportes", "sales.parametros"]);
    expect(sales.features.map((f) => f.id)).toEqual(["sales.pricing", "sales.orders", "sales.deliveries", "sales.returns"]);
    expect(Object.fromEntries(SALES_ENTITIES.map((e) => [e.id, e.entityType]))).toEqual({
      "sales.settings": "parametro", "sales.customer_terms": "parametro", "sales.order": "documento", "sales.order_line": "lines",
      "sales.delivery": "documento", "sales.delivery_line": "lines", "sales.return": "documento", "sales.return_line": "lines",
    });
    expect(sales.events.emits).toEqual([
      "sales.order.created", "sales.order.confirmed", "sales.order.cancelled",
      "sales.delivery.shipped", "sales.delivery.voided", "sales.return.received", "sales.return.voided",
    ]);
    // The sale issue inventory posted for an entrega is recorded on its lines, and what inventory refused (a despacho it could not issue,
    // the Anular of a devolución it could not take back) puts the document back with the reason: by event, sales never calls inventory (rule 3).
    expect(Object.keys(sales.events.consumes)).toEqual(["inventory.movement.posted", "inventory.sale_issue.refused", "inventory.sale_return_void.refused", "inventory.delivery_reservation.restored", "invoicing.invoice.issued", "invoicing.invoice.annulled"]);
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
        "sales.order.create", "sales.order.from_quote", "sales.order.update", "sales.order.confirm", "sales.order.cancel", "sales.order.void",
        "sales.order.consult", "sales.order_line.consult",
        // The kernel's generic lifecycle verbs the module does not declare itself (void is its own: it releases the reservations).
        "sales.order.save", "sales.order.submit", "sales.order.approve", "sales.order.reject", "sales.order.delete",
        "sales.delivery.create", "sales.delivery.update", "sales.delivery.ship", "sales.delivery.void", "sales.delivery.record_stock", "sales.delivery.record_invoiced", "sales.delivery.reopen", "sales.delivery.record_re_reservation",
        "sales.delivery.consult", "sales.delivery_line.consult",
        "sales.delivery.save", "sales.delivery.submit", "sales.delivery.approve", "sales.delivery.reject", "sales.delivery.delete",
        "sales.return.create", "sales.return.receive", "sales.return.void", "sales.return.restore", "sales.return.consult", "sales.return_line.consult",
        "sales.return.save", "sales.return.submit", "sales.return.approve", "sales.return.reject", "sales.return.delete",
      ].sort(),
    );
    expect(module.features.flatMap((f) => f.processes).sort()).toEqual(module.processes.map((p) => p.id).sort());
    expect(uncoveredMenuProcesses(module)).toEqual([]);
    expect(uncoveredRecordWrites(registry).filter((id) => id.startsWith("sales."))).toEqual([]);
    const rows = menuItemsOf(module).filter((r) => r.href);
    expect(rows.map((r) => [r.navKey, r.parentKey, r.href])).toEqual([
      ["sales.orders", "sales.documentos", "/sales/orders"],
      ["sales.deliveries", "sales.documentos", "/sales/deliveries"],
      ["sales.returns", "sales.documentos", "/sales/returns"],
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
});

describe("sales masked views, migrations 0082, 0084 and 0085", () => {
  for (const entity of SALES_ENTITIES) {
    it(`sales.v_${entity.table} is the generated masked view of ${entity.id} in its latest migration`, () => {
      const generated = maskedViewSql(defineEntity(entity));
      const sql = viewMigration(entity.id);
      expect(sql).toContain(generated.slice(0, generated.indexOf(`from ${entity.schema}.${entity.table}`)));
      expect(sql).toContain(`grant select on ${entity.schema}.v_${entity.table} to authenticated;`);
    });
  }

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
