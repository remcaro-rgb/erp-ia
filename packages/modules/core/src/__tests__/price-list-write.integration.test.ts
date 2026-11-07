import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { runProcess, type Caller } from "@erp/kernel";
import { withClaims } from "@erp/kernel/testing";
import { coreHarness, type CoreHarness } from "./helpers";

// Price list processes (plan 2B Task 51, item 55): core.price_list.create, core.price_list_item.set and core.price_list_item.remove.
// The generic Grabar (core.price_list.save) edits the name and currency of an existing list; item.set is the only item write.

const cafe = {
  sku: "PL-CAF-500",
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

describe("core price list processes", () => {
  let h: CoreHarness;
  let sql: CoreHarness["sql"];
  let deps: CoreHarness["deps"];
  let admin: Caller;
  let clerk: Caller;
  let productId: string;

  beforeAll(async () => {
    h = await coreHarness({ users: [{ name: "clerk", companies: [0], role: "member" }] });
    ({ sql, deps, admin } = h);
    clerk = { claims: h.seed.claimsFor(h.seed.users.clerk!, h.companyId), origin: "ui" };
    productId = (await runProcess(deps, admin, "core.product.create", cafe)).id;
  });
  afterAll(async () => {
    await h.cleanup();
  });

  const create = (name: string, currencyCode = "COP") => runProcess(deps, admin, "core.price_list.create", { name, currencyCode });
  const items = (listId: string) => sql`select product_id, price::text as price, seq from core.price_list_items where price_list_id = ${listId}`;

  it("create writes a Grabado, usable, active list with its seq and an audit row", async () => {
    const out = await create("Mayoristas");
    const [row] = await sql`select name, currency_code, status, requires_approval, is_active, seq from core.price_lists where id = ${out.id}`;
    expect(row).toMatchObject({ name: "Mayoristas", currency_code: "COP", status: "saved", requires_approval: false, is_active: true });
    expect(Number(row!.seq)).toBeGreaterThan(0);
    const [usable] = await withClaims(sql, admin.claims, (tx) => tx<{ ok: boolean }[]>`select kernel.record_usable('core.price_list', ${out.id}::uuid) as ok`);
    expect(usable!.ok).toBe(true);
    const audit = await sql`select action, process_id, origin from kernel.audit_log where row_id = ${out.id} and process_id = 'core.price_list.create'`;
    expect(audit.length).toBeGreaterThan(0);
  });

  it("create follows the company's approval setting: Pendiente de Aprobación when the entity requires it", async () => {
    await sql`insert into kernel.entity_type_settings (company_id, entity, requires_approval) values (${h.companyId}, 'core.price_list', true)
              on conflict (company_id, entity) do update set requires_approval = true`;
    try {
      const out = await create("Con aprobación");
      expect((await sql`select status, requires_approval from core.price_lists where id = ${out.id}`)[0]).toMatchObject({ status: "pending", requires_approval: true });
    } finally {
      await sql`delete from kernel.entity_type_settings where company_id = ${h.companyId} and entity = 'core.price_list'`;
    }
  });

  it("create refuses a duplicate name, a bad or unknown currency and an empty name as invalid_input", async () => {
    await create("Distribuidores");
    const dup = await create("Distribuidores").catch((e: unknown) => e);
    expect(dup).toMatchObject({ code: "invalid_input" });
    expect((dup as { details: string[] }).details.join(" ")).toContain("Distribuidores");
    await expect(create("Moneda mala", "cop")).rejects.toMatchObject({ code: "invalid_input" });
    await expect(create("Moneda rara", "ZZZ")).rejects.toMatchObject({ code: "invalid_input" });
    await expect(create("   ")).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("the generic Grabar still edits the name of an existing list (no update process)", async () => {
    const out = await create("Nombre viejo");
    await runProcess(deps, admin, "core.price_list.save", { id: out.id, data: { name: "Nombre nuevo" } });
    expect((await sql`select name from core.price_lists where id = ${out.id}`)[0]!.name).toBe("Nombre nuevo");
  });

  it("item.set inserts, then updates the price of the same product; audit keeps before and after", async () => {
    const list = await create("Lista de ítems");
    const first = await runProcess(deps, admin, "core.price_list_item.set", { priceListId: list.id, productId, price: 25650 });
    expect(await items(list.id)).toMatchObject([{ product_id: productId, price: "25650.0000" }]);
    const second = await runProcess(deps, admin, "core.price_list_item.set", { priceListId: list.id, productId, price: 25000.5 });
    expect(second.id).toBe(first.id);
    const stored = await items(list.id);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ price: "25000.5000" });
    const audit = await sql`select action, diff from kernel.audit_log where row_id = ${first.id} order by occurred_at, id`;
    expect(audit.map((a) => a.action)).toEqual(expect.arrayContaining(["insert", "update"]));
    const update = audit.find((a) => a.action === "update" && a.diff?.price);
    expect(Number(update!.diff.price.old)).toBe(25650);
    expect(Number(update!.diff.price.new)).toBe(25000.5);
  });

  it("item.set refuses a negative price, more than two decimals and a price on a missing list or product", async () => {
    const list = await create("Lista de errores");
    for (const price of [-1, 10.123]) {
      await expect(runProcess(deps, admin, "core.price_list_item.set", { priceListId: list.id, productId, price })).rejects.toMatchObject({ code: "invalid_input" });
    }
    const missing = "01900000-0000-7000-8000-000000000000";
    await expect(runProcess(deps, admin, "core.price_list_item.set", { priceListId: missing, productId, price: 1 })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(runProcess(deps, admin, "core.price_list_item.set", { priceListId: list.id, productId: missing, price: 1 })).rejects.toMatchObject({ code: "invalid_input" });
    expect(await items(list.id)).toHaveLength(0);
  });

  it("item.set refuses a product that is not usable (inactive) and a list that is not writable (inactive, deleted, pending approval)", async () => {
    const list = await create("Lista no escribible");
    const idle = (await runProcess(deps, admin, "core.product.create", { ...cafe, sku: "PL-INACTIVO" })).id;
    await runProcess(deps, admin, "core.product.deactivate", { id: idle });
    await expect(runProcess(deps, admin, "core.price_list_item.set", { priceListId: list.id, productId: idle, price: 100 })).rejects.toMatchObject({ code: "invalid_input" });

    await sql`update core.price_lists set is_active = false where id = ${list.id}`;
    await expect(runProcess(deps, admin, "core.price_list_item.set", { priceListId: list.id, productId, price: 100 })).rejects.toMatchObject({ code: "invalid_input" });
    await sql`update core.price_lists set is_active = true, status = 'pending', requires_approval = true where id = ${list.id}`;
    await expect(runProcess(deps, admin, "core.price_list_item.set", { priceListId: list.id, productId, price: 100 })).rejects.toMatchObject({ code: "invalid_input" });
    await sql`update core.price_lists set status = 'saved', requires_approval = false, deleted_at = now() where id = ${list.id}`;
    await expect(runProcess(deps, admin, "core.price_list_item.set", { priceListId: list.id, productId, price: 100 })).rejects.toMatchObject({ code: "invalid_input" });
    expect(await items(list.id)).toHaveLength(0);
  });

  it("item.remove deletes the item, audits it, and refuses an unknown one", async () => {
    const list = await create("Lista para quitar");
    const set = await runProcess(deps, admin, "core.price_list_item.set", { priceListId: list.id, productId, price: 100 });
    await runProcess(deps, admin, "core.price_list_item.remove", { priceListId: list.id, productId });
    expect(await items(list.id)).toHaveLength(0);
    const audit = await sql`select action from kernel.audit_log where row_id = ${set.id} and process_id = 'core.price_list_item.remove'`;
    expect(audit.length).toBeGreaterThan(0);
    await expect(runProcess(deps, admin, "core.price_list_item.remove", { priceListId: list.id, productId })).rejects.toMatchObject({ code: "not_found" });
  });

  it("a role without the process is denied; each process is granted on its own", async () => {
    const list = await create("Lista de permisos");
    const company = h.seed.companies[0]!;
    for (const [id, input] of [
      ["core.price_list.create", { name: "Negada", currencyCode: "COP" }],
      ["core.price_list_item.set", { priceListId: list.id, productId, price: 1 }],
      ["core.price_list_item.remove", { priceListId: list.id, productId }],
    ] as const) {
      await expect(runProcess(deps, clerk, id, input)).rejects.toMatchObject({ code: "forbidden" });
    }
    await h.grantAll(company.id, company.memberRoleId, ["core.price_list_item.set"]);
    await runProcess(deps, clerk, "core.price_list_item.set", { priceListId: list.id, productId, price: 1 });
    await expect(runProcess(deps, clerk, "core.price_list_item.remove", { priceListId: list.id, productId })).rejects.toMatchObject({ code: "forbidden" });
    await expect(runProcess(deps, clerk, "core.price_list.create", { name: "Negada", currencyCode: "COP" })).rejects.toMatchObject({ code: "forbidden" });
  });

  it("the processes are registered in the products feature, are not sensitive and not restricted to one origin", () => {
    for (const id of ["core.price_list.create", "core.price_list_item.set", "core.price_list_item.remove"]) {
      const def = deps.registry.process(id);
      expect(def.feature).toBe("core.products");
      expect(def.sensitivity ?? "normal").toBe("normal");
      expect(def.origins).toBeUndefined();
    }
  });
});
