import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { z } from "zod";
import { withClaims, type JwtClaims } from "../db/client";
import { seedTenant, testDb } from "../db/test-db";
import { enableModule, entitled, entitlementLimit, syncModuleManifest } from "../entitlements/resolver";
import { defineModule, type ModuleDef } from "../module/define";
import { loadModules } from "../module/loader";
import { defineProcess } from "../process/define";
import { runProcess } from "../process/run";
import { defineEntity, Registry } from "../registry";

const proc = (id: string) => {
  const [module] = id.split(".") as [string];
  return defineProcess({
    id,
    module,
    kind: "consult",
    description: "prueba",
    input: z.object({}),
    output: z.object({}),
    handler: async () => ({}),
  });
};

const party = defineEntity({
  id: "core.party",
  module: "core",
  schema: "core",
  table: "parties",
  label: "entity.core.party",
  displayField: "name",
  defaultSort: { field: "name", dir: "asc" },
  fields: [{ name: "name", type: "text", label: "field.name" }],
});

const base = { version: "1", events: { emits: [], consumes: {} }, navigation: [] };
const core: ModuleDef = defineModule({
  ...base,
  id: "core",
  dependsOn: [],
  entities: [party],
  processes: [proc("core.party.create"), proc("core.report.run"), proc("core.admin.setup")],
  features: [
    { id: "core.parties", label: "feature.parties", processes: ["core.party.create"], entities: ["core.party"] },
    { id: "core.reports", label: "feature.reports", processes: ["core.report.run"], entities: [] },
  ],
});
const support: ModuleDef = defineModule({
  ...base,
  id: "support",
  dependsOn: ["core"],
  entities: [],
  processes: [proc("support.ticket.create")],
  features: [{ id: "support.tickets", label: "feature.tickets", processes: ["support.ticket.create"], entities: [] }],
});
const probeModule: ModuleDef = defineModule({
  ...base,
  id: "test",
  dependsOn: [],
  entities: [],
  processes: [proc("test.probe.create")],
  features: [],
});

// Audit rows are append-only, so this suite never deletes them: every run seeds its own tenants.
describe("entitlements", () => {
  let sql: ReturnType<typeof testDb>;
  let registry: Registry;
  let seed: Awaited<ReturnType<typeof seedTenant>>;
  let other: Awaited<ReturnType<typeof seedTenant>>;
  let tenantId: string;
  let companyId: string;
  let companyB: string;
  let adminClaims: JwtClaims;
  let cashierClaims: JwtClaims;

  const entitle = (key: string, opts: { enabled?: boolean; from?: string; to?: string | null; company?: string | null; limit?: number | null } = {}) =>
    sql`insert into kernel.tenant_entitlements(tenant_id, company_id, key, enabled, limit_value, valid_from, valid_to, source)
        values (${tenantId}, ${opts.company ?? null}, ${key}, ${opts.enabled ?? true}, ${opts.limit ?? null},
                ${opts.from ?? sql`current_date`}, ${opts.to ?? null}, 'manual')`;

  beforeAll(async () => {
    sql = testDb();
    registry = new Registry();
    loadModules(registry, [support, probeModule, core]);
    for (const def of registry.modules()) await syncModuleManifest(sql, def);
    seed = await seedTenant(sql, {
      companies: 2,
      entitlements: [],
      users: [{ name: "cashier", companies: [0], role: "member" }],
    });
    other = await seedTenant(sql, { companies: 1, entitlements: [] });
    tenantId = seed.tenantId;
    companyId = seed.companies[0]!.id;
    companyB = seed.companies[1]!.id;
    adminClaims = seed.claimsFor(seed.users.both, companyId);
    cashierClaims = seed.claimsFor(seed.users.cashier!, companyId);
  });
  afterEach(async () => {
    for (const s of [seed, other]) {
      await sql`delete from kernel.tenant_entitlements where tenant_id = ${s.tenantId}`;
      await sql`delete from kernel.company_modules where company_id = any(${s.companies.map((c) => c.id)}::uuid[])`;
    }
  });
  afterAll(async () => {
    await sql`delete from kernel.process_permissions where company_id = ${companyId}`;
    await seed.cleanup();
    await other.cleanup();
    await sql.end();
  });

  it("process key resolves through feature and module", async () => {
    await entitle("module:core");
    expect(await entitled(sql, companyId, "process:core.party.create")).toBe(true);
    expect(await entitled(sql, companyId, "process:core.admin.setup")).toBe(true);
    expect(await entitled(sql, companyId, "feature:core.parties")).toBe(true);
    expect(await entitled(sql, companyId, "module:core")).toBe(true);
    expect(await entitled(sql, companyId, "process:support.ticket.create")).toBe(false);
    expect(await entitled(sql, companyId, "module:support")).toBe(false);
  });

  it("a feature entitlement covers the processes it lists and nothing else", async () => {
    await entitle("feature:core.parties");
    expect(await entitled(sql, companyId, "process:core.party.create")).toBe(true);
    expect(await entitled(sql, companyId, "process:core.report.run")).toBe(false);
    expect(await entitled(sql, companyId, "process:core.admin.setup")).toBe(false);
    expect(await entitled(sql, companyId, "module:core")).toBe(false);
  });

  it("a process entitlement stands alone", async () => {
    await entitle("process:core.report.run");
    expect(await entitled(sql, companyId, "process:core.report.run")).toBe(true);
    expect(await entitled(sql, companyId, "process:core.party.create")).toBe(false);
  });

  it("the most specific active row decides, so a feature can be switched off inside an entitled module", async () => {
    await entitle("module:core");
    await entitle("feature:core.parties", { enabled: false });
    expect(await entitled(sql, companyId, "process:core.party.create")).toBe(false);
    expect(await entitled(sql, companyId, "feature:core.parties")).toBe(false);
    expect(await entitled(sql, companyId, "process:core.report.run")).toBe(true);
    await entitle("process:core.party.create");
    expect(await entitled(sql, companyId, "process:core.party.create")).toBe(true);
  });

  it("a disabled process row denies that process even when its feature and module are entitled", async () => {
    await entitle("module:core");
    await entitle("feature:core.parties");
    await entitle("process:core.party.create", { enabled: false });
    expect(await entitled(sql, companyId, "process:core.party.create")).toBe(false);
    expect(await entitled(sql, companyId, "feature:core.parties")).toBe(true);
    expect(await entitled(sql, companyId, "process:core.report.run")).toBe(true);
  });

  it("an unknown key, a malformed key and an unknown company are not entitled", async () => {
    await entitle("module:core");
    expect(await entitled(sql, companyId, "process:nope.thing.run")).toBe(false);
    expect(await entitled(sql, companyId, "core")).toBe(false);
    expect(await entitled(sql, companyId, "thing:core")).toBe(false);
    expect(await entitled(sql, "00000000-0000-0000-0000-000000000000", "module:core")).toBe(false);
  });

  it("expired, not yet valid and disabled entitlements are not active; the last day still counts", async () => {
    await entitle("module:core", { from: "2000-01-01", to: "2000-12-31" });
    expect(await entitled(sql, companyId, "module:core")).toBe(false);
    await sql`delete from kernel.tenant_entitlements where tenant_id = ${tenantId}`;
    await sql`insert into kernel.tenant_entitlements(tenant_id, key, enabled, valid_from, valid_to, source)
              values (${tenantId}, 'module:core', true, current_date - 10, current_date - 1, 'trial')`;
    expect(await entitled(sql, companyId, "module:core")).toBe(false);
    await sql`delete from kernel.tenant_entitlements where tenant_id = ${tenantId}`;
    await sql`insert into kernel.tenant_entitlements(tenant_id, key, enabled, valid_from, source)
              values (${tenantId}, 'module:core', true, current_date + 1, 'addon')`;
    expect(await entitled(sql, companyId, "module:core")).toBe(false);
    await sql`delete from kernel.tenant_entitlements where tenant_id = ${tenantId}`;
    await sql`insert into kernel.tenant_entitlements(tenant_id, key, enabled, valid_from, valid_to, source)
              values (${tenantId}, 'module:core', true, current_date - 5, current_date, 'plan')`;
    expect(await entitled(sql, companyId, "module:core")).toBe(true);
    await sql`delete from kernel.tenant_entitlements where tenant_id = ${tenantId}`;
    await entitle("module:core", { enabled: false });
    expect(await entitled(sql, companyId, "module:core")).toBe(false);
  });

  it("tenant-wide rows apply to every company, company rows only to theirs and win over tenant-wide", async () => {
    await entitle("module:core");
    await entitle("module:support", { company: companyB });
    expect(await entitled(sql, companyId, "module:core")).toBe(true);
    expect(await entitled(sql, companyB, "module:core")).toBe(true);
    expect(await entitled(sql, companyId, "module:support")).toBe(false);
    expect(await entitled(sql, companyB, "module:support")).toBe(true);
    await entitle("module:core", { company: companyB, enabled: false });
    expect(await entitled(sql, companyB, "module:core")).toBe(false);
    expect(await entitled(sql, companyId, "module:core")).toBe(true);
  });

  it("a company row enabling a key wins over a tenant-wide row disabling it", async () => {
    await entitle("module:core", { enabled: false });
    await entitle("module:core", { company: companyB });
    expect(await entitled(sql, companyId, "module:core")).toBe(false);
    expect(await entitled(sql, companyB, "module:core")).toBe(true);
  });

  it("another tenant's entitlements never apply", async () => {
    await sql`insert into kernel.tenant_entitlements(tenant_id, key, enabled, valid_from, source)
              values (${other.tenantId}, 'module:core', true, current_date, 'plan')`;
    expect(await entitled(sql, companyId, "module:core")).toBe(false);
    expect(await entitled(sql, other.companies[0]!.id, "module:core")).toBe(true);
  });

  it("a module the company disabled is not entitled, whatever the plan says", async () => {
    await entitle("module:core");
    await sql`insert into kernel.company_modules(company_id, module_id, enabled) values (${companyId}, 'core', false)`;
    expect(await entitled(sql, companyId, "module:core")).toBe(false);
    expect(await entitled(sql, companyId, "process:core.party.create")).toBe(false);
    expect(await entitled(sql, companyB, "module:core")).toBe(true);
    await sql`update kernel.company_modules set enabled = true where company_id = ${companyId} and module_id = 'core'`;
    expect(await entitled(sql, companyId, "module:core")).toBe(true);
  });

  it("limit keys: entitled when an active row exists, entitlementLimit returns the company row over the tenant-wide one", async () => {
    expect(await entitlementLimit(sql, companyId, "limit:users")).toBeNull();
    expect(await entitled(sql, companyId, "limit:users")).toBe(false);
    await entitle("limit:users", { limit: 10 });
    expect(await entitlementLimit(sql, companyId, "limit:users")).toBe(10);
    expect(await entitled(sql, companyId, "limit:users")).toBe(true);
    await entitle("limit:users", { limit: 3, company: companyB });
    expect(await entitlementLimit(sql, companyB, "limit:users")).toBe(3);
    expect(await entitlementLimit(sql, companyId, "limit:users")).toBe(10);
    await entitle("limit:invoices_month", { limit: 100, from: "2000-01-01", to: "2000-12-31" });
    expect(await entitlementLimit(sql, companyId, "limit:invoices_month")).toBeNull();
    await entitle("limit:seats", { limit: 5, enabled: false });
    expect(await entitlementLimit(sql, companyId, "limit:seats")).toBeNull();
    expect(await entitled(sql, companyId, "module:core")).toBe(false);
  });

  it("a company row with enabled = false masks a tenant-wide limit, as it does for entitled", async () => {
    await entitle("limit:ai_tokens_month", { limit: 1000 });
    await entitle("limit:ai_tokens_month", { limit: 5, company: companyB, enabled: false });
    expect(await entitlementLimit(sql, companyId, "limit:ai_tokens_month")).toBe(1000);
    expect(await entitlementLimit(sql, companyB, "limit:ai_tokens_month")).toBeNull();
    expect(await entitled(sql, companyB, "limit:ai_tokens_month")).toBe(false);
    // Same level conflict: the company row wins even with a smaller value, and the latest valid_from wins among its rows.
    await entitle("limit:ai_tokens_month", { limit: 7, company: companyB, from: "2000-01-01" });
    await entitle("limit:ai_tokens_month", { limit: 9, company: companyB });
    expect(await entitlementLimit(sql, companyB, "limit:ai_tokens_month")).toBe(9);
  });

  it("enableModule refuses when a dependency is disabled", async () => {
    await expect(enableModule(sql, companyId, "support", registry)).rejects.toThrow(/requires core/);
    await sql`insert into kernel.company_modules(company_id, module_id, enabled) values (${companyId}, 'core', false)`;
    await expect(enableModule(sql, companyId, "support", registry)).rejects.toThrow(/requires core/);
    const rows = await sql`select 1 from kernel.company_modules where company_id = ${companyId} and module_id = 'support'`;
    expect(rows).toHaveLength(0);
  });

  it("enableModule enables a module whose dependencies are enabled, idempotently, and re-enables a disabled one", async () => {
    await enableModule(sql, companyId, "core", registry);
    await enableModule(sql, companyId, "support", registry);
    await enableModule(sql, companyId, "support", registry);
    const rows = await sql<{ module_id: string; enabled: boolean; enabled_at: Date }[]>`
      select module_id, enabled, enabled_at from kernel.company_modules where company_id = ${companyId} order by module_id`;
    expect(rows.map((r) => [r.module_id, r.enabled])).toEqual([["core", true], ["support", true]]);
    expect(rows[0]!.enabled_at).toBeInstanceOf(Date);
    await sql`update kernel.company_modules set enabled = false where company_id = ${companyId} and module_id = 'support'`;
    await enableModule(sql, companyId, "support", registry);
    const [again] = await sql`select enabled from kernel.company_modules where company_id = ${companyId} and module_id = 'support'`;
    expect(again!.enabled).toBe(true);
    // Another company is unaffected.
    expect(await sql`select 1 from kernel.company_modules where company_id = ${companyB}`).toHaveLength(0);
  });

  it("enableModule rejects a module the registry does not know and a company that does not exist", async () => {
    await expect(enableModule(sql, companyId, "nope", registry)).rejects.toThrow(/unknown module: nope/);
    await expect(enableModule(sql, "00000000-0000-0000-0000-000000000000", "core", registry)).rejects.toThrow();
  });

  it("syncModuleManifest stores each feature's processes and entities and drops features the manifest no longer has", async () => {
    const stored = () =>
      sql<{ feature_id: string; process_ids: string[]; entity_ids: string[] }[]>`
        select feature_id, process_ids, entity_ids from kernel.module_features where module_id = 'core' order by feature_id`;
    expect(await stored()).toEqual([
      { feature_id: "core.parties", process_ids: ["core.party.create"], entity_ids: ["core.party"] },
      { feature_id: "core.reports", process_ids: ["core.report.run"], entity_ids: [] },
    ]);
    await syncModuleManifest(sql, { ...core, features: core.features.slice(0, 1) });
    expect((await stored()).map((r) => r.feature_id)).toEqual(["core.parties"]);
    await syncModuleManifest(sql, core);
    expect((await stored()).map((r) => r.feature_id)).toEqual(["core.parties", "core.reports"]);
  });

  it("runProcess returns not_entitled before forbidden and records the denial", async () => {
    const deps = { sql, registry };
    // The cashier holds no permission: a forbidden would surface if entitlements ran second.
    const error = await runProcess(deps, { claims: cashierClaims, origin: "ui" }, "test.probe.create", {}).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "not_entitled" });
    const [denied] = await sql`
      select input from kernel.audit_log where company_id = ${companyId} and process_id = 'test.probe.create' and action = 'denied'`;
    expect(denied!.input).toMatchObject({ code: "not_entitled" });

    await entitle("module:test");
    await expect(runProcess(deps, { claims: cashierClaims, origin: "ui" }, "test.probe.create", {})).rejects.toMatchObject({
      code: "forbidden",
    });
    await sql`insert into kernel.process_permissions(company_id, role_id, process_id)
              values (${companyId}, ${seed.companies[0]!.adminRoleId}, 'test.probe.create')`;
    await expect(runProcess(deps, { claims: adminClaims, origin: "ui" }, "test.probe.create", {})).resolves.toEqual({});
  });

  it("runProcess is not_entitled for a module the company disabled", async () => {
    await entitle("module:test");
    await sql`insert into kernel.company_modules(company_id, module_id, enabled) values (${companyId}, 'test', false)`;
    await expect(
      runProcess({ sql, registry }, { claims: adminClaims, origin: "ui" }, "test.probe.create", {}),
    ).rejects.toMatchObject({ code: "not_entitled" });
  });

  it("a feature-only grant (no module row) lets runProcess run the processes that feature lists", async () => {
    await sql`insert into kernel.process_permissions(company_id, role_id, process_id)
              values (${companyId}, ${seed.companies[0]!.adminRoleId}, 'core.party.create'), (${companyId}, ${seed.companies[0]!.adminRoleId}, 'core.report.run')
              on conflict (company_id, role_id, process_id) do nothing`;
    await entitle("feature:core.parties");
    const caller = { claims: adminClaims, origin: "ui" as const };
    await expect(runProcess({ sql, registry }, caller, "core.party.create", {})).resolves.toEqual({});
    await expect(runProcess({ sql, registry }, caller, "core.report.run", {})).rejects.toMatchObject({ code: "not_entitled" });
  });

  it("a module the company disabled still yields not_entitled through the process key", async () => {
    await sql`insert into kernel.process_permissions(company_id, role_id, process_id)
              values (${companyId}, ${seed.companies[0]!.adminRoleId}, 'core.party.create')
              on conflict (company_id, role_id, process_id) do nothing`;
    await entitle("module:core");
    await entitle("feature:core.parties");
    await sql`insert into kernel.company_modules(company_id, module_id, enabled) values (${companyId}, 'core', false)`;
    await expect(
      runProcess({ sql, registry }, { claims: adminClaims, origin: "ui" }, "core.party.create", {}),
    ).rejects.toMatchObject({ code: "not_entitled" });
  });

  describe("access control", () => {
    it("a user reads only their own tenant's entitlements and cannot write them", async () => {
      await entitle("module:core");
      await sql`insert into kernel.tenant_entitlements(tenant_id, key, valid_from, source)
                values (${other.tenantId}, 'module:support', current_date, 'plan')`;
      const rows = await withClaims(sql, adminClaims, (tx) => tx<{ key: string }[]>`select key from kernel.tenant_entitlements`);
      expect(rows.map((r) => r.key)).toEqual(["module:core"]);
      await expect(
        withClaims(sql, adminClaims, (tx) => tx`insert into kernel.tenant_entitlements(tenant_id, key, valid_from, source)
          values (${tenantId}, 'module:support', current_date, 'manual')`),
      ).rejects.toThrow(/permission denied/);
      await expect(
        withClaims(sql, adminClaims, (tx) => tx`update kernel.tenant_entitlements set enabled = false`),
      ).rejects.toThrow(/permission denied/);
    });

    it("plans and module features are readable by users and writable only by the service role", async () => {
      const plans = await withClaims(sql, adminClaims, (tx) => tx<{ id: string }[]>`select id from kernel.plans`);
      expect(plans.map((p) => p.id)).toContain("starter");
      const features = await withClaims(sql, adminClaims, (tx) => tx`select feature_id from kernel.module_features`);
      expect(features.length).toBeGreaterThan(0);
      await expect(withClaims(sql, adminClaims, (tx) => tx`delete from kernel.plans`)).rejects.toThrow(/permission denied/);
      await expect(withClaims(sql, adminClaims, (tx) => tx`delete from kernel.module_features`)).rejects.toThrow(/permission denied/);
    });

    it("the starter plan is seeded with its keys and limits", async () => {
      const [plan] = await sql`select included_keys, limits from kernel.plans where id = 'starter'`;
      expect(plan!.included_keys).toEqual(["module:core", "module:support"]);
      expect(plan!.limits).toEqual({ ai_tokens_month: 2000000 });
    });

    it("company_modules: members of the active company read it, only its admin writes it, other companies are invisible", async () => {
      await sql`insert into kernel.company_modules(company_id, module_id, enabled) values (${companyId}, 'core', true), (${companyB}, 'core', true)`;
      const read = await withClaims(sql, cashierClaims, (tx) => tx<{ company_id: string }[]>`select company_id from kernel.company_modules`);
      expect(read.map((r) => r.company_id)).toEqual([companyId]);
      await expect(
        withClaims(sql, cashierClaims, (tx) => tx`update kernel.company_modules set enabled = false where module_id = 'core'`),
      ).resolves.toHaveLength(0);
      const [still] = await sql`select enabled from kernel.company_modules where company_id = ${companyId}`;
      expect(still!.enabled).toBe(true);
      await expect(
        withClaims(sql, cashierClaims, (tx) => tx`insert into kernel.company_modules(company_id, module_id) values (${companyId}, 'support')`),
      ).rejects.toThrow(/row-level security/);
      await withClaims(sql, adminClaims, (tx) => tx`update kernel.company_modules set enabled = false where module_id = 'core'`);
      const [after] = await sql`select enabled from kernel.company_modules where company_id = ${companyId}`;
      expect(after!.enabled).toBe(false);
      const audits = await sql`select action from kernel.audit_log where company_id = ${companyId} and entity = 'kernel.company_modules'`;
      expect(audits.length).toBeGreaterThan(0);
    });

    it("entitlement rows are audited under their company, tenant-wide rows without one", async () => {
      await entitle("module:support", { company: companyB });
      await entitle("module:core");
      const [byCompany] = await sql`
        select action, diff from kernel.audit_log
        where company_id = ${companyB} and entity = 'kernel.tenant_entitlements' and diff->'key'->>'new' = 'module:support'`;
      expect(byCompany).toMatchObject({ action: "insert" });
      const tenantWide = await sql`
        select action from kernel.audit_log
        where company_id is null and entity = 'kernel.tenant_entitlements' and diff->'tenant_id'->>'new' = ${tenantId}`;
      expect(tenantWide.length).toBeGreaterThan(0);
      await sql`update kernel.tenant_entitlements set enabled = false where tenant_id = ${tenantId} and key = 'module:support'`;
      const [updated] = await sql`
        select diff from kernel.audit_log
        where company_id = ${companyB} and entity = 'kernel.tenant_entitlements' and action = 'update' order by occurred_at desc limit 1`;
      expect(updated!.diff).toEqual({ enabled: { old: true, new: false } });
    });

    it("kernel.entitled is not callable by users", async () => {
      await expect(
        withClaims(sql, adminClaims, (tx) => tx`select kernel.entitled(${companyId}, 'module:core')`),
      ).rejects.toThrow(/permission denied/);
      await expect(
        withClaims(sql, adminClaims, (tx) => tx`select kernel.entitlement_limit(${companyId}, 'limit:users')`),
      ).rejects.toThrow(/permission denied/);
      await expect(
        withClaims(sql, adminClaims, (tx) => tx`select kernel.entitlement_decision(${tenantId}, ${companyId}, array['module:core'])`),
      ).rejects.toThrow(/permission denied/);
    });
  });
});
