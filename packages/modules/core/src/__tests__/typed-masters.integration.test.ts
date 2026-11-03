import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { isTypedEntity, runProcess, type Caller } from "@erp/kernel";
import { withClaims } from "@erp/kernel/testing";
import { attachFile, coreHarness, exito, supplier, type CoreHarness } from "./helpers";

// The core maestros on the typed-entity lifecycle (entity types spec 2026-11-02 §2.2, §5, §12; Task 8a, migration 0042): party,
// product, product category and price list carry the maestro columns, existing and new records are Grabado, a maestro is usable
// on documents only when active and Grabado (Aprobado when it requires approval), the generic Grabar runs the module's own
// validation (country pack, DIAN status, party scope, duplicates, events), the update processes follow the lifecycle (D10), and
// invoice readiness (rule 10) also needs a usable party.

const cafe = {
  sku: "TYP-500",
  description: "Café tostado molido 500 g",
  kind: "good",
  idScheme: "010",
  standardCode: "7702001005000",
  uomCode: "94",
  ivaRate: "5",
  otherTaxes: [],
  listPrice: 28500,
  isFreeSample: false,
  trackStock: true,
};

describe("core maestros on the typed lifecycle", () => {
  let h: CoreHarness;
  let sql: CoreHarness["sql"];
  let deps: CoreHarness["deps"];
  let admin: Caller;
  let vendedor: Caller;

  /** kernel.record_usable as the admin of company 0. */
  const usable = async (entity: string, id: string) =>
    (await withClaims(sql, admin.claims, (tx) => tx<{ ok: boolean }[]>`select kernel.record_usable(${entity}, ${id}::uuid) as ok`))[0]!.ok;
  /** The flag accounting reads (core.v_party_readiness), as the admin. */
  const readiness = async (id: string) =>
    (await withClaims(sql, admin.claims, (tx) => tx<{ invoice_ready: boolean }[]>`select invoice_ready from core.v_party_readiness where id = ${id}`))[0]?.invoice_ready;
  const outbox = async (event: string, id: string) => (await sql`select 1 from kernel.outbox where event = ${event} and payload->>'id' = ${id}`).length;
  const attachPartyFiles = async (partyId: string) => {
    for (const tag of ["RUT", "Cámara de Comercio"]) await attachFile(sql, { tenantId: h.seed.tenantId, companyId: h.companyId, entity: "core.party", recordId: partyId, tag });
  };
  const requireApproval = async (entity: string, on: boolean) => {
    await sql`insert into kernel.entity_type_settings (company_id, entity, requires_approval) values (${h.companyId}, ${entity}, ${on})
              on conflict (company_id, entity) do update set requires_approval = excluded.requires_approval`;
  };

  beforeAll(async () => {
    h = await coreHarness({ users: [{ name: "vendedor", companies: [0], role: "member" }] });
    ({ sql, deps, admin } = h);
    // Every core process the registry holds (the module's own and the loader's generic ones) for the admin.
    const all = deps.registry.processes({ module: "core" }).map((p) => p.id);
    await h.grantAll(h.companyId, h.seed.companies[0]!.adminRoleId, all);
    // A sales role that only reaches customers (design §5.18) and may run the generic Grabar and Eliminar of parties.
    const company = h.seed.companies[0]!;
    await sql`update kernel.roles set name = 'vendedor', party_scope = 'clientes' where id = ${company.memberRoleId}`;
    await h.grantAll(company.id, company.memberRoleId, ["core.party.create", "core.party.update", "core.party.consult", "core.party.save", "core.party.delete", "core.party.submit"]);
    vendedor = { claims: h.seed.claimsFor(h.seed.users.vendedor!, h.companyId), origin: "ui" };
  });
  afterAll(async () => {
    await sql`delete from kernel.entity_type_settings where company_id = ${h.companyId}`;
    await sql`delete from kernel.attachments where company_id = ${h.companyId}`;
    await h.cleanup();
  });

  it("every maestro and documento table of core has the typed columns, the maestro state check, the flag trigger and its entity_tables row (0042)", async () => {
    const typed = deps.registry.entities("core").filter(isTypedEntity);
    expect(typed.map((e) => e.id).sort()).toEqual(["core.party", "core.price_list", "core.product", "core.product_category"]);
    for (const entity of typed) {
      const columns = await sql<{ column_name: string; column_default: string | null; is_nullable: string }[]>`
        select column_name, column_default, is_nullable from information_schema.columns where table_schema = ${entity.schema} and table_name = ${entity.table}`;
      const by = new Map(columns.map((c) => [c.column_name, c]));
      for (const name of ["status", "requires_approval", "is_active", "deleted_at", "void_reason"]) expect(by.has(name), `${entity.table}.${name}`).toBe(true);
      expect(by.get("status")!.is_nullable, entity.table).toBe("NO");
      expect(by.get("is_active")!.is_nullable, entity.table).toBe("NO");
      const [check] = await sql<{ def: string }[]>`
        select pg_get_constraintdef(c.oid) as def from pg_constraint c
        where c.conrelid = ${`${entity.schema}.${entity.table}`}::regclass and c.conname = ${`${entity.table}_status_check`}`;
      for (const state of ["draft", "saved", "pending", "rejected", "approved"]) expect(check!.def, entity.table).toContain(`'${state}'`);
      expect(check!.def).not.toContain("'active'");
      expect(check!.def).not.toContain("'posted'");
      const [trigger] = await sql`select 1 from pg_trigger where tgrelid = ${`${entity.schema}.${entity.table}`}::regclass and tgname = 'typed_copy_flags'`;
      expect(trigger, entity.table).toBeDefined();
      const [row] = await sql`select entity_type, table_schema, table_name from kernel.entity_tables where entity = ${entity.id}`;
      expect(row, entity.id).toMatchObject({ entity_type: "maestro", table_schema: entity.schema, table_name: entity.table });
      // The lifecycle columns are fields of the entity, so the masked view publishes them (status, requires_approval, is_active).
      for (const name of ["status", "requires_approval", "is_active"]) expect(entity.fields.some((f) => f.name === name), `${entity.id}.${name}`).toBe(true);
    }
    // The references of 0042: who uses a core maestro (Eliminar refuses a referenced one).
    const refs = await sql<{ entity: string; at: string }[]>`select entity, ref_schema || '.' || ref_table || '.' || ref_column as at from kernel."references" where entity like 'core.%' order by 1, 2`;
    expect(refs).toEqual(
      expect.arrayContaining([
        { entity: "core.party", at: "core.products.supplier_id" },
        { entity: "core.party", at: "accounting.entry_lines.party_id" },
        { entity: "core.party", at: "accounting.entry_template_lines.party_id" },
        { entity: "core.product", at: "core.price_list_items.product_id" },
        { entity: "core.product_category", at: "core.products.category_id" },
      ]),
    );
  });

  it("a party created through its process is Grabado and usable; an inactive one is not; one inserted without a process is Grabado too", async () => {
    const out = await runProcess(deps, admin, "core.party.create", { ...exito, documentNumber: "860000101" });
    const [row] = await sql`select status, requires_approval, is_active, deleted_at from core.parties where id = ${out.id}`;
    expect(row).toMatchObject({ status: "saved", requires_approval: false, is_active: true, deleted_at: null });
    expect(await usable("core.party", out.id)).toBe(true);
    // The masked view publishes the lifecycle state.
    const seen = await runProcess(deps, admin, "core.party.consult", { id: out.id });
    expect(seen).toMatchObject({ status: "saved", requires_approval: false, is_active: true });

    await runProcess(deps, admin, "core.party.deactivate", { id: out.id });
    expect(await usable("core.party", out.id)).toBe(false);

    // A row written without a process (legacy data, fixtures) lands as Grabado, like the rows 0042 migrated.
    const [legacy] = await sql<{ id: string; status: string }[]>`
      insert into core.parties (company_id, kind, person_type, document_type, document_number, legal_name, dian_status)
      values (${h.companyId}, '{customer}', '1', '13', '1010101', 'Cliente Legado', 'complete') returning id, status`;
    expect(legacy!.status).toBe("saved");
    expect(await usable("core.party", legacy!.id)).toBe(true);
  });

  it("the generic Grabar of a party runs the country pack: a format error is refused and nothing changes", async () => {
    const { id } = await runProcess(deps, admin, "core.party.create", { ...exito, documentNumber: "860000102" });
    const error = await runProcess(deps, admin, "core.party.save", { id, data: { document_number: "860.000.102" } }).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "invalid_input" });
    expect((await sql`select document_number from core.parties where id = ${id}`)[0]!.document_number).toBe("860000102");
  });

  it("the generic Grabar recomputes dian_status / dian_missing and invoice readiness, normalizes, and emits core.party.updated", async () => {
    const { id } = await runProcess(deps, admin, "core.party.create", { ...exito, documentNumber: "860000103" });
    await attachPartyFiles(id);
    expect(await readiness(id)).toBe(true);
    await runProcess(deps, admin, "core.party.save", { id, data: { address_line: null } });
    const [row] = await sql`select dian_status, dian_missing, invoice_ready, status from core.parties where id = ${id}`;
    expect(row).toMatchObject({ dian_status: "missing: 1", dian_missing: ["Dirección"], invoice_ready: false, status: "saved" });
    expect(await readiness(id)).toBe(false);
    expect(await outbox("core.party.updated", id)).toBe(1);

    // The pack's normalization reaches the row (the check digit follows the number).
    await runProcess(deps, admin, "core.party.save", { id, data: { address_line: "Calle 10 # 5-20", document_number: "890903938" } });
    const [after] = await sql`select dian_status, invoice_ready, check_digit from core.parties where id = ${id}`;
    expect(after).toMatchObject({ dian_status: "complete", invoice_ready: true, check_digit: "8" });
    expect(await outbox("core.party.updated", id)).toBe(2);
  });

  it("the generic Grabar refuses the columns the update process does not take (balance, derived DIAN data, readiness, check digit)", async () => {
    const { id } = await runProcess(deps, admin, "core.party.create", { ...exito, documentNumber: "860000120" });
    const before = (await sql`select balance, dian_status, check_digit, invoice_ready, updated_at from core.parties where id = ${id}`)[0];
    for (const data of [{ balance: 1000000 }, { dian_status: "complete" }, { dian_missing: [] }, { invoice_ready: true }, { check_digit: "0" }, { trade_name: "Éxito", balance: 5 }]) {
      const error = await runProcess(deps, admin, "core.party.save", { id, data }).catch((e: unknown) => e);
      expect(error, JSON.stringify(data)).toMatchObject({ code: "invalid_input" });
    }
    expect((await sql`select balance, dian_status, check_digit, invoice_ready, updated_at from core.parties where id = ${id}`)[0]).toEqual(before);
    const { id: productId } = await runProcess(deps, admin, "core.product.create", { ...cafe, sku: "TYP-KEYS" });
    for (const data of [{ dian_status: "complete" }, { dian_missing: [] }, { invoice_ready: true }, { tax_override: true }]) {
      await expect(runProcess(deps, admin, "core.product.save", { id: productId, data }), JSON.stringify(data)).rejects.toMatchObject({ code: "invalid_input" });
    }
  });

  it("the generic Grabar writes the text[] columns: a party's kinds and tax responsibilities, a product's other taxes", async () => {
    const { id } = await runProcess(deps, admin, "core.party.create", { ...exito, documentNumber: "860000121" });
    await runProcess(deps, admin, "core.party.save", { id, data: { kind: ["customer", "supplier"], tax_responsibilities: ["O-13", "O-15"], supplier_email: "p@e.co" } });
    expect((await sql`select kind, tax_responsibilities from core.parties where id = ${id}`)[0]).toEqual({ kind: ["customer", "supplier"], tax_responsibilities: ["O-13", "O-15"] });
    await expect(runProcess(deps, admin, "core.party.save", { id, data: { kind: ["customer", "socio"] } })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(runProcess(deps, admin, "core.party.save", { id, data: { kind: "customer" } })).rejects.toMatchObject({ code: "invalid_input" });
    const { id: productId } = await runProcess(deps, admin, "core.product.create", { ...cafe, sku: "TYP-ARR" });
    await runProcess(deps, admin, "core.product.save", { id: productId, data: { other_taxes: ["34"] } });
    expect((await sql`select other_taxes from core.products where id = ${productId}`)[0]!.other_taxes).toEqual(["34"]);
  });

  it("the generic Grabar refuses a duplicate document as invalid_input naming it", async () => {
    await runProcess(deps, admin, "core.party.create", { ...exito, documentNumber: "860000104" });
    const { id } = await runProcess(deps, admin, "core.party.create", { ...exito, documentNumber: "860000105" });
    const error = await runProcess(deps, admin, "core.party.save", { id, data: { document_number: "860000104" } }).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "invalid_input" });
    expect((error as { details: string[] }).details.join(" ")).toContain("860000104");
  });

  it("party scope: a customers-only role cannot Grabar or Eliminar a supplier, nor a party that is also a supplier", async () => {
    const provider = await runProcess(deps, admin, "core.party.create", supplier("860000106"));
    const dual = await runProcess(deps, admin, "core.party.create", { ...exito, kind: ["customer", "supplier"], documentNumber: "860000107", supplierEmail: "p@d.co" });
    const customer = await runProcess(deps, admin, "core.party.create", { ...exito, documentNumber: "860000108" });

    await expect(runProcess(deps, vendedor, "core.party.save", { id: provider.id, data: { legal_name: "Otro" } })).rejects.toMatchObject({ code: "not_found" });
    await expect(runProcess(deps, vendedor, "core.party.delete", { id: provider.id })).rejects.toMatchObject({ code: "not_found" });
    await expect(runProcess(deps, vendedor, "core.party.save", { id: dual.id, data: { legal_name: "Otro" } })).rejects.toMatchObject({ code: "forbidden" });
    await expect(runProcess(deps, vendedor, "core.party.delete", { id: dual.id })).rejects.toMatchObject({ code: "forbidden" });
    const rows = await sql`select legal_name, deleted_at from core.parties where id = any(${[provider.id, dual.id]}::uuid[])`;
    expect(rows.every((r) => r.deleted_at === null && r.legal_name !== "Otro")).toBe(true);

    // Its own customers it may save.
    await runProcess(deps, vendedor, "core.party.save", { id: customer.id, data: { trade_name: "Éxito Norte" } });
    expect((await sql`select trade_name from core.parties where id = ${customer.id}`)[0]!.trade_name).toBe("Éxito Norte");
  });

  it("Grabar does not deactivate a party: Activo = no goes through the sensitive core.party.deactivate", async () => {
    const { id } = await runProcess(deps, admin, "core.party.create", { ...exito, documentNumber: "860000109" });
    await expect(runProcess(deps, admin, "core.party.save", { id, data: { is_active: false } })).rejects.toMatchObject({ code: "invalid_input" });
    expect((await sql`select is_active from core.parties where id = ${id}`)[0]!.is_active).toBe(true);
    // Reactivating a deactivated party is an ordinary edit.
    await runProcess(deps, admin, "core.party.deactivate", { id });
    await runProcess(deps, admin, "core.party.save", { id, data: { is_active: true } });
    expect(await usable("core.party", id)).toBe(true);
  });

  it("with Requiere aprobación a new party is Pendiente de Aprobación and not invoice ready until approved (rule 10)", async () => {
    await requireApproval("core.party", true);
    try {
      const { id } = await runProcess(deps, admin, "core.party.create", { ...exito, documentNumber: "860000110" });
      await attachPartyFiles(id);
      const [row] = await sql`select status, requires_approval, invoice_ready from core.parties where id = ${id}`;
      // DIAN-complete and with its files: the stored flag is true, but the party is not usable yet.
      expect(row).toMatchObject({ status: "pending", requires_approval: true, invoice_ready: true });
      expect(await usable("core.party", id)).toBe(false);
      expect(await readiness(id)).toBe(false);
      await runProcess(deps, admin, "core.party.approve", { id });
      expect(await usable("core.party", id)).toBe(true);
      expect(await readiness(id)).toBe(true);

      // D10: changing the NIT of an approved party, through Grabar or through the update process, sends it back to approval.
      await runProcess(deps, admin, "core.party.update", { id, documentNumber: "860002964" });
      expect((await sql`select status from core.parties where id = ${id}`)[0]!.status).toBe("pending");
      expect(await readiness(id)).toBe(false);
      await runProcess(deps, admin, "core.party.approve", { id });
      // A change that is not approval-relevant keeps it approved.
      await runProcess(deps, admin, "core.party.update", { id, phone: "3001234567" });
      expect((await sql`select status from core.parties where id = ${id}`)[0]!.status).toBe("approved");
      // D10 compares after the pack normalized the record: the same NIT written with spaces is no change and keeps it approved.
      await runProcess(deps, admin, "core.party.save", { id, data: { document_number: " 860002964 " } });
      expect((await sql`select status, document_number from core.parties where id = ${id}`)[0]).toEqual({ status: "approved", document_number: "860002964" });
      await runProcess(deps, admin, "core.party.save", { id, data: { legal_name: "Supermercados Éxito S.A." } });
      expect((await sql`select status from core.parties where id = ${id}`)[0]!.status).toBe("pending");

      // No Aprobar, then the update process (an edit and Grabar) makes it Grabado again, ready to resubmit.
      await runProcess(deps, admin, "core.party.reject", { id, reason: "NIT por confirmar" });
      await runProcess(deps, admin, "core.party.update", { id, phone: "3007654321" });
      expect((await sql`select status from core.parties where id = ${id}`)[0]!.status).toBe("saved");
      expect(await usable("core.party", id)).toBe(false);
    } finally {
      await requireApproval("core.party", false);
    }
  });

  it("a product: Grabar runs the pack and recomputes dian_status; the update process emits once; a duplicate SKU is invalid_input", async () => {
    const { id } = await runProcess(deps, admin, "core.product.create", cafe);
    expect((await sql`select status from core.products where id = ${id}`)[0]!.status).toBe("saved");
    expect(await usable("core.product", id)).toBe(true);
    await expect(runProcess(deps, admin, "core.product.save", { id, data: { list_price: 0 } })).rejects.toMatchObject({ code: "invalid_input" });
    await runProcess(deps, admin, "core.product.save", { id, data: { standard_code: null } });
    const [row] = await sql`select dian_status, dian_missing, invoice_ready from core.products where id = ${id}`;
    expect(row).toMatchObject({ dian_status: "missing: 1", dian_missing: ["Código GTIN"], invoice_ready: false });
    expect(await outbox("core.product.updated", id)).toBe(1);
    await runProcess(deps, admin, "core.product.update", { id, standardCode: "7702001005000" });
    expect(await outbox("core.product.updated", id)).toBe(2);
    await runProcess(deps, admin, "core.product.create", { ...cafe, sku: "TYP-250" });
    const error = await runProcess(deps, admin, "core.product.save", { id, data: { sku: "TYP-250" } }).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "invalid_input" });
    expect((error as { details: string[] }).details.join(" ")).toContain("TYP-250");
    await expect(runProcess(deps, admin, "core.product.save", { id, data: { is_active: false } })).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("a product's Grabar to another category inherits its taxes; an inactive category cannot be assigned", async () => {
    const vinos = await runProcess(deps, admin, "core.category.create", { name: "Vinos", ivaRate: "19", otherTaxes: [], defaultUom: "94" });
    const cerrada = await runProcess(deps, admin, "core.category.create", { name: "Cerrada", ivaRate: "0", otherTaxes: [], defaultUom: "94", isActive: false });
    expect((await sql`select status, is_active from core.product_categories where id = ${cerrada.id}`)[0]).toMatchObject({ status: "saved", is_active: false });
    expect(await usable("core.product_category", cerrada.id)).toBe(false);
    const { id } = await runProcess(deps, admin, "core.product.create", { ...cafe, sku: "TYP-CAT" });
    await runProcess(deps, admin, "core.product.save", { id, data: { category_id: vinos.id } });
    expect((await sql`select iva_rate, tax_override, category_id from core.products where id = ${id}`)[0]).toMatchObject({ iva_rate: "19", tax_override: false, category_id: vinos.id });
    await expect(runProcess(deps, admin, "core.product.save", { id, data: { category_id: cerrada.id } })).rejects.toMatchObject({ code: "invalid_input" });
    expect((await sql`select category_id from core.products where id = ${id}`)[0]!.category_id).toBe(vinos.id);
  });

  it("a category: Activo is is_active, toggled by the update process; its Grabar refuses a duplicate name", async () => {
    const { id } = await runProcess(deps, admin, "core.category.create", { name: "Té", ivaRate: "5", otherTaxes: [] });
    expect((await sql`select status, is_active from core.product_categories where id = ${id}`)[0]).toMatchObject({ status: "saved", is_active: true });
    await runProcess(deps, admin, "core.category.update", { id, isActive: false });
    expect((await sql`select is_active from core.product_categories where id = ${id}`)[0]!.is_active).toBe(false);
    await runProcess(deps, admin, "core.product_category.save", { id, data: { is_active: true } });
    expect(await usable("core.product_category", id)).toBe(true);
    await runProcess(deps, admin, "core.category.create", { name: "Aromáticas", ivaRate: "5", otherTaxes: [] });
    await expect(runProcess(deps, admin, "core.product_category.save", { id, data: { name: "aromáticas" } })).rejects.toMatchObject({ code: "invalid_input" });
    // The old active / inactive input is gone (Activo is a boolean now).
    await expect(runProcess(deps, admin, "core.category.update", { id, status: "inactive" })).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("Eliminar: a referenced maestro is refused with the Activo = no hint; an unused one is soft-deleted and leaves the grids", async () => {
    const category = await runProcess(deps, admin, "core.category.create", { name: "Usada", ivaRate: "5", otherTaxes: [], defaultUom: "94" });
    const provider = await runProcess(deps, admin, "core.party.create", supplier("860000111"));
    await runProcess(deps, admin, "core.product.create", { ...cafe, sku: "TYP-REF", categoryId: category.id, supplierId: provider.id });
    for (const [process, id] of [["core.product_category.delete", category.id], ["core.party.delete", provider.id]] as const) {
      await expect(runProcess(deps, admin, process, { id })).rejects.toMatchObject({ code: "invalid_state", details: { reason: "referenced", messageKey: "errors.record_referenced" } });
    }
    const unused = await runProcess(deps, admin, "core.category.create", { name: "Sin uso", ivaRate: "5", otherTaxes: [] });
    await runProcess(deps, admin, "core.product_category.delete", { id: unused.id });
    expect((await sql`select deleted_at from core.product_categories where id = ${unused.id}`)[0]!.deleted_at).not.toBeNull();
    const visible = await withClaims(sql, admin.claims, (tx) => tx`select 1 from core.v_product_categories where id = ${unused.id}`);
    expect(visible).toHaveLength(0);
    expect(await usable("core.product_category", unused.id)).toBe(false);
    // A deleted party leaves the published views too, and its update process no longer finds it.
    const gone = await runProcess(deps, admin, "core.party.create", { ...exito, documentNumber: "860000112" });
    await runProcess(deps, admin, "core.party.delete", { id: gone.id });
    expect(await withClaims(sql, admin.claims, (tx) => tx`select 1 from core.v_parties where id = ${gone.id}`)).toHaveLength(0);
    expect(await withClaims(sql, admin.claims, (tx) => tx`select 1 from core.v_party_readiness where id = ${gone.id}`)).toHaveLength(0);
    await expect(runProcess(deps, admin, "core.party.update", { id: gone.id, phone: "3001234567" })).rejects.toMatchObject({ code: "not_found" });
  });

  it("a price list is a maestro too: Grabado on create, usable, deleted when unused", async () => {
    const [list] = await sql<{ id: string; status: string }[]>`insert into core.price_lists (company_id, name, currency_code) values (${h.companyId}, 'Mayoristas TYP', 'COP') returning id, status`;
    expect(list!.status).toBe("saved");
    expect(await usable("core.price_list", list!.id)).toBe(true);
    await runProcess(deps, admin, "core.price_list.save", { id: list!.id, data: { name: "Mayoristas 2027" } });
    expect((await sql`select name from core.price_lists where id = ${list!.id}`)[0]!.name).toBe("Mayoristas 2027");
    await runProcess(deps, admin, "core.price_list.delete", { id: list!.id });
    expect(await usable("core.price_list", list!.id)).toBe(false);
  });
});
