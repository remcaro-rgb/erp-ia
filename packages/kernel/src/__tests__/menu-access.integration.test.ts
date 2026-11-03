import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { withClaims } from "../db/client";
import { seedTenant, testDb } from "../db/test-db";
import { defineEntity, Registry } from "../registry";
import { defineModule } from "../module/define";
import { loadModules } from "../module/loader";
import { kernelModule } from "../module/kernel-module";
import { menuSections } from "../module/menu";
import { defineProcess } from "../process/define";
import type { ProcessError } from "../process/errors";
import { runProcess } from "../process/run";
import { runnableProcesses } from "../process/permissions";
import type { Caller } from "../process/context";
import { syncRegistry } from "../admin/sync";
import { menuHiddenKeys, menuPathAllowed } from "../typed/menu-access.processes";

// Menu access (entity types spec 2026-11-02 §2.4, §9.2, D7, D12; Phase 2A.5 Task 10): kernel.menu_access narrows which roles and users
// see a menu item, at any level. The shell drops a hidden item (kernel.menu_hidden_keys), a direct address to its screen gets the
// forbidden screen (kernel.menu_path_allowed, the proxy's guard) and the processes it lists are refused by runProcess with the very
// refusal of a missing role permission (kernel.can_run_process). No rules = everything allowed; rules only narrow and never apply to
// company admins. The fixture module `ma` is declared here; it needs no table (its processes are consults that read nothing).

const consult = (id: string) =>
  defineProcess({ id, module: "ma", kind: "consult", description: "Consulta de prueba", input: z.object({}), output: z.object({ ok: z.boolean() }), handler: async () => ({ ok: true }) });
const PROCESSES = ["ma.thing.list", "ma.report.balance", "ma.other.list"];

const thing = defineEntity({
  entityType: "maestro", id: "ma.thing", module: "ma", schema: "ma", table: "things", label: "entity.ma.thing",
  displayField: "name", defaultSort: { field: "name", dir: "asc" }, fields: [{ name: "name", type: "text", label: "field.ma.name" }],
});
const maModule = defineModule({
  id: "ma", version: "0.0.1", dependsOn: [],
  entities: [thing],
  processes: PROCESSES.map(consult),
  features: [{ id: "ma.main", label: "feature.ma.main", processes: PROCESSES, entities: ["ma.thing"] }],
  events: { emits: [], consumes: {} },
  navigation: [
    ...menuSections("ma", { reportes: [{ id: "ma.reports", label: "nav.ma.reports", href: "/ma/reports", icon: "list", feature: "ma.main", runs: ["ma.report."] }] }),
    { id: "ma.things", label: "nav.ma.things", href: "/ma/things", icon: "list", feature: "ma.main", entity: "ma.thing" },
  ],
});

describe("kernel.menu_access", () => {
  let sql: ReturnType<typeof testDb>;
  let seed: Awaited<ReturnType<typeof seedTenant>>;
  let registry: Registry;
  let companyId: string;
  let otherCompanyId: string;
  let contadorRoleId: string;
  let admin: Caller;
  let member: Caller;
  /** A member who also holds the role `contador`. */
  let contador: Caller;

  const stepUp = async (caller: Caller): Promise<Caller> => {
    const stepUpToken = randomUUID();
    await sql`insert into kernel.step_up_verifications(user_id, company_id, token) values (${caller.claims.sub}, ${caller.claims.active_company_id}, ${stepUpToken})`;
    return { ...caller, stepUpToken };
  };
  const SET = "kernel.menu_access.set";
  type Rule = { roleId?: string; userId?: string; allowed: boolean };
  const setRules = async (navKey: string, rules: Rule[], caller = admin) => runProcess({ sql, registry }, await stepUp(caller), SET, { navKey, rules });
  const refusal = (promise: Promise<unknown>) => promise.then(() => null, (error: ProcessError) => ({ code: error.code, message: error.message, details: error.details }));
  const run = (caller: Caller, processId: string) => runProcess({ sql, registry }, caller, processId, {});
  const hidden = async (caller: Caller) => [...(await menuHiddenKeys(sql, caller.claims))].sort();
  const memberRole = () => seed.companies[0]!.memberRoleId;

  beforeAll(async () => {
    sql = testDb();
    registry = new Registry();
    loadModules(registry, [kernelModule, maModule]);
    seed = await seedTenant(sql, {
      companies: 2,
      entitlements: ["module:ma"],
      users: [
        { name: "member", companies: [0, 1], role: "member" },
        { name: "contador", companies: [0], role: "member" },
      ],
    });
    companyId = seed.companies[0]!.id;
    otherCompanyId = seed.companies[1]!.id;
    await syncRegistry(sql, registry);
    for (const company of seed.companies) await sql`select kernel.seed_company_defaults(${company.id})`;
    const [role] = await sql<{ id: string }[]>`insert into kernel.roles(company_id, name, is_system) values (${companyId}, 'contador', false) returning id`;
    contadorRoleId = role!.id;
    await seed.holdRoles(seed.users.contador!, companyId, [contadorRoleId]);
    for (const company of seed.companies) {
      for (const process of PROCESSES) {
        await sql`insert into kernel.process_permissions(company_id, role_id, process_id) values (${company.id}, ${company.memberRoleId}, ${process}) on conflict do nothing`;
      }
    }
    for (const process of PROCESSES) await sql`insert into kernel.process_permissions(company_id, role_id, process_id) values (${companyId}, ${contadorRoleId}, ${process})`;
    admin = { claims: seed.claimsFor(seed.users.both, companyId), origin: "ui" };
    member = { claims: seed.claimsFor(seed.users.member!, companyId), origin: "ui" };
    const contadorClaims = seed.claimsFor(seed.users.contador!, companyId);
    contador = { claims: { ...contadorClaims, role_ids: [...contadorClaims.role_ids, contadorRoleId] }, origin: "ui" };
  });
  afterAll(async () => {
    await sql`delete from kernel.menu_access where company_id = any(${seed.companies.map((c) => c.id)}::uuid[])`;
    await sql`delete from kernel.menu_items where module_id = 'ma'`;
    await sql`delete from kernel.entity_fields where module_id = 'ma'`;
    await sql`delete from kernel.entity_tables where module_id = 'ma'`;
    await seed.cleanup();
    await sql.end();
  });

  it("the registry's menu items are synced with the processes each guards", async () => {
    const rows = await sql<{ nav_key: string; parent_key: string | null; href: string | null; entity: string | null; process_ids: string[] }[]>`
      select nav_key, parent_key, href, entity, process_ids from kernel.menu_items where module_id = 'ma' order by nav_key`;
    expect(rows.map((r) => r.nav_key)).toEqual(["ma.doc_templates", "ma.documentos", "ma.entity_types", "ma.maestros", "ma.parametros", "ma.reportes", "ma.reports", "ma.state_recipients", "ma.things"]);
    const things = rows.find((r) => r.nav_key === "ma.things")!;
    expect(things).toMatchObject({ parent_key: "ma.maestros", href: "/ma/things", entity: "ma.thing" });
    expect(things.process_ids).toContain("ma.thing.list");
    expect(things.process_ids).toContain("ma.thing.save");
    expect(rows.find((r) => r.nav_key === "ma.reports")).toMatchObject({ parent_key: "ma.reportes", process_ids: ["ma.report.balance"] });
  });

  it("kernel.menu_access.set is a step-up admin process: a member is forbidden", async () => {
    const [row] = await sql`select step_up, kind from kernel.registered_processes where process_id = ${SET}`;
    expect(row).toMatchObject({ step_up: true, kind: "update" });
    expect(await refusal(setRules("ma.things", [{ roleId: memberRole(), allowed: false }], member))).toMatchObject({ code: "forbidden" });
    expect(await sql`select 1 from kernel.menu_access where company_id = ${companyId}`).toHaveLength(0);
  });

  it("refuses an unknown menu item, a grantee of another company, a rule with two grantees and a grantee listed twice", async () => {
    expect(await refusal(setRules("ma.nope", []))).toMatchObject({ code: "invalid_input" });
    expect(await refusal(setRules("ma.things", [{ roleId: seed.companies[1]!.memberRoleId, allowed: false }]))).toMatchObject({ code: "invalid_input" });
    expect(await refusal(setRules("ma.things", [{ roleId: memberRole(), userId: seed.users.member!, allowed: false }]))).toMatchObject({ code: "invalid_input" });
    expect(await refusal(setRules("ma.things", [{ roleId: memberRole(), allowed: false }, { roleId: memberRole(), allowed: true }]))).toMatchObject({ code: "invalid_input" });
    expect(await sql`select 1 from kernel.menu_access where company_id = ${companyId}`).toHaveLength(0);
  });

  it("refuses an item the registry declares but kernel.menu_items does not hold yet: SQL could not see the rule (m4)", async () => {
    await sql`delete from kernel.menu_items where nav_key = 'ma.reports'`;
    try {
      expect(await refusal(setRules("ma.reports", [{ roleId: memberRole(), allowed: false }]))).toMatchObject({ code: "invalid_input" });
      expect(await sql`select 1 from kernel.menu_access where company_id = ${companyId}`).toHaveLength(0);
    } finally {
      await syncRegistry(sql, registry);
    }
  });

  it("without rules nothing is hidden, every address opens and every process runs", async () => {
    for (const caller of [admin, member, contador]) {
      expect(await hidden(caller)).toEqual([]);
      expect(await menuPathAllowed(sql, caller.claims, "/ma/things")).toBe(true);
      for (const process of PROCESSES) await expect(run(caller, process)).resolves.toEqual({ ok: true });
    }
  });

  it("a rule denying the member's role hides the item, its address and its processes for them, never for the admin", async () => {
    await setRules("ma.things", [{ roleId: memberRole(), allowed: false }]);
    try {
      expect(await hidden(member)).toEqual(["ma.things"]);
      for (const path of ["/ma/things", "/ma/things/123", `/r/ma.thing/${randomUUID()}`]) expect(await menuPathAllowed(sql, member.claims, path), path).toBe(false);
      for (const path of ["/ma/thingsx", "/ma/reports", "/"]) expect(await menuPathAllowed(sql, member.claims, path), path).toBe(true);
      // The very refusal of a missing role permission: same code, same message, no details (it reveals nothing more).
      const denied = await refusal(run(member, "ma.thing.list"));
      expect(denied).toEqual({ code: "forbidden", message: "no role of the caller may run ma.thing.list", details: undefined });
      await expect(run(member, "ma.other.list")).resolves.toEqual({ ok: true });
      expect([...(await runnableProcesses(sql, registry, member.claims, PROCESSES))].sort()).toEqual(["ma.other.list", "ma.report.balance"]);
      // The admin is never narrowed (D12); another role is not touched.
      expect(await hidden(admin)).toEqual([]);
      expect(await menuPathAllowed(sql, admin.claims, "/ma/things")).toBe(true);
      await expect(run(admin, "ma.thing.list")).resolves.toEqual({ ok: true });
      await expect(run(contador, "ma.thing.list")).rejects.toMatchObject({ code: "forbidden" });
    } finally {
      await setRules("ma.things", []);
    }
    // An empty set restores the item.
    expect(await hidden(member)).toEqual([]);
    await expect(run(member, "ma.thing.list")).resolves.toEqual({ ok: true });
  });

  it("an allowed rule makes an allow-list: only its grantees see the item, and it never grants a process their role lacks", async () => {
    await setRules("ma.reports", [{ roleId: contadorRoleId, allowed: true }]);
    try {
      expect(await hidden(member)).toEqual(["ma.reports"]);
      await expect(run(member, "ma.report.balance")).rejects.toMatchObject({ code: "forbidden" });
      expect(await menuPathAllowed(sql, member.claims, "/ma/reports")).toBe(false);
      expect(await hidden(contador)).toEqual([]);
      await expect(run(contador, "ma.report.balance")).resolves.toEqual({ ok: true });
      // allowed = true only narrows: without a role permission (neither of the contador's roles) the process stays refused.
      await sql`update kernel.process_permissions set allowed = false where company_id = ${companyId} and role_id = any(${[contadorRoleId, memberRole()]}::uuid[]) and process_id = 'ma.report.balance'`;
      await expect(run(contador, "ma.report.balance")).rejects.toMatchObject({ code: "forbidden" });
      expect(await runnableProcesses(sql, registry, contador.claims, ["ma.report.balance"])).toEqual(new Set());
    } finally {
      await sql`update kernel.process_permissions set allowed = true where company_id = ${companyId} and role_id = any(${[contadorRoleId, memberRole()]}::uuid[]) and process_id = 'ma.report.balance'`;
      await setRules("ma.reports", []);
    }
  });

  it("a user rule narrows that user only; a deny wins over an allow of another of their roles", async () => {
    await setRules("ma.things", [{ userId: seed.users.contador!, allowed: false }, { roleId: contadorRoleId, allowed: true }, { roleId: memberRole(), allowed: true }]);
    try {
      expect(await hidden(contador)).toEqual(["ma.things"]);
      await expect(run(contador, "ma.thing.list")).rejects.toMatchObject({ code: "forbidden" });
      expect(await hidden(member)).toEqual([]);
      await expect(run(member, "ma.thing.list")).resolves.toEqual({ ok: true });
    } finally {
      await setRules("ma.things", []);
    }
  });

  it("hiding a section hides every item under it, its addresses and its processes", async () => {
    await setRules("ma.maestros", [{ roleId: memberRole(), allowed: false }]);
    try {
      expect(await hidden(member)).toEqual(["ma.maestros", "ma.things"]);
      expect(await menuPathAllowed(sql, member.claims, "/ma/things")).toBe(false);
      await expect(run(member, "ma.thing.list")).rejects.toMatchObject({ code: "forbidden" });
      await expect(run(member, "ma.report.balance")).resolves.toEqual({ ok: true });
    } finally {
      await setRules("ma.maestros", []);
    }
  });

  it("rules belong to their company (tenant isolation under company switch)", async () => {
    await setRules("ma.things", [{ roleId: memberRole(), allowed: false }]);
    try {
      const elsewhere = { claims: seed.claimsFor(seed.users.member!, otherCompanyId), origin: "ui" as const };
      expect(await hidden(elsewhere)).toEqual([]);
      expect(await menuPathAllowed(sql, elsewhere.claims, "/ma/things")).toBe(true);
      await expect(run(elsewhere, "ma.thing.list")).resolves.toEqual({ ok: true });
      // A member reads no rule (admin only); the checks read them for them.
      expect(await withClaims(sql, member.claims, (tx) => tx`select 1 from kernel.menu_access`)).toHaveLength(0);
    } finally {
      await setRules("ma.things", []);
    }
  });

  it("rules are replaced, never edited; every change is in the audit log; a non-admin cannot write them directly", async () => {
    await setRules("ma.things", [{ roleId: memberRole(), allowed: false }]);
    try {
      await expect(sql`update kernel.menu_access set allowed = true where company_id = ${companyId}`).rejects.toThrow(/menu_access_immutable/);
      await setRules("ma.things", [{ roleId: contadorRoleId, allowed: true }]);
      const rows = await sql`select nav_key, grantee_role_id, grantee_user_id, allowed from kernel.menu_access where company_id = ${companyId}`;
      expect(rows).toEqual([{ nav_key: "ma.things", grantee_role_id: contadorRoleId, grantee_user_id: null, allowed: true }]);
      const [audit] = await sql`select input from kernel.audit_log where company_id = ${companyId} and process_id = ${SET} and action = 'update' order by occurred_at desc limit 1`;
      expect(audit?.input).toMatchObject({ navKey: "ma.things" });
      const rowAudit = await sql`select action from kernel.audit_log where company_id = ${companyId} and entity = 'kernel.menu_access'`;
      expect(rowAudit.map((r) => r.action)).toEqual(expect.arrayContaining(["insert", "delete"]));
      await expect(withClaims(sql, member.claims, (tx) => tx`
        insert into kernel.menu_access (company_id, nav_key, grantee_user_id, allowed) values (${companyId}, 'ma.things', ${seed.users.member!}, true)`)).rejects.toThrow();
    } finally {
      await setRules("ma.things", []);
    }
  });

  it("a rule goes with its role or user (on delete cascade)", async () => {
    const fks = await sql<{ conname: string; confdeltype: string }[]>`
      select conname, confdeltype from pg_constraint where conrelid = 'kernel.menu_access'::regclass and contype = 'f' and confrelid in ('kernel.roles'::regclass, 'kernel.users'::regclass)`;
    expect(fks).toHaveLength(2);
    for (const fk of fks) expect(fk.confdeltype, fk.conname).toBe("c");
  });
});
