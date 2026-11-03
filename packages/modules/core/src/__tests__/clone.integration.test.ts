import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { cloneDraft, ProcessError, runProcess, type Caller } from "@erp/kernel";
import { attachFile, coreHarness, exito, type CoreHarness } from "./helpers";

// Cloning (rule 37, design §22.13): "Duplicar" builds the create input from the source as the caller consults it, minus
// the entity's unique and identity fields (`cloneReset`), runs the entity's own create process with `sourceRowId`, and
// the creation's audit entries record the source. Contacts and files are children of the source and never copied.

describe("core cloning", () => {
  let h: CoreHarness;
  let sql: CoreHarness["sql"];
  let deps: CoreHarness["deps"];
  let admin: Caller;
  let member: Caller;
  let sourceId: string;

  const consult = (caller: Caller, process: string, id: string) => runProcess(deps, caller, process, { id }) as Promise<Record<string, unknown>>;

  beforeAll(async () => {
    h = await coreHarness({ users: [{ name: "vendedor", companies: [0], role: "member" }] });
    ({ sql, deps, admin } = h);
    const company = h.seed.companies[0]!;
    await h.grantAll(company.id, company.memberRoleId, ["core.party.create", "core.party.consult"]);
    await sql`insert into kernel.field_permissions(company_id, role_id, entity, field, mode)
              values (${company.id}, ${company.memberRoleId}, 'core.party', 'credit_limit', 'masked')`;
    member = { claims: h.seed.claimsFor(h.seed.users.vendedor!, h.companyId), origin: "ui" };

    sourceId = (await runProcess(deps, admin, "core.party.create", { ...exito, documentNumber: "890900608", legalName: "Almacenes Éxito S.A.", creditLimit: 250_000_000 })).id;
    await runProcess(deps, admin, "core.contact.create", { partyId: sourceId, name: "Ana Gómez", email: "ana@exito.com" });
    await attachFile(sql, { tenantId: h.seed.tenantId, companyId: h.companyId, entity: "core.party", recordId: sourceId, tag: "RUT" });
  });
  afterAll(async () => {
    await h.cleanup();
  });

  it("each entity declares the fields a clone clears", () => {
    expect(deps.registry.entity("core.party").cloneReset).toEqual(["document_number", "check_digit", "seq", "dian_status", "invoice_ready"]);
    expect(deps.registry.entity("core.product").cloneReset).toEqual(["sku", "seq"]);
    expect(deps.registry.entity("core.product_category").cloneReset).toEqual(["name"]);
    expect(deps.registry.entity("core.party_contact").cloneReset ?? []).toEqual([]);
  });

  it("clones a party: document fields empty, refused until a new NIT is typed, the audit records the source", async () => {
    const draft = cloneDraft(deps.registry, "core.party", await consult(admin, "core.party.consult", sourceId));
    expect(draft).not.toHaveProperty("documentNumber");
    expect(draft).not.toHaveProperty("checkDigit");
    expect(draft).toMatchObject({ kind: ["customer"], personType: "1", documentType: "31", legalName: "Almacenes Éxito S.A.", invoiceEmail: "fe@exito.com", creditLimit: 250_000_000 });

    // The create process refuses the copy as it is: the NIT is required, exactly as for a hand-typed party.
    const refused = await runProcess(deps, admin, "core.party.create", draft, { sourceRowId: sourceId }).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(ProcessError);
    expect(refused).toMatchObject({ code: "invalid_input" });
    expect((refused as ProcessError).details as { path: string[] }[]).toEqual(expect.arrayContaining([expect.objectContaining({ path: ["documentNumber"] })]));
    // Typing the source's own NIT back is the duplicate refusal of any party.
    const duplicate = await runProcess(deps, admin, "core.party.create", { ...draft, documentNumber: "890900608" }, { sourceRowId: sourceId }).catch((e: unknown) => e);
    expect(duplicate).toMatchObject({ code: "invalid_input" });

    const { id } = await runProcess(deps, admin, "core.party.create", { ...draft, documentNumber: "860002964" }, { sourceRowId: sourceId });
    expect(id).not.toBe(sourceId);
    const [source, clone] = await Promise.all(
      [sourceId, id].map(async (rowId) => (await sql`select seq, document_number, check_digit, legal_name, credit_limit from core.parties where id = ${rowId}`)[0]!),
    );
    expect(clone).toMatchObject({ document_number: "860002964", check_digit: "4", legal_name: "Almacenes Éxito S.A.", credit_limit: source!.credit_limit });
    expect(clone!.seq).not.toBe(source!.seq);

    // Contacts and files stay with the source.
    expect((await sql`select 1 from core.party_contacts where party_id = ${id}`).length).toBe(0);
    expect((await sql`select 1 from core.party_contacts where party_id = ${sourceId}`).length).toBe(1);
    expect((await sql`select 1 from kernel.attachments where record_id = ${id}`).length).toBe(0);

    const audit = await sql<{ source_row_id: string | null; process_id: string }[]>`
      select source_row_id, process_id from kernel.audit_log where row_id = ${id} and action = 'insert'`;
    expect(audit.length).toBeGreaterThan(0);
    expect(audit.every((r) => r.source_row_id === sourceId && r.process_id === "core.party.create")).toBe(true);
  });

  it("a viewer who sees the credit limit masked clones without it", async () => {
    const seen = await consult(member, "core.party.consult", sourceId);
    expect(seen.credit_limit).toBeNull();
    const draft = cloneDraft(deps.registry, "core.party", seen);
    expect(draft).not.toHaveProperty("creditLimit");
    const { id } = await runProcess(deps, member, "core.party.create", { ...draft, documentNumber: "800197268" }, { sourceRowId: sourceId });
    const [row] = await sql`select credit_limit from core.parties where id = ${id}`;
    expect(Number(row!.credit_limit ?? 0)).toBe(0);
  });

  it("clones a product with the sku empty and a category with the name empty", async () => {
    const { id: categoryId } = await runProcess(deps, admin, "core.category.create", { name: "Café", ivaRate: "5", otherTaxes: [], defaultUom: "94", isActive: true });
    const { id: productId } = await runProcess(deps, admin, "core.product.create", {
      sku: "CAF-500",
      description: "Café tostado molido 500 g",
      kind: "good",
      idScheme: "999",
      uomCode: "94",
      ivaRate: "5",
      otherTaxes: [],
      listPrice: 28500,
      isFreeSample: false,
      standardCost: 16200,
      trackStock: true,
      minStock: 5,
      categoryId,
    });
    const draft = cloneDraft(deps.registry, "core.product", await consult(admin, "core.product.consult", productId));
    expect(draft).not.toHaveProperty("sku");
    expect(draft).toMatchObject({ description: "Café tostado molido 500 g", listPrice: 28500, standardCost: 16200, minStock: 5, trackStock: true, categoryId });
    await expect(runProcess(deps, admin, "core.product.create", draft, { sourceRowId: productId })).rejects.toMatchObject({ code: "invalid_input" });
    const { id } = await runProcess(deps, admin, "core.product.create", { ...draft, sku: "CAF-250" }, { sourceRowId: productId });
    const [row] = await sql`select sku, description, list_price, category_id from core.products where id = ${id}`;
    expect(row).toMatchObject({ sku: "CAF-250", description: "Café tostado molido 500 g", category_id: categoryId });
    expect(Number(row!.list_price)).toBe(28500);
    const [entry] = await sql`select source_row_id from kernel.audit_log where row_id = ${id} and action = 'insert' and diff is null`;
    expect(entry!.source_row_id).toBe(productId);

    const category = cloneDraft(deps.registry, "core.product_category", await consult(admin, "core.category.consult", categoryId));
    expect(category).not.toHaveProperty("name");
    expect(category).toMatchObject({ ivaRate: "5", isActive: true });
    const { id: copy } = await runProcess(deps, admin, "core.category.create", { ...category, name: "Café especial" }, { sourceRowId: categoryId });
    const [stored] = await sql`select name, iva_rate, default_uom from core.product_categories where id = ${copy}`;
    expect(stored).toMatchObject({ name: "Café especial", iva_rate: "5", default_uom: "94" });
  });
});
