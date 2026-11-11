import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { withClaims } from "../../db/client";
import { seedTenant, testDb } from "../../db/test-db";
import { defineEntity, Registry } from "../../registry";
import { defineModule } from "../../module/define";
import { loadModules } from "../../module/loader";
import { kernelModule } from "../../module/kernel-module";
import { defineProcess } from "../../process/define";
import { runProcess } from "../../process/run";
import type { Caller } from "../../process/context";
import { syncModuleManifest } from "../../entitlements/resolver";
import { syncRegistry } from "../sync";
import { registerVerifier, unregisterVerifier } from "../../verify/adapters";

// Migration 0021 (rule 34) and the registry sync it relies on: the admin-written kernel tables accept writes only inside
// the kernel.admin.* (and required_file / verifier) processes, even from the company admin; the manifests' processes and
// fields reach SQL through syncModuleManifest, so a new role and a field that becomes confidential start masked; the
// company and verifier settings and the sensitive list go through their processes.

const thing = (confidential: string[], module = "probe") =>
  defineEntity({
    entityType: "maestro", id: `${module}.thing`,
    module,
    schema: module,
    table: "thing",
    label: "entity.probe.thing",
    displayField: "name",
    defaultSort: { field: "name", dir: "asc" },
    fields: ["name", "secret", "price"].map((name) => ({ name, type: "text" as const, label: `field.probe.${name}`, ...(confidential.includes(name) ? { sensitivity: "confidential" as const } : {}) })),
  });
const look = defineProcess({
  id: "probe.thing.consult",
  module: "probe",
  kind: "consult",
  description: "consulta",
  input: z.object({}),
  output: z.object({}),
  handler: async () => ({}),
});
const probeModule = (confidential: string[], id = "probe") =>
  defineModule({
    id,
    version: "0.0.1",
    dependsOn: [],
    entities: [thing(confidential, id)],
    processes: id === "probe" ? [look] : [],
    features: id === "probe" ? [{ id: "probe.things", label: "feature.probe.things", processes: [look.id], entities: ["probe.thing"] }] : [],
    events: { emits: [], consumes: {} },
    navigation: [],
  });

describe("kernel admin: policies, seeds and registry sync", () => {
  let sql: ReturnType<typeof testDb>;
  let seed: Awaited<ReturnType<typeof seedTenant>>;
  let registry: Registry;
  let companyId: string;
  let admin: Caller;
  let member: Caller;

  const stepUp = async (caller: Caller): Promise<Caller> => {
    const stepUpToken = randomUUID();
    await sql`insert into kernel.step_up_verifications(user_id, company_id, token) values (${caller.claims.sub}, ${companyId}, ${stepUpToken})`;
    return { ...caller, stepUpToken };
  };
  const run = async <T = unknown>(processId: string, input: unknown): Promise<T> => runProcess({ sql, registry }, await stepUp(admin), processId, input);

  beforeAll(async () => {
    sql = testDb();
    registry = new Registry();
    loadModules(registry, [kernelModule, probeModule(["secret"])]);
    seed = await seedTenant(sql, { companies: 1, entitlements: ["module:probe"], users: [{ name: "member", companies: [0], role: "member" }] });
    companyId = seed.companies[0]!.id;
    admin = { claims: seed.claimsFor(seed.users.both, companyId), origin: "ui" };
    member = { claims: seed.claimsFor(seed.users.member!, companyId), origin: "ui" };
    await syncRegistry(sql, registry);
    await sql`select kernel.seed_company_defaults(${companyId})`;
  });
  afterAll(async () => {
    await sql`delete from kernel.field_permissions where entity like 'probe%'`;
    await sql`delete from kernel.entity_fields where module_id in ('probe', 'probe_late')`;
    unregisterVerifier("Twilio Lookup");
    await sql`delete from kernel.registered_processes where module_id = 'probe'`;
    await sql`delete from kernel.module_features where module_id = 'probe'`;
    await seed.cleanup();
    await sql.end();
  });

  it("syncRegistry records every process with its kind and every field with its sensitivity", async () => {
    const [proc] = await sql`select module_id, feature_id, kind, step_up from kernel.registered_processes where process_id = 'kernel.admin.role.create'`;
    expect(proc).toMatchObject({ module_id: "kernel", feature_id: "kernel.admin", kind: "create", step_up: true });
    const fields = await sql`select field, sensitivity from kernel.entity_fields where entity = 'probe.thing' order by field`;
    expect(fields).toEqual([
      { field: "name", sensitivity: "normal" },
      { field: "price", sensitivity: "normal" },
      { field: "secret", sensitivity: "confidential" },
    ]);
  });

  it("the company defaults grant the admin role every process and a plain role the baseline with confidential fields masked", async () => {
    const grants = async (roleId: string) => (await sql<{ process_id: string }[]>`select process_id from kernel.process_permissions where role_id = ${roleId}`).map((r) => r.process_id);
    const adminGrants = await grants(seed.companies[0]!.adminRoleId);
    expect(adminGrants).toEqual(expect.arrayContaining(["kernel.admin.permission.set", "probe.thing.consult", "kernel.help.search"]));
    const memberGrants = await grants(seed.companies[0]!.memberRoleId);
    expect(memberGrants).toEqual(expect.arrayContaining(["probe.thing.consult", "kernel.help.search", "kernel.data.query", "kernel.saved_view.save", "kernel.export.run", "kernel.verify.status", "kernel.home.kpis", "kernel.home.recent", "kernel.recommendation.list", "kernel.recommendation.decide"]));
    expect(memberGrants.filter((id) => id.startsWith("kernel.admin."))).toEqual([]);
    const masks = await sql`select role_id, field, mode from kernel.field_permissions where company_id = ${companyId} and entity = 'probe.thing'`;
    expect(masks).toEqual([{ role_id: seed.companies[0]!.memberRoleId, field: "secret", mode: "masked" }]);
  });

  it("a field that becomes confidential in a later sync is masked for every non-admin role, an admin choice is kept", async () => {
    await sql`update kernel.field_permissions set mode = 'visible' where company_id = ${companyId} and entity = 'probe.thing' and field = 'secret'`;
    await syncModuleManifest(sql, probeModule(["secret", "price"]));
    const masks = await sql`select role_id, field, mode from kernel.field_permissions where company_id = ${companyId} and entity = 'probe.thing' order by field`;
    expect(masks).toEqual([
      { role_id: seed.companies[0]!.memberRoleId, field: "price", mode: "masked" },
      { role_id: seed.companies[0]!.memberRoleId, field: "secret", mode: "visible" },
    ]);
  });

  it("the admin writes the permission tables only inside an admin process", async () => {
    const memberRole = seed.companies[0]!.memberRoleId;
    const grant = (tx: Parameters<Parameters<typeof withClaims>[2]>[0]) =>
      tx`insert into kernel.process_permissions(company_id, role_id, process_id) values (${companyId}, ${memberRole}, 'kernel.import.run')`;
    await expect(withClaims(sql, admin.claims, (tx) => grant(tx))).rejects.toThrow(/row-level security/);
    await expect(withClaims(sql, admin.claims, (tx) => tx`update kernel.roles set party_scope = 'clientes' where id = ${memberRole}`)).resolves.toHaveLength(0);
    await expect(withClaims(sql, admin.claims, (tx) => tx`insert into kernel.sensitive_processes(company_id, process_id, mode) values (${companyId}, 'probe.thing.consult', 'self_2fa')`)).rejects.toThrow(
      /row-level security/,
    );
    await expect(withClaims(sql, admin.claims, (tx) => tx`insert into kernel.verifiers(company_id, kind, provider) values (${companyId}, 'email', 'x')`)).rejects.toThrow(/row-level security/);
    // Inside a process of the right family it is the admin policy that decides, as before.
    await withClaims(sql, admin.claims, async (tx) => {
      await tx`select set_config('erp.audit_process_id', 'kernel.admin.permission.set', true)`;
      await grant(tx);
      await tx`delete from kernel.process_permissions where role_id = ${memberRole} and process_id = 'kernel.import.run'`;
    });
    await expect(
      withClaims(sql, member.claims, async (tx) => {
        await tx`select set_config('erp.audit_process_id', 'kernel.admin.permission.set', true)`;
        await grant(tx);
      }),
    ).rejects.toThrow(/row-level security/);
    // The seed function refuses a caller who is not the company's admin inside an admin process.
    await expect(withClaims(sql, member.claims, (tx) => tx`select kernel.seed_role_defaults(${companyId}, ${memberRole})`)).rejects.toThrow(/admin/);
    await expect(
      withClaims(sql, admin.claims, async (tx) => {
        await tx`select set_config('erp.audit_process_id', 'kernel.import.run', true)`;
        await tx`select kernel.seed_role_defaults(${companyId}, ${memberRole})`;
      }),
    ).rejects.toThrow(/admin/);
  });

  it("sensitive_process.set adds and removes a normal process but never lowers a step-up one", async () => {
    await run("kernel.admin.sensitive_process.set", { processId: "probe.thing.consult", sensitive: true });
    const has = async () => (await sql`select 1 from kernel.sensitive_processes where company_id = ${companyId} and process_id = 'probe.thing.consult'`).length === 1;
    expect(await has()).toBe(true);
    await run("kernel.admin.sensitive_process.set", { processId: "probe.thing.consult", sensitive: false });
    expect(await has()).toBe(false);
    await expect(run("kernel.admin.sensitive_process.set", { processId: "kernel.admin.permission.set", sensitive: false })).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("company.update and verifier.set change the settings through their processes", async () => {
    await run("kernel.admin.company.update", { legalName: "Café del Norte S.A.S.", tradeName: "Café del Norte", timezone: "America/Lima" });
    const [company] = await sql`select legal_name, trade_name, timezone from kernel.companies where id = ${companyId}`;
    expect(company).toEqual({ legal_name: "Café del Norte S.A.S.", trade_name: "Café del Norte", timezone: "America/Lima" });
    await expect(run("kernel.admin.company.update", { timezone: "Marte/Olympus" })).rejects.toMatchObject({ code: "invalid_input" });

    // Only a provider whose adapter is registered (registerVerifier) can be chosen.
    await expect(run("kernel.verifier.set", { kind: "phone", provider: "Twilio Lookup" })).rejects.toMatchObject({ code: "invalid_input" });
    registerVerifier("Twilio Lookup", { verify: async () => ({ ok: true }) });
    await run("kernel.verifier.set", { kind: "phone", provider: "Twilio Lookup" });
    const [chosen] = await sql`select provider from kernel.verifiers where company_id = ${companyId} and kind = 'phone'`;
    expect(chosen!.provider).toBe("Twilio Lookup");
    await run("kernel.verifier.set", { kind: "phone", provider: null });
    const [verifier] = await sql`select provider from kernel.verifiers where company_id = ${companyId} and kind = 'phone'`;
    expect(verifier!.provider).toBeNull();
  });

  it("the admin read views show the company's roles, members and grants to its admin only", async () => {
    const roles = await withClaims(sql, admin.claims, (tx) => tx`select name, party_scope from kernel.v_roles order by name`);
    expect(roles.map((r) => r.name)).toEqual(["admin", "member"]);
    const members = await withClaims(sql, admin.claims, (tx) => tx<{ user_id: string; role_ids: string[] }[]>`select user_id, role_ids from kernel.v_memberships`);
    expect(members.map((m) => m.user_id).sort()).toEqual([seed.users.both, seed.users.onlyA, seed.users.member!].sort());
    expect(await withClaims(sql, member.claims, (tx) => tx`select 1 from kernel.v_memberships`)).toHaveLength(0);
    // The tenant check is not a function users can call (it would tell whether an account exists elsewhere).
    for (const claims of [member.claims, admin.claims]) {
      await expect(withClaims(sql, claims, (tx) => tx`select kernel.user_of_caller_tenant(${seed.users.member!})`)).rejects.toThrow(/permission denied/);
    }
    const [view] = await sql<{ options: string[] }[]>`select reloptions as options from pg_class where oid = 'kernel.v_memberships'::regclass`;
    expect(view!.options).toContain("security_barrier=true");
  });

  it("the first registration of a module masks its confidential fields for every existing non-admin role", async () => {
    await syncModuleManifest(sql, probeModule(["secret"], "probe_late"));
    const masks = await sql`select role_id, field, mode from kernel.field_permissions where company_id = ${companyId} and entity = 'probe_late.thing'`;
    expect(masks).toEqual([{ role_id: seed.companies[0]!.memberRoleId, field: "secret", mode: "masked" }]);
  });

  it("the company admin runs a process nobody granted; a member does not", async () => {
    await sql`delete from kernel.process_permissions where company_id = ${companyId} and process_id = 'probe.thing.consult'`;
    await expect(runProcess({ sql, registry }, admin, "probe.thing.consult", {})).resolves.toEqual({});
    await expect(runProcess({ sql, registry }, member, "probe.thing.consult", {})).rejects.toMatchObject({ code: "forbidden" });
  });

  it("a user's mobile and photo are read only through the admin view, and only for users of the caller's organization", async () => {
    await expect(withClaims(sql, admin.claims, (tx) => tx`select mobile from kernel.users`)).rejects.toThrow(/permission denied/);
    await expect(withClaims(sql, admin.claims, (tx) => tx`select photo from kernel.users`)).rejects.toThrow(/permission denied/);
    expect(await withClaims(sql, admin.claims, (tx) => tx`select id, email, full_name from kernel.users`)).not.toHaveLength(0);
    const memberId = seed.users.member!;
    await sql`update kernel.users set mobile_cc = '57', mobile = '3001234567' where id = ${memberId}`;
    const seen = async () => (await withClaims(sql, admin.claims, (tx) => tx<{ mobile: string | null }[]>`select mobile from kernel.v_memberships where user_id = ${memberId}`))[0]!.mobile;
    expect(await seen()).toBe("3001234567");
    // The same person also belongs to another organization (data from before the one-tenant rule): their profile is not shown.
    const other = await seedTenant(sql, { companies: 1, entitlements: [] });
    try {
      await sql`insert into kernel.memberships(user_id, company_id) values (${memberId}, ${other.companies[0]!.id})`;
      expect(await seen()).toBeNull();
    } finally {
      await sql`delete from kernel.memberships where user_id = ${memberId} and company_id = ${other.companies[0]!.id}`;
      await other.cleanup();
    }
  });

  it("an authenticated session without claims is not the service role for the seeds", async () => {
    await expect(
      sql.begin(async (tx) => {
        await tx`select set_config('request.jwt.claims', '', true)`;
        await tx`set local role authenticated`;
        await tx`select kernel.seed_role_defaults(${companyId}, ${seed.companies[0]!.memberRoleId})`;
      }),
    ).rejects.toThrow(/admin/);
  });
});
