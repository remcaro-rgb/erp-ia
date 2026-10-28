import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { runProcess, type Caller } from "@erp/kernel";
import { coreHarness, supplier, type CoreHarness } from "./helpers";

const cafe = {
  sku: "CAF-500",
  description: "Café tostado molido 500 g",
  kind: "good",
  idScheme: "010",
  standardCode: "7702001005000",
  uomCode: "94",
  ivaRate: "5",
  otherTaxes: [],
  listPrice: 28500,
  isFreeSample: false,
  standardCost: 16200,
  trackStock: true,
};

describe("core products", () => {
  let h: CoreHarness;
  let sql: CoreHarness["sql"];
  let deps: CoreHarness["deps"];
  let admin: Caller;

  beforeAll(async () => {
    h = await coreHarness({ companies: 2 });
    ({ sql, deps, admin } = h);
  });
  afterAll(async () => {
    await h.cleanup();
  });

  it("creates a product with a GTIN and stores dian_status complete; rejects price 0 without free-sample flag", async () => {
    const out = await runProcess(deps, admin, "core.product.create", cafe);
    const [row] = await sql`select standard_code, dian_status, invoice_ready, tax_override from core.products where id = ${out.id}`;
    expect(row).toMatchObject({ standard_code: "07702001005000", dian_status: "complete", invoice_ready: true, tax_override: false });
    expect((await sql`select 1 from kernel.outbox where event = 'core.product.created' and payload->>'id' = ${out.id}`).length).toBe(1);
    await expect(
      runProcess(deps, admin, "core.product.create", { sku: "X", description: "x", kind: "good", idScheme: "999", uomCode: "94", ivaRate: "19", otherTaxes: [], listPrice: 0, isFreeSample: false, trackStock: true }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("a missing GTIN sets dian_status, a duplicate sku is invalid_input", async () => {
    const out = await runProcess(deps, admin, "core.product.create", { ...cafe, sku: "CAF-250", standardCode: undefined });
    const [row] = await sql`select dian_status, dian_missing, invoice_ready from core.products where id = ${out.id}`;
    expect(row).toMatchObject({ dian_status: "missing: 1", dian_missing: ["Código GTIN"], invoice_ready: false });
    const error = await runProcess(deps, admin, "core.product.create", { ...cafe, sku: "CAF-250" }).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "invalid_input" });
    expect((error as { details: string[] }).details.join(" ")).toContain("CAF-250");
  });

  it("without a category the IVA rate is required", async () => {
    await expect(runProcess(deps, admin, "core.product.create", { ...cafe, sku: "SIN-IVA", ivaRate: undefined })).rejects.toMatchObject({
      code: "invalid_input",
    });
  });

  it("update re-validates, keeps seq and emits core.product.updated; deactivate clears invoice_ready", async () => {
    const out = await runProcess(deps, admin, "core.product.create", { ...cafe, sku: "CAF-1000" });
    const [before] = await sql`select seq from core.products where id = ${out.id}`;
    await runProcess(deps, admin, "core.product.update", { id: out.id, listPrice: 52000, brand: "Café del Norte" });
    const [after] = await sql`select seq, list_price, brand, dian_status from core.products where id = ${out.id}`;
    expect(after).toMatchObject({ seq: before!.seq, brand: "Café del Norte", dian_status: "complete" });
    expect(Number(after!.list_price)).toBe(52000);
    expect((await sql`select 1 from kernel.outbox where event = 'core.product.updated' and payload->>'id' = ${out.id}`).length).toBe(1);
    await expect(runProcess(deps, admin, "core.product.update", { id: out.id, listPrice: -1 })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(runProcess(deps, admin, "core.product.update", { id: out.id, sku: "CAF-500" })).rejects.toMatchObject({ code: "invalid_input" });
    await runProcess(deps, admin, "core.product.deactivate", { id: out.id });
    const [inactive] = await sql`select is_active, invoice_ready from core.products where id = ${out.id}`;
    expect(inactive).toMatchObject({ is_active: false, invoice_ready: false });
  });

  it("consult reads the masked view", async () => {
    const out = await runProcess(deps, admin, "core.product.create", { ...cafe, sku: "CAF-2000" });
    const company = h.seed.companies[0]!;
    // A plain role (the company admin sees every field, 0021).
    await h.grantAll(company.id, company.memberRoleId, ["core.product.consult"]);
    await sql`insert into kernel.field_permissions(company_id, role_id, entity, field, mode)
              values (${company.id}, ${company.memberRoleId}, 'core.product', 'standard_cost', 'masked')`;
    const reader: Caller = { claims: { ...admin.claims, role_ids: [company.memberRoleId] }, origin: "ui" };
    const seen = await runProcess(deps, reader, "core.product.consult", { id: out.id });
    expect(seen).toMatchObject({ id: out.id, sku: "CAF-2000", standard_cost: null });
    await sql`delete from kernel.field_permissions where company_id = ${company.id}`;
    await expect(runProcess(deps, admin, "core.product.consult", { id: "00000000-0000-7000-8000-000000000000" })).rejects.toMatchObject({ code: "not_found" });
  });

  it("the supplier must be a party of the same company", async () => {
    const own = await runProcess(deps, admin, "core.party.create", supplier("830000010"));
    const out = await runProcess(deps, admin, "core.product.create", { ...cafe, sku: "CAF-SUP", supplierId: own.id });
    const [row] = await sql`select supplier_id from core.products where id = ${out.id}`;
    expect(row!.supplier_id).toBe(own.id);
    const other: Caller = { claims: h.seed.claimsFor(h.seed.users.both, h.seed.companies[1]!.id), origin: "ui" };
    const foreign = await runProcess(deps, other, "core.party.create", supplier("830000011"));
    await expect(runProcess(deps, admin, "core.product.create", { ...cafe, sku: "CAF-FOR", supplierId: foreign.id })).rejects.toMatchObject({
      code: "invalid_input",
    });
    // The supplier is looked up through core.v_parties, so a role that does not see suppliers cannot pick one.
    const company = h.seed.companies[0]!;
    await sql`update kernel.roles set party_scope = 'clientes' where id = ${company.adminRoleId}`;
    try {
      await expect(runProcess(deps, admin, "core.product.create", { ...cafe, sku: "CAF-SCO", supplierId: own.id })).rejects.toMatchObject({
        code: "invalid_input",
      });
    } finally {
      await sql`update kernel.roles set party_scope = 'ambos' where id = ${company.adminRoleId}`;
    }
  });
});
