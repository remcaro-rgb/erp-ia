import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withClaims } from "../../db/client";
import { seedTenant, testDb } from "../../db/test-db";
import { kernelModule } from "../../module/kernel-module";
import { loadModules } from "../../module/loader";
import type { Caller } from "../../process/context";
import { runProcess } from "../../process/run";
import { defineEntity, Registry } from "../../registry";
import { SAVED_VIEW_PROCESS_IDS } from "../index";

// Saved grid views (design §9, rule 20), migration 0013_kernel_saved_views: a user's named grid state per entity
// and company, one default per entity, written only through kernel.saved_view.save / delete (audited), read with
// kernel.saved_view.list; nobody sees anyone else's views, and a company's views stay in that company.

const probe = defineEntity({
  id: "kernel.view_probe",
  module: "kernel",
  schema: "kernel",
  table: "view_probe",
  label: "entity.kernel.view_probe",
  displayField: "name",
  defaultSort: { field: "name", dir: "asc" },
  fields: [{ name: "name", type: "text", label: "field.name" }],
});

const state = { filters: [{ field: "name", op: "contains", value: "café" }, { field: "name", op: "eq", value: "x", join: "or" }], sort: [{ field: "name", dir: "desc" }], pageSize: 25 };

describe("saved views", () => {
  let sql: ReturnType<typeof testDb>;
  let seed: Awaited<ReturnType<typeof seedTenant>>;
  let registry: Registry;
  let cashier: Caller;
  let other: Caller;
  let cashierB: Caller;
  const run = (caller: Caller, id: string, input: unknown) => runProcess({ sql, registry }, caller, id, input);
  const companyIds = () => seed.companies.map((c) => c.id);

  beforeAll(async () => {
    sql = testDb();
    seed = await seedTenant(sql, {
      companies: 2,
      users: [
        { name: "cashier", companies: [0, 1], role: "member" },
        { name: "other", companies: [0], role: "member" },
      ],
    });
    registry = new Registry();
    loadModules(registry, [kernelModule]);
    registry.registerEntity(probe);
    // Granted to every role (the member roles of both companies).
    for (const company of seed.companies) {
      for (const id of SAVED_VIEW_PROCESS_IDS) {
        await sql`insert into kernel.process_permissions(company_id, role_id, process_id) values (${company.id}, ${company.memberRoleId}, ${id})`;
      }
    }
    cashier = { claims: seed.claimsFor(seed.users.cashier!, seed.companies[0]!.id), origin: "ui" };
    cashierB = { claims: seed.claimsFor(seed.users.cashier!, seed.companies[1]!.id), origin: "ui" };
    other = { claims: seed.claimsFor(seed.users.other!, seed.companies[0]!.id), origin: "ui" };
  });
  afterAll(async () => {
    await sql`delete from kernel.saved_views where company_id = any(${companyIds()}::uuid[])`;
    await sql`delete from kernel.process_permissions where company_id = any(${companyIds()}::uuid[])`;
    await seed.cleanup();
    await sql.end();
  });

  it("saves a named view with its state, lists it back and audits the save", async () => {
    const chainId = crypto.randomUUID();
    const { id } = await run({ ...cashier, chainId }, "kernel.saved_view.save", { entity: probe.id, name: "Cafés", state });
    const views = await run(cashier, "kernel.saved_view.list", { entity: probe.id });
    expect(views).toEqual([{ id, entity: probe.id, name: "Cafés", state, isDefault: false }]);
    const audits = await sql`select process_id from kernel.audit_log where chain_id = ${chainId}`;
    expect(audits.map((a) => a.process_id)).toContain("kernel.saved_view.save");
  });

  it("keeps the grid's column order exactly as saved (design §22.12: the order is part of the view)", async () => {
    const columns = ["name", "municipality_code", "seq", "extra.ruta", "credit_limit"];
    await run(cashier, "kernel.saved_view.save", { entity: probe.id, name: "Orden", state: { columns } });
    const views = await run(cashier, "kernel.saved_view.list", { entity: probe.id });
    expect(views.find((v: { name: string }) => v.name === "Orden")!.state.columns).toEqual(columns);
  });

  it("saving the same name replaces the state; one default per entity", async () => {
    const first = await run(cashier, "kernel.saved_view.save", { entity: probe.id, name: "A", state: { pageSize: 10 }, isDefault: true });
    const again = await run(cashier, "kernel.saved_view.save", { entity: probe.id, name: "A", state: { pageSize: 50 }, isDefault: true });
    expect(again.id).toBe(first.id);
    await run(cashier, "kernel.saved_view.save", { entity: probe.id, name: "B", state: { pageSize: 100 }, isDefault: true });
    const views = await run(cashier, "kernel.saved_view.list", { entity: probe.id });
    expect(views.filter((v: { isDefault: boolean }) => v.isDefault).map((v: { name: string }) => v.name)).toEqual(["B"]);
    expect(views.find((v: { name: string }) => v.name === "A")).toMatchObject({ state: { pageSize: 50 }, isDefault: false });
  });

  it("another user sees none of them, and the views stay in their company", async () => {
    expect(await run(other, "kernel.saved_view.list", { entity: probe.id })).toEqual([]);
    expect(await run(cashierB, "kernel.saved_view.list", { entity: probe.id })).toEqual([]);
    const [mine] = await sql<{ id: string }[]>`select id from kernel.saved_views where user_id = ${seed.users.cashier!} limit 1`;
    await expect(run(other, "kernel.saved_view.delete", { id: mine!.id })).rejects.toMatchObject({ code: "not_found" });
    // Not even a direct read under RLS shows another user's rows.
    const rows = await withClaims(sql, other.claims, (tx) => tx`select id from kernel.saved_views`);
    expect(rows).toEqual([]);
  });

  it("refuses an unknown entity and a state that is not a grid state", async () => {
    await expect(run(cashier, "kernel.saved_view.save", { entity: "core.nope", name: "x", state: {} })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(run(cashier, "kernel.saved_view.save", { entity: probe.id, name: "x", state: { filters: [{ field: "name", op: "like" }] } })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(run(cashier, "kernel.saved_view.save", { entity: probe.id, name: "  ", state: {} })).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("writes only through the processes: a direct insert under the caller's claims is refused", async () => {
    await expect(
      withClaims(sql, cashier.claims, (tx) => tx`
        insert into kernel.saved_views (company_id, user_id, entity, name, state)
        values (${seed.companies[0]!.id}, ${seed.users.cashier!}, ${probe.id}, 'direct', '{}'::jsonb)`),
    ).rejects.toThrow(/row-level security/);
  });

  it("deletes a view of the caller; a role without the permission may not save", async () => {
    const { id } = await run(cashier, "kernel.saved_view.save", { entity: probe.id, name: "Borrar", state: {} });
    expect(await run(cashier, "kernel.saved_view.delete", { id })).toEqual({ id });
    const names = (await run(cashier, "kernel.saved_view.list", { entity: probe.id })).map((v: { name: string }) => v.name);
    expect(names).not.toContain("Borrar");
    await sql`delete from kernel.process_permissions where role_id = ${seed.companies[0]!.memberRoleId} and process_id = 'kernel.saved_view.save'`;
    await expect(run(other, "kernel.saved_view.save", { entity: probe.id, name: "No", state: {} })).rejects.toMatchObject({ code: "forbidden" });
  });
});
