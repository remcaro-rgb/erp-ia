import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { runProcess, type Caller } from "@erp/kernel";
import { coreHarness, type CoreHarness } from "./helpers";

const product = (sku: string, extra: Record<string, unknown> = {}) => ({
  sku,
  description: `Producto ${sku}`,
  kind: "good",
  idScheme: "999",
  listPrice: 10000,
  isFreeSample: false,
  trackStock: true,
  ...extra,
});

describe("core product categories", () => {
  let h: CoreHarness;
  let sql: CoreHarness["sql"];
  let deps: CoreHarness["deps"];
  let admin: Caller;
  let cafeId: string;
  let bebidasId: string;

  beforeAll(async () => {
    h = await coreHarness();
    ({ sql, deps, admin } = h);
    cafeId = (await runProcess(deps, admin, "core.category.create", { name: "Café", ivaRate: "5", otherTaxes: [], defaultUom: "KGM", incomeAccount: "413524" })).id;
    bebidasId = (await runProcess(deps, admin, "core.category.create", { name: "Bebidas azucaradas", ivaRate: "19", incRate: "8", otherTaxes: ["34"], defaultUom: "94" })).id;
  });
  afterAll(async () => {
    await h.cleanup();
  });

  it("creates, consults and updates a category; the name is unique per company", async () => {
    const [row] = await sql`select seq, name, iva_rate, default_uom, income_account, status from core.product_categories where id = ${cafeId}`;
    expect(row).toMatchObject({ name: "Café", iva_rate: "5", default_uom: "KGM", income_account: "413524", status: "active" });
    expect(Number(row!.seq)).toBeGreaterThan(0);
    await expect(runProcess(deps, admin, "core.category.create", { name: "Café", ivaRate: "19" })).rejects.toMatchObject({ code: "invalid_input" });
    // Names are unique without regard to case, on create and on rename.
    await expect(runProcess(deps, admin, "core.category.create", { name: "CAFÉ", ivaRate: "19" })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(runProcess(deps, admin, "core.category.update", { id: bebidasId, name: "café" })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(runProcess(deps, admin, "core.category.create", { name: "Mala", ivaRate: "12" })).rejects.toMatchObject({ code: "invalid_input" });
    const seen = await runProcess(deps, admin, "core.category.consult", { id: bebidasId });
    expect(seen).toMatchObject({ id: bebidasId, name: "Bebidas azucaradas", inc_rate: "8", other_taxes: ["34"] });
  });

  it("product created with category Café inherits iva_rate 5 and tax_override false; setting ivaRate 19 stores tax_override true", async () => {
    const inherited = await runProcess(deps, admin, "core.product.create", product("CAT-1", { categoryId: cafeId }));
    const [a] = await sql`select iva_rate, inc_rate, other_taxes, uom_code, tax_override, category_id from core.products where id = ${inherited.id}`;
    expect(a).toMatchObject({ iva_rate: "5", inc_rate: null, other_taxes: [], uom_code: "KGM", tax_override: false, category_id: cafeId });
    const overridden = await runProcess(deps, admin, "core.product.create", product("CAT-2", { categoryId: cafeId, ivaRate: "19" }));
    const [b] = await sql`select iva_rate, tax_override from core.products where id = ${overridden.id}`;
    expect(b).toMatchObject({ iva_rate: "19", tax_override: true });
    // Restating the category's own rate is not an override.
    const same = await runProcess(deps, admin, "core.product.create", product("CAT-3", { categoryId: cafeId, ivaRate: "5" }));
    const [c] = await sql`select tax_override from core.products where id = ${same.id}`;
    expect(c!.tax_override).toBe(false);
  });

  it("changing the category without explicit taxes re-inherits; an explicit tax on update sets tax_override", async () => {
    const out = await runProcess(deps, admin, "core.product.create", product("CAT-4", { categoryId: cafeId, uomCode: "94" }));
    await runProcess(deps, admin, "core.product.update", { id: out.id, categoryId: bebidasId });
    const [moved] = await sql`select iva_rate, inc_rate, other_taxes, tax_override, uom_code from core.products where id = ${out.id}`;
    expect(moved).toMatchObject({ iva_rate: "19", inc_rate: "8", other_taxes: ["34"], tax_override: false, uom_code: "94" });
    await runProcess(deps, admin, "core.product.update", { id: out.id, incRate: null });
    const [noInc] = await sql`select inc_rate, tax_override from core.products where id = ${out.id}`;
    expect(noInc).toMatchObject({ inc_rate: null, tax_override: true });
    // Resetting to the category's taxes clears the flag.
    await runProcess(deps, admin, "core.product.update", { id: out.id, incRate: "8" });
    const [reset] = await sql`select tax_override from core.products where id = ${out.id}`;
    expect(reset!.tax_override).toBe(false);
  });

  it("changing a category never rewrites existing products; an inactive category cannot be assigned", async () => {
    const out = await runProcess(deps, admin, "core.product.create", product("CAT-5", { categoryId: cafeId }));
    await runProcess(deps, admin, "core.category.update", { id: cafeId, ivaRate: "19" });
    const [row] = await sql`select iva_rate from core.products where id = ${out.id}`;
    expect(row!.iva_rate).toBe("5");
    await runProcess(deps, admin, "core.category.update", { id: cafeId, ivaRate: "5", status: "inactive" });
    await expect(runProcess(deps, admin, "core.product.create", product("CAT-6", { categoryId: cafeId }))).rejects.toMatchObject({ code: "invalid_input" });
    await runProcess(deps, admin, "core.category.update", { id: cafeId, status: "active" });
  });
});
