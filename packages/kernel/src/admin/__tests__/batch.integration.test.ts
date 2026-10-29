import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { seedTenant, testDb } from "../../db/test-db";
import { defineEntity, Registry } from "../../registry";
import { defineModule } from "../../module/define";
import { loadModules } from "../../module/loader";
import { kernelModule } from "../../module/kernel-module";
import { defineProcess } from "../../process/define";
import { runProcess } from "../../process/run";
import type { Caller } from "../../process/context";
import { ADMIN_FEATURE } from "../common";
import { syncRegistry } from "../sync";

// OD-7 (design §22.11): the admin matrices stage their cells and apply them together, with one step-up, through
// kernel.admin.permission.set_many and kernel.admin.field_permission.set_many. One transaction: a single invalid change
// refuses the whole batch with the failing index, and nothing is written. The process audit row lists every change;
// the row triggers still record the before/after of each grant (rule 16). Admin only, sensitive by default (rule 15).

const thing = defineEntity({
  id: "batchprobe.thing",
  module: "batchprobe",
  schema: "batchprobe",
  table: "thing",
  label: "entity.batchprobe.thing",
  displayField: "name",
  defaultSort: { field: "name", dir: "asc" },
  fields: ["name", "secret", "price"].map((name) => ({ name, type: "text" as const, label: `field.batchprobe.${name}`, ...(name === "secret" ? { sensitivity: "confidential" as const } : {}) })),
});
// The probe's processes: a consult and a few actions, so a plain role has well over 30 processes it may be given.
const probeProcesses = ["consult", "create", "update", "approve", "close", "reopen"].map((verb) =>
  defineProcess({
    id: `batchprobe.thing.${verb}`,
    module: "batchprobe",
    kind: verb === "consult" ? "consult" : verb === "create" ? "create" : "update",
    description: verb,
    input: z.object({}),
    output: z.object({}),
    handler: async () => ({}),
  }),
);
const probeModule = defineModule({
  id: "batchprobe",
  version: "0.0.1",
  dependsOn: [],
  entities: [thing],
  processes: probeProcesses,
  features: [{ id: "batchprobe.things", label: "feature.batchprobe.things", processes: probeProcesses.map((p) => p.id), entities: ["batchprobe.thing"] }],
  events: { emits: [], consumes: {} },
  navigation: [],
});

describe("kernel admin: batch changes with one step-up (OD-7)", () => {
  let sql: ReturnType<typeof testDb>;
  let seed: Awaited<ReturnType<typeof seedTenant>>;
  let registry: Registry;
  let companyId: string;
  let adminRole: string;
  let memberRole: string;
  let admin: Caller;
  let member: Caller;

  const stepUp = async (caller: Caller): Promise<Caller> => {
    const stepUpToken = randomUUID();
    await sql`insert into kernel.step_up_verifications(user_id, company_id, token) values (${caller.claims.sub}, ${companyId}, ${stepUpToken})`;
    return { ...caller, stepUpToken };
  };
  const run = async <T = unknown>(caller: Caller, processId: string, input: unknown): Promise<T> => runProcess({ sql, registry }, await stepUp(caller), processId, input);
  const grantsOf = async (roleId: string) =>
    (await sql<{ process_id: string }[]>`select process_id from kernel.process_permissions where role_id = ${roleId} and allowed`).map((r) => r.process_id);
  const modesOf = async (roleId: string) =>
    Object.fromEntries((await sql<{ field: string; mode: string }[]>`select field, mode from kernel.field_permissions where role_id = ${roleId} and entity = 'batchprobe.thing'`).map((r) => [r.field, r.mode]));
  /** The processes a plain role may be given: everything outside the administration feature. */
  const grantable = () => registry.processes().filter((p) => p.feature !== ADMIN_FEATURE);

  beforeAll(async () => {
    sql = testDb();
    registry = new Registry();
    loadModules(registry, [kernelModule, probeModule]);
    seed = await seedTenant(sql, { companies: 1, entitlements: ["module:batchprobe"], users: [{ name: "member", companies: [0], role: "member" }] });
    companyId = seed.companies[0]!.id;
    adminRole = seed.companies[0]!.adminRoleId;
    memberRole = seed.companies[0]!.memberRoleId;
    admin = { claims: seed.claimsFor(seed.users.both, companyId), origin: "ui" };
    member = { claims: seed.claimsFor(seed.users.member!, companyId), origin: "ui" };
    await syncRegistry(sql, registry);
    await sql`select kernel.seed_company_defaults(${companyId})`;
  });
  afterAll(async () => {
    await sql`delete from kernel.field_permissions where entity like 'batchprobe%'`;
    await sql`delete from kernel.entity_fields where module_id = 'batchprobe'`;
    await sql`delete from kernel.registered_processes where module_id = 'batchprobe'`;
    await sql`delete from kernel.module_features where module_id = 'batchprobe'`;
    await seed.cleanup();
    await sql.end();
  });

  it("both batch processes are registered as admin updates that always ask for the step-up, and sensitive by default", async () => {
    for (const id of ["kernel.admin.permission.set_many", "kernel.admin.field_permission.set_many"]) {
      const def = registry.process(id);
      expect(def).toMatchObject({ kind: "update", feature: ADMIN_FEATURE, sensitivity: "step-up" });
      const [row] = await sql`select feature_id, kind, step_up from kernel.registered_processes where process_id = ${id}`;
      expect(row).toMatchObject({ feature_id: ADMIN_FEATURE, kind: "update", step_up: true });
      const sensitive = await sql`select 1 from kernel.sensitive_processes where company_id = ${companyId} and process_id = ${id}`;
      expect(sensitive).toHaveLength(1);
    }
  });

  it("permission.set_many grants 30 processes in one call with one step-up, and one audit row lists the changes", async () => {
    // A role just created, with nothing granted yet: the admin sets it up in one go.
    const [role] = await sql<{ id: string }[]>`insert into kernel.roles(company_id, name) values (${companyId}, 'bodega') returning id`;
    const roleId = role!.id;
    const targets = grantable()
      .map((p) => p.id)
      .slice(0, 30);
    expect(targets).toHaveLength(30);
    const changes = targets.map((processId) => ({ roleId, processId, allowed: true }));

    const caller = await stepUp(admin);
    const output = await runProcess({ sql, registry }, caller, "kernel.admin.permission.set_many", { changes });
    expect(output).toEqual({ count: 30 });
    expect((await grantsOf(roleId)).sort()).toEqual([...targets].sort());
    // One code for the whole batch: the verification is consumed once.
    const [verification] = await sql`select consumed_at from kernel.step_up_verifications where token = ${caller.stepUpToken!}`;
    expect(verification!.consumed_at).not.toBeNull();

    const audit = await sql<{ entity: string; action: string; input: { changes: unknown[] } }[]>`
      select entity, action, input from kernel.audit_log
      where company_id = ${companyId} and process_id = 'kernel.admin.permission.set_many' and entity = 'kernel.admin.permission' and action = 'update'`;
    expect(audit).toHaveLength(1);
    expect(audit[0]!.action).toBe("update");
    expect(audit[0]!.input.changes).toEqual(changes);
    // The row trigger still records each grant under the batch's process (rule 16).
    const rows = await sql`select 1 from kernel.audit_log where company_id = ${companyId} and process_id = 'kernel.admin.permission.set_many' and entity = 'kernel.process_permissions'`;
    expect(rows).toHaveLength(30);

    // Revoking in a batch works the same way.
    await run(admin, "kernel.admin.permission.set_many", { changes: changes.slice(0, 5).map((c) => ({ ...c, allowed: false })) });
    const after = new Set(await grantsOf(roleId));
    for (const id of targets.slice(0, 5)) expect(after.has(id)).toBe(false);
    for (const id of targets.slice(5)) expect(after.has(id)).toBe(true);
  });

  it("one invalid change refuses the whole batch with its index and writes nothing", async () => {
    const before = await grantsOf(memberRole);
    const fresh = grantable()
      .map((p) => p.id)
      .filter((id) => !before.includes(id))
      .slice(0, 3);
    expect(fresh).toHaveLength(3);
    const valid = fresh.map((processId) => ({ roleId: memberRole, processId, allowed: true }));
    const cases: { change: unknown; message: RegExp }[] = [
      // An administration process is never given to another role.
      { change: { roleId: memberRole, processId: "kernel.admin.role.create", allowed: true }, message: /administración/ },
      { change: { roleId: memberRole, processId: "core.nope.run", allowed: true }, message: /no existe/ },
      // The system admin role is not edited from the matrix.
      { change: { roleId: adminRole, processId: fresh[0]!, allowed: false }, message: /admin/ },
      { change: { roleId: randomUUID(), processId: fresh[0]!, allowed: true }, message: /no pertenece/ },
    ];
    for (const { change, message } of cases) {
      const changes = [valid[0], valid[1], change, valid[2]];
      const error = await run(admin, "kernel.admin.permission.set_many", { changes }).catch((e: unknown) => e);
      expect(error).toMatchObject({ code: "invalid_input" });
      const details = (error as { details: { index: number; message: string }[] }).details;
      expect(details).toEqual([{ index: 2, message: expect.stringMatching(message) }]);
      expect((await grantsOf(memberRole)).sort()).toEqual([...before].sort());
    }
    const audit = await sql`
      select 1 from kernel.audit_log where company_id = ${companyId} and process_id = 'kernel.admin.permission.set_many' and action = 'update' and input -> 'changes' @> ${sql.json([valid[0]!])}`;
    expect(audit).toHaveLength(0);
  });

  it("the batch input is 1 to 500 changes with no repeated cell", async () => {
    const processId = grantable()[0]!.id;
    await expect(run(admin, "kernel.admin.permission.set_many", { changes: [] })).rejects.toMatchObject({ code: "invalid_input" });
    const tooMany = Array.from({ length: 501 }, () => ({ roleId: memberRole, processId, allowed: true }));
    await expect(run(admin, "kernel.admin.permission.set_many", { changes: tooMany })).rejects.toMatchObject({ code: "invalid_input" });
    const twice = [
      { roleId: memberRole, processId, allowed: true },
      { roleId: memberRole, processId, allowed: false },
    ];
    const error = await run(admin, "kernel.admin.permission.set_many", { changes: twice }).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "invalid_input" });
    expect(JSON.stringify((error as { details: unknown }).details)).toMatch(/repetid/);
    // The same role written in another case is the same cell (the uuid column does not care): refused, not a SQL error.
    const mixedCase = [
      { roleId: memberRole.toLowerCase(), processId, allowed: true },
      { roleId: memberRole.toUpperCase(), processId, allowed: false },
    ];
    await expect(run(admin, "kernel.admin.permission.set_many", { changes: mixedCase })).rejects.toMatchObject({ code: "invalid_input" });
    const fieldMixedCase = [
      { roleId: memberRole.toLowerCase(), entity: "batchprobe.thing", field: "price", mode: "masked" },
      { roleId: memberRole.toUpperCase(), entity: "batchprobe.thing", field: "price", mode: "hidden" },
    ];
    await expect(run(admin, "kernel.admin.field_permission.set_many", { changes: fieldMixedCase })).rejects.toMatchObject({ code: "invalid_input" });
    const fieldTwice = [
      { roleId: memberRole, entity: "batchprobe.thing", field: "price", mode: "masked" },
      { roleId: memberRole, entity: "batchprobe.thing", field: "price", mode: "hidden" },
    ];
    await expect(run(admin, "kernel.admin.field_permission.set_many", { changes: fieldTwice })).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("the matrix marks the administration processes, which only the admin role holds", async () => {
    const matrix = (await runProcess({ sql, registry }, admin, "kernel.admin.permission.matrix", {})) as { processes: { id: string; admin: boolean }[] };
    const adminOf = (id: string) => matrix.processes.find((p) => p.id === id)?.admin;
    expect(adminOf("kernel.admin.role.create")).toBe(true);
    expect(adminOf("kernel.admin.permission.set_many")).toBe(true);
    expect(adminOf("kernel.required_file.set")).toBe(true);
    expect(adminOf("kernel.import.run")).toBe(false);
    expect(adminOf("batchprobe.thing.create")).toBe(false);
  });

  it("a member is refused, even holding a grant of the batch process", async () => {
    const changes = [{ roleId: memberRole, processId: grantable()[0]!.id, allowed: true }];
    await expect(run(member, "kernel.admin.permission.set_many", { changes })).rejects.toMatchObject({ code: "forbidden" });
    await sql`insert into kernel.process_permissions(company_id, role_id, process_id) values (${companyId}, ${memberRole}, 'kernel.admin.permission.set_many')`;
    try {
      await expect(run(member, "kernel.admin.permission.set_many", { changes })).rejects.toMatchObject({ code: "forbidden" });
      await expect(run(member, "kernel.admin.field_permission.set_many", { changes: [{ roleId: memberRole, entity: "batchprobe.thing", field: "price", mode: "hidden" }] })).rejects.toMatchObject({
        code: "forbidden",
      });
    } finally {
      await sql`delete from kernel.process_permissions where role_id = ${memberRole} and process_id = 'kernel.admin.permission.set_many'`;
    }
    // Without the step-up the admin is asked for it, once, for the whole batch.
    await expect(runProcess({ sql, registry }, admin, "kernel.admin.permission.set_many", { changes })).rejects.toMatchObject({ code: "step_up_required" });
  });

  it("field_permission.set_many sets several modes at once and rolls back on an unknown field", async () => {
    expect(await modesOf(memberRole)).toEqual({ secret: "masked" });
    await run(admin, "kernel.admin.field_permission.set_many", {
      changes: [
        { roleId: memberRole, entity: "batchprobe.thing", field: "secret", mode: "visible" },
        { roleId: memberRole, entity: "batchprobe.thing", field: "price", mode: "hidden" },
        { roleId: memberRole, entity: "batchprobe.thing", field: "name", mode: "masked" },
      ],
    });
    expect(await modesOf(memberRole)).toEqual({ secret: "visible", price: "hidden", name: "masked" });
    const audit = await sql<{ input: { changes: unknown[] } }[]>`
      select input from kernel.audit_log where company_id = ${companyId} and process_id = 'kernel.admin.field_permission.set_many' and entity = 'kernel.admin.field_permission' and action = 'update'`;
    expect(audit).toHaveLength(1);
    expect(audit[0]!.input.changes).toHaveLength(3);

    const error = await run(admin, "kernel.admin.field_permission.set_many", {
      changes: [
        { roleId: memberRole, entity: "batchprobe.thing", field: "secret", mode: "hidden" },
        { roleId: memberRole, entity: "batchprobe.thing", field: "nope", mode: "hidden" },
      ],
    }).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "invalid_input", details: [{ index: 1, message: expect.stringMatching(/no existe/) }] });
    await expect(
      run(admin, "kernel.admin.field_permission.set_many", { changes: [{ roleId: adminRole, entity: "batchprobe.thing", field: "secret", mode: "hidden" }] }),
    ).rejects.toMatchObject({ code: "invalid_input", details: [{ index: 0 }] });
    expect(await modesOf(memberRole)).toEqual({ secret: "visible", price: "hidden", name: "masked" });
  });
});
