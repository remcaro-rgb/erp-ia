import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ADMIN_PROCESSES, runProcess, setAuthAdmin, syncRegistry, type Caller } from "@erp/kernel";
import { DbAuthAdmin, seedTenant, withClaims } from "@erp/kernel/testing";
import { attachFile, coreHarness, exito, supplier, type CoreHarness } from "./helpers";

// Administration (design §6, §5.12–§5.18, rules 13–15): the kernel.admin.* processes against the real core module.
// Roles created by the admin carry the party scope and start with the baseline consults and every confidential field
// masked; the permission matrix decides who runs what; required files feed invoice readiness; users are invited
// through the AuthAdmin adapter; the AI usage report sums the month's metered calls against the allowance.

describe("admin", () => {
  let h: CoreHarness;
  let sql: CoreHarness["sql"];
  let deps: CoreHarness["deps"];
  let admin: Caller;
  let clerk: Caller;
  let memberRole: string;
  let auth: DbAuthAdmin;
  let nextDocument = 930000100;

  const stepUp = async (caller: Caller): Promise<Caller> => {
    const stepUpToken = randomUUID();
    await sql`insert into kernel.step_up_verifications(user_id, company_id, token)
              values (${caller.claims.sub}, ${caller.claims.active_company_id}, ${stepUpToken})`;
    return { ...caller, stepUpToken };
  };
  const run = async <T = unknown>(caller: Caller, processId: string, input: unknown): Promise<T> => runProcess(deps, await stepUp(caller), processId, input);
  /** A caller of company 0 whose claims name exactly `roleIds`, which the user holds (0024 counts only held roles). */
  const asRoles = async (user: string, roleIds: string[]): Promise<Caller> => {
    await h.seed.holdRoles(user, h.companyId, roleIds);
    return { claims: { ...h.seed.claimsFor(user, h.companyId), role_ids: roleIds }, origin: "ui" };
  };

  beforeAll(async () => {
    h = await coreHarness({
      companies: 2,
      users: [
        { name: "clerk", companies: [0], role: "member" },
        { name: "buyer", companies: [0], role: "member" },
        // Same tenant, another company: may be added to company 0 without a new invitation.
        { name: "neighbor", companies: [1], role: "member" },
      ],
    });
    ({ sql, deps, admin } = h);
    memberRole = h.seed.companies[0]!.memberRoleId;
    clerk = { claims: h.seed.claimsFor(h.seed.users.clerk!, h.companyId), origin: "ui" };
    // The kernel registers the manifests at boot; the company defaults then grant the admin role every process.
    await syncRegistry(sql, deps.registry);
    await sql`select kernel.seed_company_defaults(${h.companyId})`;
    auth = new DbAuthAdmin(sql);
    setAuthAdmin(auth);
  });
  afterAll(async () => {
    setAuthAdmin(undefined);
    await auth.cleanup();
    await h.cleanup();
  });

  it("permission.set by a non-admin is forbidden, even with the process granted to their role", async () => {
    const input = { roleId: memberRole, processId: "core.party.create", allowed: true };
    await expect(run(clerk, "kernel.admin.permission.set", input)).rejects.toMatchObject({ code: "forbidden" });
    await h.grantAll(h.companyId, memberRole, ["kernel.admin.permission.set"]);
    try {
      await expect(run(clerk, "kernel.admin.permission.set", input)).rejects.toMatchObject({ code: "forbidden" });
    } finally {
      await sql`delete from kernel.process_permissions where role_id = ${memberRole} and process_id = 'kernel.admin.permission.set'`;
    }
  });

  it("the admin grants and revokes a process; the matrix lists roles, processes with their entity, and the grants", async () => {
    await expect(runProcess(deps, admin, "kernel.admin.permission.set", { roleId: memberRole, processId: "core.product.consult", allowed: true })).rejects.toMatchObject({
      code: "step_up_required",
    });
    await run(admin, "kernel.admin.permission.set", { roleId: memberRole, processId: "core.product.consult", allowed: true });
    const can = async () => (await withClaims(sql, clerk.claims, (tx) => tx`select kernel.can_run_process('core.product.consult') as ok`))[0]!.ok;
    expect(await can()).toBe(true);

    const matrix = await run<{ roles: { id: string; name: string }[]; processes: { id: string; module: string; entity: string; entityLabel: string }[]; grants: Record<string, string[]> }>(
      admin,
      "kernel.admin.permission.matrix",
      {},
    );
    expect(matrix.roles.map((r) => r.id)).toContain(memberRole);
    expect(matrix.processes.find((p) => p.id === "core.party.create")).toMatchObject({ module: "core", entity: "core.party", entityLabel: "entity.core.party" });
    expect(matrix.processes.find((p) => p.id === "kernel.admin.role.create")).toMatchObject({ module: "kernel", entityLabel: "feature.kernel.admin" });
    expect(matrix.grants[memberRole]).toContain("core.product.consult");

    await run(admin, "kernel.admin.permission.set", { roleId: memberRole, processId: "core.product.consult", allowed: false });
    expect(await can()).toBe(false);
    // Unknown processes and the system admin role are refused.
    await expect(run(admin, "kernel.admin.permission.set", { roleId: memberRole, processId: "core.nope.run", allowed: true })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(run(admin, "kernel.admin.permission.set", { roleId: h.seed.companies[0]!.adminRoleId, processId: "core.party.create", allowed: false })).rejects.toMatchObject({
      code: "invalid_input",
    });
  });

  it("every admin process that changes something is listed in sensitive_processes after the seed; the consults are not", async () => {
    const rows = await sql<{ process_id: string }[]>`select process_id from kernel.sensitive_processes where company_id = ${h.companyId}`;
    const sensitive = new Set(rows.map((r) => r.process_id));
    const writes = ADMIN_PROCESSES.filter((p) => p.kind !== "consult");
    const consults = ADMIN_PROCESSES.filter((p) => p.kind === "consult").map((p) => p.id);
    expect(writes.map((p) => p.id).filter((id) => !sensitive.has(id))).toEqual([]);
    expect(writes.every((p) => p.sensitivity === "step-up")).toBe(true);
    expect(consults.sort()).toEqual(["kernel.admin.ai_usage.consult", "kernel.admin.permission.matrix"]);
    expect(consults.filter((id) => sensitive.has(id))).toEqual([]);
    expect(ADMIN_PROCESSES.filter((p) => p.kind === "consult").every((p) => p.sensitivity !== "step-up")).toBe(true);
    // The consults run without a code.
    await expect(runProcess(deps, admin, "kernel.admin.permission.matrix", {})).resolves.toMatchObject({ roles: expect.any(Array) });
  });

  it("ai_usage.consult sums the month's llm_usage per user against the company allowance", async () => {
    const users = h.seed.users;
    await sql`insert into kernel.tenant_entitlements(tenant_id, key, limit_value, source) values (${h.seed.tenantId}, 'limit:ai_tokens_month', 10000, 'manual')`;
    const row = (userId: string, model: string, input: number, output: number, cost: number, when = "now()") =>
      sql`insert into kernel.llm_usage(company_id, user_id, task, provider, model, input_tokens, output_tokens, cost_usd, created_at)
          values (${h.companyId}, ${userId}, 'chat', 'anthropic', ${model}, ${input}, ${output}, ${cost}, ${sql.unsafe(when)})`;
    try {
      await row(users.both, "anthropic/claude-opus-5.5", 1000, 200, 0.008);
      await row(users.both, "anthropic/claude-haiku-5.5", 300, 100, 0.0001);
      await row(users.clerk!, "anthropic/claude-opus-5.5", 500, 0, 0.002);
      await row(users.clerk!, "anthropic/claude-opus-5.5", 999999, 0, 4, "now() - interval '45 days'");
      const usage = await run<{ limit: number | null; used: number; costUsd: number; users: { userId: string; tokens: number; calls: number; costUsd: number }[] }>(
        admin,
        "kernel.admin.ai_usage.consult",
        {},
      );
      expect(usage.limit).toBe(10000);
      expect(usage.used).toBe(2100);
      expect(usage.costUsd).toBeCloseTo(0.0101, 6);
      expect(usage.users.find((u) => u.userId === users.both)).toMatchObject({ tokens: 1600, calls: 2 });
      expect(usage.users.find((u) => u.userId === users.clerk)).toMatchObject({ tokens: 500, calls: 1 });
    } finally {
      await sql`delete from kernel.llm_usage where company_id = ${h.companyId}`;
      await sql`delete from kernel.tenant_entitlements where tenant_id = ${h.seed.tenantId} and key = 'limit:ai_tokens_month'`;
    }
  });

  it("a new role starts with the baseline consults and every confidential field masked", async () => {
    const { id: roleId } = await run<{ id: string }>(admin, "kernel.admin.role.create", { name: "Cartera", description: "Cobranza", partyScope: "ambos" });
    const grants = (await sql<{ process_id: string }[]>`select process_id from kernel.process_permissions where role_id = ${roleId} and allowed`).map((r) => r.process_id);
    expect(grants).toEqual(expect.arrayContaining(["core.party.consult", "core.product.consult", "kernel.help.search", "kernel.data.query", "kernel.export.run", "kernel.attachment.list"]));
    expect(grants).not.toContain("core.party.create");
    expect(grants.some((id) => id.startsWith("kernel.admin."))).toBe(false);

    const masked = await sql<{ entity: string; field: string; mode: string }[]>`
      select entity, field, mode from kernel.field_permissions where role_id = ${roleId} order by entity, field`;
    expect(masked).toEqual(
      expect.arrayContaining([
        { entity: "core.party", field: "balance", mode: "masked" },
        { entity: "core.party", field: "credit_limit", mode: "masked" },
        { entity: "core.product", field: "standard_cost", mode: "masked" },
      ]),
    );
    // Applied in the masked view: the new role reads parties without the credit limit; the admin still sees it.
    const party = await runProcess<never>(deps, admin, "core.party.create", { ...exito, documentNumber: String(nextDocument++), creditLimit: 2_000_000 });
    const { id } = party as { id: string };
    const [asRole] = await withClaims(sql, (await asRoles(h.seed.users.buyer!, [roleId])).claims, (tx) => tx`select credit_limit from core.v_parties where id = ${id}`);
    expect(asRole!.credit_limit).toBeNull();
    const [asAdmin] = await withClaims(sql, admin.claims, (tx) => tx`select credit_limit from core.v_parties where id = ${id}`);
    expect(Number(asAdmin!.credit_limit)).toBe(2_000_000);

    // The admin may make it visible again for that role.
    await run(admin, "kernel.admin.field_permission.set", { roleId, entity: "core.party", field: "credit_limit", mode: "visible" });
    const [visible] = await withClaims(sql, (await asRoles(h.seed.users.buyer!, [roleId])).claims, (tx) => tx`select credit_limit from core.v_parties where id = ${id}`);
    expect(Number(visible!.credit_limit)).toBe(2_000_000);
  });

  it("role.create with partyScope clientes hides suppliers from that role in core.v_parties", async () => {
    const customer = (await runProcess(deps, admin, "core.party.create", { ...exito, documentNumber: String(nextDocument++), legalName: "Cliente Alcance S.A.S." })) as { id: string };
    const vendor = (await runProcess(deps, admin, "core.party.create", { ...supplier(String(nextDocument++)), legalName: "Proveedor Alcance S.A.S." })) as { id: string };
    const { id: roleId } = await run<{ id: string }>(admin, "kernel.admin.role.create", { name: "Ventas mostrador", description: "", partyScope: "clientes" });
    await run(admin, "kernel.admin.user_role.set", { userId: h.seed.users.buyer!, roleIds: [roleId] });
    const roles = await sql<{ role_id: string }[]>`
      select mr.role_id from kernel.membership_roles mr join kernel.memberships m on m.id = mr.membership_id
      where m.user_id = ${h.seed.users.buyer!} and m.company_id = ${h.companyId}`;
    expect(roles.map((r) => r.role_id)).toEqual([roleId]);

    const seen = await withClaims(sql, (await asRoles(h.seed.users.buyer!, [roleId])).claims, (tx) => tx<{ id: string }[]>`
      select id from core.v_parties where id = any(${[customer.id, vendor.id]}::uuid[])`);
    expect(seen.map((r) => r.id)).toEqual([customer.id]);

    // Assigned from the role's side too: the role's users are replaced, and a user is never left without a role.
    await run(admin, "kernel.admin.user_role.set", { roleId, userIds: [h.seed.users.buyer!, h.seed.users.clerk!] });
    const holders = await sql<{ user_id: string }[]>`
      select m.user_id from kernel.membership_roles mr join kernel.memberships m on m.id = mr.membership_id where mr.role_id = ${roleId}`;
    expect(holders.map((r) => r.user_id).sort()).toEqual([h.seed.users.buyer!, h.seed.users.clerk!].sort());
    await expect(run(admin, "kernel.admin.user_role.set", { userId: h.seed.users.clerk!, roleIds: [] })).rejects.toMatchObject({ code: "invalid_input" });
    // Taking the role from buyer, whose only role it is, would leave buyer without roles.
    await expect(run(admin, "kernel.admin.user_role.set", { roleId, userIds: [h.seed.users.clerk!] })).rejects.toMatchObject({ code: "invalid_input" });
    await run(admin, "kernel.admin.user_role.set", { userId: h.seed.users.buyer!, roleIds: [memberRole] });
    await run(admin, "kernel.admin.user_role.set", { userId: h.seed.users.clerk!, roleIds: [memberRole] });
    // The admin never takes their own admin role away.
    await expect(run(admin, "kernel.admin.user_role.set", { userId: h.seed.users.both, roleIds: [memberRole] })).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("required_file.set then a party without that file has invoice_ready false; required_file.remove restores it", async () => {
    const { id } = (await runProcess(deps, admin, "core.party.create", { ...exito, documentNumber: String(nextDocument++) })) as { id: string };
    for (const tag of ["RUT", "Cámara de Comercio"]) await attachFile(sql, { tenantId: h.seed.tenantId, companyId: h.companyId, entity: "core.party", recordId: id, tag });
    const ready = async () => (await sql`select invoice_ready from core.parties where id = ${id}`)[0]!.invoice_ready as boolean;
    expect(await ready()).toBe(true);

    const { id: requirementId } = await run<{ id: string }>(admin, "kernel.required_file.set", {
      entity: "core.party",
      tag: "Certificado de calidad",
      kind: "pdf",
      required: true,
      condition: null,
      description: "Certificado vigente",
    });
    expect(await ready()).toBe(false);
    await run(admin, "kernel.required_file.remove", { id: requirementId });
    expect(await ready()).toBe(true);
  });

  it("user.create without a mobile is invalid_input", async () => {
    await expect(
      run(admin, "kernel.admin.user.create", { name: "Sin Celular", email: `sin-celular-${randomUUID().slice(0, 6)}@test.local`, mobileCc: "57", mobile: "", roleIds: [memberRole] }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      run(admin, "kernel.admin.user.create", { name: "Sin Rol", email: `sin-rol-${randomUUID().slice(0, 6)}@test.local`, mobileCc: "57", mobile: "3105551234", roleIds: [] }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(auth.invited).toEqual([]);
  });

  it("user.create invites the user through AuthAdmin and writes the membership and its roles", async () => {
    const email = `nueva-${randomUUID().slice(0, 6)}@test.local`;
    const out = await run<{ userId: string; invited: boolean }>(admin, "kernel.admin.user.create", {
      name: "Nueva Persona",
      email,
      mobileCc: "57",
      mobile: "3105551234",
      roleIds: [memberRole],
    });
    expect(out.invited).toBe(true);
    expect(auth.invited).toEqual([email]);
    const [user] = await sql`select email, full_name, mobile_cc, mobile from kernel.users where id = ${out.userId}`;
    expect(user).toMatchObject({ email, full_name: "Nueva Persona", mobile_cc: "57", mobile: "3105551234" });
    const roles = await sql<{ role_id: string }[]>`
      select mr.role_id from kernel.membership_roles mr join kernel.memberships m on m.id = mr.membership_id
      where m.user_id = ${out.userId} and m.company_id = ${h.companyId}`;
    expect(roles.map((r) => r.role_id)).toEqual([memberRole]);
    // The same e-mail again: already a member of the company.
    await expect(run(admin, "kernel.admin.user.create", { name: "Otra vez", email, mobileCc: "57", mobile: "3105551234", roleIds: [memberRole] })).rejects.toMatchObject({
      code: "invalid_input",
    });
  });
});

describe("admin: tenants, companies and the admin's own reach", () => {
  let h: CoreHarness;
  let sql: CoreHarness["sql"];
  let deps: CoreHarness["deps"];
  let admin: Caller;
  let memberRole: string;
  let otherCompanyRole: string;
  let auth: DbAuthAdmin;
  let stranger: Awaited<ReturnType<typeof seedTenant>>;

  const run = async <T = unknown>(caller: Caller, processId: string, input: unknown): Promise<T> => {
    const stepUpToken = randomUUID();
    await sql`insert into kernel.step_up_verifications(user_id, company_id, token) values (${caller.claims.sub}, ${caller.claims.active_company_id}, ${stepUpToken})`;
    return runProcess(deps, { ...caller, stepUpToken }, processId, input);
  };
  const membersOf = async (userId: string) =>
    (await sql<{ company_id: string }[]>`select company_id from kernel.memberships where user_id = ${userId} order by company_id`).map((r) => r.company_id);

  beforeAll(async () => {
    h = await coreHarness({ companies: 2, users: [{ name: "neighbor", companies: [1], role: "member" }] });
    ({ sql, deps, admin } = h);
    memberRole = h.seed.companies[0]!.memberRoleId;
    otherCompanyRole = h.seed.companies[1]!.memberRoleId;
    await syncRegistry(sql, deps.registry);
    await sql`select kernel.seed_company_defaults(${h.companyId})`;
    // Another organization, with a user whose profile carries a mobile.
    stranger = await seedTenant(sql, { companies: 1, entitlements: [], users: [{ name: "stranger", companies: [0], role: "member" }] });
    await sql`update kernel.users set mobile_cc = '57', mobile = '3001112222' where id = ${stranger.users.stranger!}`;
    auth = new DbAuthAdmin(sql);
    setAuthAdmin(auth);
  });
  afterAll(async () => {
    setAuthAdmin(undefined);
    await auth.cleanup();
    await stranger.cleanup();
    await h.cleanup();
  });

  it("user.create refuses an e-mail that belongs to another organization and touches nothing of it", async () => {
    const strangerId = stranger.users.stranger!;
    const [before] = await sql`select email, full_name, mobile_cc, mobile, photo from kernel.users where id = ${strangerId}`;
    const error = await run(admin, "kernel.admin.user.create", {
      name: "Otro Nombre",
      email: before!.email,
      mobileCc: "57",
      mobile: "3109998877",
      roleIds: [memberRole],
    }).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "invalid_input", details: ["Ese correo ya pertenece a otra organización"] });
    expect(await membersOf(strangerId)).toEqual([stranger.companies[0]!.id]);
    const [after] = await sql`select email, full_name, mobile_cc, mobile, photo from kernel.users where id = ${strangerId}`;
    expect(after).toEqual(before);
    expect(auth.invited).toEqual([]);
  });

  it("user.create adds a user of the same organization without a new invitation", async () => {
    const neighbor = h.seed.users.neighbor!;
    const [profile] = await sql`select email, full_name from kernel.users where id = ${neighbor}`;
    const out = await run<{ userId: string; invited: boolean }>(admin, "kernel.admin.user.create", {
      name: "Nombre Distinto",
      email: profile!.email,
      mobileCc: "57",
      mobile: "3105551234",
      roleIds: [memberRole],
    });
    expect(out).toMatchObject({ userId: neighbor, invited: false });
    expect(auth.invited).toEqual([]);
    expect((await membersOf(neighbor)).sort()).toEqual([h.companyId, h.seed.companies[1]!.id].sort());
    const [after] = await sql`select full_name from kernel.users where id = ${neighbor}`;
    expect(after!.full_name).toBe(profile!.full_name);
  });

  it("refuses roles and users of another company", async () => {
    await expect(run(admin, "kernel.admin.role.update", { roleId: otherCompanyRole, description: "x" })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(run(admin, "kernel.admin.permission.set", { roleId: otherCompanyRole, processId: "core.party.create", allowed: true })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(run(admin, "kernel.admin.field_permission.set", { roleId: otherCompanyRole, entity: "core.party", field: "credit_limit", mode: "hidden" })).rejects.toMatchObject({
      code: "invalid_input",
    });
    await expect(run(admin, "kernel.admin.user_role.set", { roleId: otherCompanyRole, userIds: [h.seed.users.both] })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(run(admin, "kernel.admin.user_role.set", { userId: h.seed.users.both, roleIds: [otherCompanyRole] })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      run(admin, "kernel.admin.user.create", { name: "X", email: `x-${randomUUID().slice(0, 6)}@test.local`, mobileCc: "57", mobile: "3105551234", roleIds: [otherCompanyRole] }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    const [untouched] = await sql`select description from kernel.roles where id = ${otherCompanyRole}`;
    expect(untouched!.description).toBe("");
  });

  it("permission.set never gives an administration process to a non-admin role", async () => {
    for (const processId of ["kernel.admin.permission.set", "kernel.admin.user.create", "kernel.verifier.set"]) {
      await expect(run(admin, "kernel.admin.permission.set", { roleId: memberRole, processId, allowed: true })).rejects.toMatchObject({ code: "invalid_input" });
    }
  });

  it("the company admin runs every process and sees every field, whatever other role they hold", async () => {
    const adminRole = h.seed.companies[0]!.adminRoleId;
    await sql`delete from kernel.process_permissions where role_id = ${adminRole} and process_id = 'core.party.deactivate'`;
    const [can] = await withClaims(sql, admin.claims, (tx) => tx`select kernel.can_run_process('core.party.deactivate') as ok, kernel.can_run_process('core.never.registered') as other`);
    expect(can).toEqual({ ok: true, other: true });
    // A second role that masks the credit limit does not hide it from the admin.
    const { id } = (await runProcess(deps, admin, "core.party.create", { ...exito, documentNumber: "931000001", creditLimit: 3_000_000 })) as { id: string };
    await h.seed.holdRoles(admin.claims.sub, h.companyId, [memberRole]);
    const twoRoles = { ...admin.claims, role_ids: [adminRole, memberRole] };
    await sql`insert into kernel.field_permissions(company_id, role_id, entity, field, mode) values (${h.companyId}, ${memberRole}, 'core.party', 'credit_limit', 'masked')
              on conflict (company_id, role_id, entity, field) do update set mode = 'masked'`;
    const [row] = await withClaims(sql, twoRoles, (tx) => tx`select credit_limit, kernel.field_mode('core.party', 'credit_limit') as mode from core.v_parties where id = ${id}`);
    expect(row).toMatchObject({ mode: "visible" });
    expect(Number(row!.credit_limit)).toBe(3_000_000);
    await sql`delete from kernel.membership_roles where role_id = ${memberRole}
              and membership_id = (select id from kernel.memberships where user_id = ${admin.claims.sub} and company_id = ${h.companyId})`;
  });

  it("required_file.set refuses a tag the entity already requires, on create and on update", async () => {
    const first = await run<{ id: string }>(admin, "kernel.required_file.set", { entity: "core.product", tag: "Registro INVIMA", kind: "pdf", required: false });
    await expect(run(admin, "kernel.required_file.set", { entity: "core.product", tag: " registro invima ", kind: "any", required: true })).rejects.toMatchObject({
      code: "invalid_input",
    });
    const second = await run<{ id: string }>(admin, "kernel.required_file.set", { entity: "core.product", tag: "Ficha de seguridad", kind: "pdf", required: false });
    await expect(run(admin, "kernel.required_file.set", { id: second.id, entity: "core.product", tag: "Registro INVIMA", kind: "pdf", required: false })).rejects.toMatchObject({
      code: "invalid_input",
    });
    for (const id of [first.id, second.id]) await run(admin, "kernel.required_file.remove", { id });
  });
});
