import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runGridQuery, runProcess, type Caller } from "@erp/kernel";
import { coreHarness, type CoreHarness } from "./helpers";

// Every entity reference names its record (design §22.15, rule 21): a page of a grid or of the assistant's
// `kernel.data.query` carries `<field>_label`, the display field of the referenced record (a product's supplier by its
// legal name, its category by its name), read through the target's masked view as the caller. No label when the caller
// may not consult the target entity, does not see the record (party scope) or has its display field masked.

describe("reference labels of a grid page", () => {
  let h: CoreHarness;
  let member: Caller;
  let memberRole: string;
  let supplierId: string;
  let categoryId: string;

  beforeAll(async () => {
    h = await coreHarness({ users: [{ name: "member", companies: [0], role: "member" }] });
    member = { claims: h.seed.claimsFor(h.seed.users.member!, h.companyId), origin: "ui" };
    memberRole = h.seed.companies[0]!.memberRoleId;
    ({ id: supplierId } = await runProcess(h.deps, h.admin, "core.party.create", {
      kind: ["supplier"],
      personType: "1",
      documentType: "31",
      documentNumber: "900373115",
      legalName: "Café del Norte S.A.S.",
      supplierEmail: "compras@cafedelnorte.co",
    }));
    const [category] = await h.sql<{ id: string }[]>`
      insert into core.product_categories (company_id, name, iva_rate, default_uom) values (${h.companyId}, 'Café', '5', 'KGM') returning id`;
    categoryId = category!.id;
    await h.sql`
      insert into core.products ${h.sql({
        company_id: h.companyId,
        sku: "CAF-GRA-500",
        description: "Café en grano 500 g",
        kind: "good",
        id_scheme: "999",
        uom_code: "KGM",
        iva_rate: "5",
        list_price: 31000,
        track_stock: true,
        category_id: categoryId,
        supplier_id: supplierId,
        dian_status: "complete",
      })}`;
    await h.grantAll(h.companyId, memberRole, ["kernel.data.query", "core.product.consult"]);
  });
  afterAll(async () => {
    await h.cleanup();
  });

  const query = async (caller: Caller) =>
    ((await runProcess(h.deps, caller, "kernel.data.query", { entity: "core.product", columns: ["description", "supplier_id", "category_id"] })) as { rows: Record<string, unknown>[] }).rows[0]!;

  it("names the supplier and the category of a product for a caller who may consult them, in the grid and the assistant alike", async () => {
    const row = await query(h.admin);
    expect(row).toMatchObject({ supplier_id: supplierId, supplier_id_label: "Café del Norte S.A.S.", category_id: categoryId, category_id_label: "Café" });
    const grid = await runGridQuery(h.sql, h.admin.claims, h.deps.registry.entity("core.product"), { filters: [], sort: [], page: 1, pageSize: 10 }, { registry: h.deps.registry });
    expect(grid.rows[0]).toMatchObject({ supplier_id_label: "Café del Norte S.A.S.", category_id_label: "Café" });
    // Without the registry (an option list, a lookup's own read) the page has no labels.
    const plain = await runGridQuery(h.sql, h.admin.claims, h.deps.registry.entity("core.product"), { filters: [], sort: [], page: 1, pageSize: 10 });
    expect(plain.rows[0]).not.toHaveProperty("supplier_id_label");
  });

  it("gives no label of an entity the caller may not consult", async () => {
    const row = await query(member);
    expect(row.supplier_id).toBe(supplierId);
    expect(row).not.toHaveProperty("supplier_id_label");
    expect(row).not.toHaveProperty("category_id_label");
  });

  it("gives no label of a record outside the caller's party scope, nor of a masked display field", async () => {
    await h.grantAll(h.companyId, memberRole, ["core.party.consult", "core.category.consult"]);
    await h.sql`update kernel.roles set party_scope = 'ambos' where id = ${memberRole}`;
    expect(await query(member)).toMatchObject({ supplier_id_label: "Café del Norte S.A.S.", category_id_label: "Café" });

    await h.sql`update kernel.roles set party_scope = 'clientes' where id = ${memberRole}`;
    expect(await query(member)).not.toHaveProperty("supplier_id_label");

    await h.sql`update kernel.roles set party_scope = 'ambos' where id = ${memberRole}`;
    await h.sql`insert into kernel.field_permissions (company_id, role_id, entity, field, mode) values (${h.companyId}, ${memberRole}, 'core.party', 'legal_name', 'masked')`;
    const masked = await query(member);
    expect(masked).not.toHaveProperty("supplier_id_label");
    expect(masked.category_id_label).toBe("Café");
  });
});
