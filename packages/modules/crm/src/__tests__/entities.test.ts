import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { defineEntity, GENERIC_VERBS, isTypedEntity, kernelModule, loadModules, maskedViewSql, Registry, menuItemsOf, uncoveredMenuProcesses, uncoveredRecordWrites } from "@erp/kernel";
import { core } from "@erp/module-core";
import { sales } from "@erp/module-sales";
import { crm, CRM_ENTITIES } from "../index";

// The crm manifest (plan 2B Task 11, design §8): two maestros (prospectos, embudos) with the etapas as lines, one documento (oportunidad),
// the actividades (sistema); Task 12 adds the cotización (documento) with its lines and the Parámetros de CRM (parametro). Every view of the
// migrations is the generated masked view of its entity (rule 14).

const read = (file: string) => readFileSync(new URL(`../../../../../supabase/migrations/${file}`, import.meta.url), "utf8");
const migration = read("0079_crm_core.sql") + read("0082_sales_quotes.sql");

const loaded = () => {
  const registry = new Registry();
  loadModules(registry, [kernelModule, core, sales, crm]);
  return registry;
};

describe("crm manifest", () => {
  it("depends on core and sales, declares the four menu sections and the six features", () => {
    expect(crm.id).toBe("crm");
    expect(crm.dependsOn).toEqual(["core", "sales"]);
    expect(crm.navigation.map((n) => n.id)).toEqual(["crm.maestros", "crm.documentos", "crm.reportes", "crm.parametros"]);
    expect(crm.features.map((f) => f.id)).toEqual(["crm.leads", "crm.pipelines", "crm.opportunities", "crm.activities", "crm.quotes", "crm.settings"]);
    expect(crm.features.flatMap((f) => f.entities).sort()).toEqual(CRM_ENTITIES.map((e) => e.id).sort());
  });

  it("types every entity: prospecto and embudo maestros, etapa lines, oportunidad documento numbered on save, actividad sistema", () => {
    expect(Object.fromEntries(CRM_ENTITIES.map((e) => [e.id, e.entityType]))).toEqual({
      "crm.lead": "maestro",
      "crm.pipeline": "maestro",
      "crm.stage": "lines",
      "crm.opportunity": "documento",
      "crm.opportunity_line": "lines",
      "crm.activity": "sistema",
      "crm.quote": "documento",
      "crm.quote_line": "lines",
      "crm.settings": "parametro",
    });
    const byId = Object.fromEntries(CRM_ENTITIES.map((e) => [e.id, e]));
    expect(byId["crm.pipeline"]!.typed?.lines).toEqual({ entity: "crm.stage", parentField: "pipeline_id" });
    const opportunity = byId["crm.opportunity"]!;
    expect(opportunity.typed?.numbering).toBe("on_save");
    expect(opportunity.typed?.ownFlags).toEqual({ requiresApproval: "crm.opportunity.own_flags.requires_approval", posts: "crm.opportunity.own_flags.posts" });
    expect(opportunity.typed?.lines).toEqual({ entity: "crm.opportunity_line", parentField: "opportunity_id" });
    expect(opportunity.processIds?.create).toBe("crm.opportunity.create");
    const quote = byId["crm.quote"]!;
    expect(quote.typed).toEqual({
      numbering: "on_save",
      lines: { entity: "crm.quote_line", parentField: "quote_id" },
      ownFlags: { requiresApproval: "crm.quote.own_flags.requires_approval", posts: "crm.quote.own_flags.posts" },
    });
    expect(quote.processIds?.create).toBe("crm.quote.create");
  });

  it("loads with the brief processes and the generic lifecycle of the typed entities", () => {
    const registry = loaded();
    const generic = (entity: string) => GENERIC_VERBS.map((v) => `${entity}.${v}`);
    expect(registry.processes({ module: "crm" }).map((p) => p.id).sort()).toEqual(
      [
        "crm.lead.create", "crm.lead.update", "crm.lead.convert", "crm.lead.consult",
        "crm.pipeline.create", "crm.pipeline.update", "crm.pipeline.consult", "crm.stage.consult",
        "crm.opportunity.create", "crm.opportunity.stage_move", "crm.opportunity.reassign", "crm.opportunity.mark_won", "crm.opportunity.consult", "crm.opportunity_line.consult",
        "crm.activity.create", "crm.activity.consult",
        "crm.quote.create", "crm.quote.update", "crm.quote.send", "crm.quote.accept", "crm.quote.expire", "crm.quote.consult", "crm.quote_line.consult",
        "crm.settings.update", "crm.settings.consult",
        ...generic("crm.lead"), ...generic("crm.pipeline"), ...generic("crm.opportunity"), ...generic("crm.quote"),
      ].sort(),
    );
    expect(crm.events.emits).toEqual(["crm.opportunity.stage_moved", "crm.opportunity.won", "crm.opportunity.lost", "crm.quote.sent", "crm.quote.accepted", "crm.quote.expired"]);
    // The events of the modules that do not exist yet are consumed by name.
    expect(Object.keys(crm.events.consumes).sort()).toEqual(["invoicing.invoice.paid", "sales.order.confirmed"]);
  });

  it("the consumers activate by event name once an emitting module loads: the registry holds them for those events", async () => {
    const { consumers } = await import("@erp/kernel");
    loaded();
    expect(consumers.for("sales.order.confirmed").map((c) => c.moduleId)).toContain("crm");
    expect(consumers.for("invoicing.invoice.paid").map((c) => c.moduleId)).toContain("crm");
  });

  it("only an event may run mark_won, and every process sits under a feature, a menu item and a record guard", () => {
    const registry = loaded();
    expect(registry.process("crm.opportunity.mark_won").origins).toEqual(["event"]);
    const module = registry.module("crm");
    const listed = module.features.flatMap((f) => f.processes).sort();
    expect(listed).toEqual(module.processes.map((p) => p.id).sort());
    expect(new Set(listed).size).toBe(listed.length);
    expect(uncoveredMenuProcesses(module)).toEqual([]);
    expect(uncoveredRecordWrites(registry).filter((id) => id.startsWith("crm."))).toEqual([]);
  });

  it("menu: Prospectos and Embudos in Maestros, Oportunidades and Cotizaciones in Documentos, Actividades in Reportes, Parámetros de CRM", () => {
    const rows = menuItemsOf(loaded().module("crm")).filter((r) => r.href);
    expect(rows.filter((r) => !r.href!.startsWith("/crm/parametros/")).map((r) => [r.navKey, r.parentKey, r.href])).toEqual([
      ["crm.leads", "crm.maestros", "/crm/leads"],
      ["crm.pipelines", "crm.maestros", "/crm/pipelines"],
      ["crm.opportunities", "crm.documentos", "/crm/opportunities"],
      ["crm.quotes", "crm.documentos", "/crm/quotes"],
      ["crm.activities", "crm.reportes", "/crm/activities"],
      ["crm.settings", "crm.parametros", "/crm/settings"],
    ]);
    const at = (key: string) => rows.find((r) => r.navKey === key)!;
    expect(at("crm.leads").processIds).toEqual(expect.arrayContaining(["crm.lead.convert"]));
    expect(at("crm.opportunities").processIds).toEqual(expect.arrayContaining(["crm.opportunity.stage_move", "crm.opportunity.mark_won", "crm.opportunity.reassign"]));
  });

  it("labels are i18n keys of their kind's namespace", () => {
    for (const entity of CRM_ENTITIES) {
      const resolved = defineEntity(entity);
      expect(resolved.label).toBe(`entity.${entity.id}`);
      for (const field of resolved.fields) expect(field.label).toBe(`field.${entity.id}.${field.name}`);
    }
  });
});

describe("crm masked views, migrations 0079 and 0082", () => {
  for (const entity of CRM_ENTITIES) {
    it(`crm.v_${entity.table} is the generated masked view of ${entity.id}`, () => {
      const generated = maskedViewSql(defineEntity(entity));
      const head = generated.slice(0, generated.indexOf(`from ${entity.schema}.${entity.table}`));
      expect(migration).toContain(head);
      expect(migration).toContain(`grant select on ${entity.schema}.v_${entity.table} to authenticated;`);
      if (isTypedEntity(entity)) expect(migration).toContain(`select kernel.typed_columns('crm', '${entity.table}'`);
    });
  }

  it("isolates the oportunidades and actividades by owner (design §6) with a restrictive policy keyed on crm.opportunity.reassign", () => {
    for (const table of ["opportunities", "activities"]) {
      expect(migration).toMatch(new RegExp(`create policy owner_scope on crm\\.${table} as restrictive for select to authenticated`));
    }
    expect(migration).toContain("kernel.can_run_process('crm.opportunity.reassign')");
  });
});

describe("crm row isolation, migration 0080", () => {
  const isolation = readFileSync(new URL("../../../../../supabase/migrations/0080_crm_row_isolation.sql", import.meta.url), "utf8");

  it("scopes the lines through their oportunidad and the prospectos by owner, and validates owners with a definer helper", () => {
    expect(isolation).toMatch(/create policy owner_scope on crm\.opportunity_lines as restrictive for select to authenticated\s+using \(exists \(select 1 from crm\.opportunities o where o\.id = opportunity_id\)\)/);
    expect(isolation).toMatch(/create policy owner_scope on crm\.leads as restrictive for select/);
    expect(isolation).toContain("security definer");
    expect(isolation).toContain("crm.is_company_member");
  });
});

describe("crm cotizaciones, migration 0082", () => {
  const quotes = read("0082_sales_quotes.sql");

  it("isolates the cotizaciones by owner, their lines through the cotización, and locks the lines and amounts once accepted", () => {
    expect(quotes).toMatch(/create policy owner_scope on crm\.quotes as restrictive for select to authenticated/);
    expect(quotes).toMatch(/create policy owner_scope on crm\.quote_lines as restrictive for select to authenticated\s+using \(exists \(select 1 from crm\.quotes q where q\.id = quote_id\)\)/);
    expect(quotes).toContain("create trigger quote_lines_locked before insert or update or delete on crm.quote_lines");
    expect(quotes).toContain("create trigger quote_accepted_frozen before update on crm.quotes");
    expect(quotes).toContain("select kernel.typed_lines('crm', 'quote_lines', 'crm.quote', 'quote_id');");
  });

  it("migration 0083: the sale facts carry both halves of readiness (complete and usable), and an approver sees what needs approval", () => {
    const fix = read("0083_sales_readiness_usable.sql");
    expect(fix).toContain(`"invoice_ready" and kernel.record_usable('core.party', "id") as "invoice_ready"`);
    expect(fix).toContain(`"invoice_ready" and kernel.record_usable('core.product', "id") as "invoice_ready"`);
    expect(fix).toContain("drop policy owner_scope on crm.quotes;");
    expect(fix).toContain("or (requires_approval and (select kernel.can_run_process('crm.quote.approve')))");
  });

  it("ships its own print template for the cotización (the commercial fields and line columns only)", async () => {
    const { QUOTE_PRINT_FIELDS, QUOTE_PRINT_LINE_COLUMNS, quoteRecordTemplate } = await import("../print");
    expect(crm.printTemplates?.["crm.quote"]?.record).toBe(quoteRecordTemplate);
    const template = quoteRecordTemplate({ title: "Cotización" });
    const fields = template.blocks.filter((b) => b.kind === "field").map((b) => b.value);
    expect(fields).toEqual(QUOTE_PRINT_FIELDS);
    expect(template.blocks.find((b) => b.kind === "lines")?.columns).toEqual(QUOTE_PRINT_LINE_COLUMNS);
  });
});

describe("Duplicar (rule 37, plan 2B Task 14b fix 1)", () => {
  const registry = new Registry();
  loadModules(registry, [kernelModule, core, sales, crm]);

  it("a copy of a cotización starts today with the default validity: its dates, number and stage are not copied", async () => {
    const { cloneDraft } = await import("@erp/kernel");
    const draft = cloneDraft(registry, "crm.quote", { party_id: "p1", issue_date: "2026-10-01", valid_until: "2026-10-31", number: "COT-1", stage: "accepted", notes: "N", currency: "COP" });
    expect(draft).not.toHaveProperty("issueDate");
    expect(draft).not.toHaveProperty("validUntil");
    expect(draft).toMatchObject({ partyId: "p1", notes: "N" });
  });

  it("a copy of a prospecto leaves its e-mail (with the name, what tells two prospectos apart on import) empty", async () => {
    const { cloneDraft } = await import("@erp/kernel");
    const draft = cloneDraft(registry, "crm.lead", { name: "Tostadores", email: "compras@tostadores.example", contact_name: "Marta", source: "web", is_active: true });
    expect(draft).not.toHaveProperty("email");
    expect(draft).toMatchObject({ name: "Tostadores", contactName: "Marta" });
  });
});
