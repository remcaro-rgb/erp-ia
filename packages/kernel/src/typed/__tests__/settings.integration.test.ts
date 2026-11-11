import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedTenant, testDb } from "../../db/test-db";
import { defineEntity, Registry } from "../../registry";
import { defineModule } from "../../module/define";
import { loadModules } from "../../module/loader";
import { kernelModule } from "../../module/kernel-module";
import { runProcess } from "../../process/run";
import type { Caller } from "../../process/context";
import { syncRegistry } from "../../admin/sync";
import { withClaims } from "../../db/client";

// Entity-type settings and state recipients (spec 2026-11-02 §5.4, §7, §9.2): admin-only, step-up, audited processes.

const entity = (id: string, entityType: "maestro" | "documento" | "parametro") =>
  defineEntity({
    entityType,
    id: `probe.${id}`,
    module: "probe",
    schema: "probe",
    table: id,
    label: `entity.probe.${id}`,
    displayField: "name",
    defaultSort: { field: "name", dir: "asc" },
    fields: [{ name: "name", type: "text" as const, label: "field.probe.name" }],
  });
const probeModule = defineModule({
  id: "probe",
  version: "0.0.1",
  dependsOn: [],
  entities: [entity("mas", "maestro"), entity("doc", "documento"), entity("par", "parametro")],
  processes: [],
  features: [],
  events: { emits: [], consumes: {} },
  navigation: [],
});

describe("kernel typed settings and recipients processes", () => {
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
  const run = async <T = unknown>(processId: string, input: unknown, caller = admin): Promise<T> => runProcess({ sql, registry }, await stepUp(caller), processId, input);
  const SETTINGS = "kernel.entity_type_settings.update";
  const RECIPIENTS = "kernel.state_recipients.update";

  beforeAll(async () => {
    sql = testDb();
    registry = new Registry();
    loadModules(registry, [kernelModule, probeModule]);
    seed = await seedTenant(sql, { companies: 1, entitlements: ["module:probe"], users: [{ name: "member", companies: [0], role: "member" }] });
    companyId = seed.companies[0]!.id;
    admin = { claims: seed.claimsFor(seed.users.both, companyId), origin: "ui" };
    member = { claims: seed.claimsFor(seed.users.member!, companyId), origin: "ui" };
    await syncRegistry(sql, registry);
    await sql`select kernel.seed_company_defaults(${companyId})`;
  });
  afterAll(async () => {
    await sql`delete from kernel.entity_fields where module_id = 'probe'`;
    await seed.cleanup();
    await sql.end();
  });

  it("a non-admin is forbidden", async () => {
    await expect(run(SETTINGS, { entity: "probe.doc", requiresApproval: true, posts: false }, member)).rejects.toMatchObject({ code: "forbidden" });
    await expect(run(RECIPIENTS, { entity: "probe.doc", status: "saved", emails: [] }, member)).rejects.toMatchObject({ code: "forbidden" });
  });

  it("both processes are step-up", async () => {
    for (const id of [SETTINGS, RECIPIENTS]) {
      const [row] = await sql`select step_up, kind from kernel.registered_processes where process_id = ${id}`;
      expect(row).toMatchObject({ step_up: true, kind: "update" });
    }
  });

  it("settings upsert on (company, entity)", async () => {
    await run(SETTINGS, { entity: "probe.doc", requiresApproval: true, posts: true });
    await run(SETTINGS, { entity: "probe.doc", requiresApproval: false, posts: true });
    const rows = await sql`select requires_approval, posts from kernel.entity_type_settings where company_id = ${companyId} and entity = 'probe.doc'`;
    expect(rows).toEqual([{ requires_approval: false, posts: true }]);
  });

  it("posts:true on a maestro is refused, requiresApproval alone is fine", async () => {
    await expect(run(SETTINGS, { entity: "probe.mas", requiresApproval: false, posts: true })).rejects.toMatchObject({ code: "invalid_input" });
    await run(SETTINGS, { entity: "probe.mas", requiresApproval: true, posts: false });
    const rows = await sql`select requires_approval, posts from kernel.entity_type_settings where company_id = ${companyId} and entity = 'probe.mas'`;
    expect(rows).toEqual([{ requires_approval: true, posts: false }]);
  });

  it("an unknown entity or a non-typed entity is refused", async () => {
    await expect(run(SETTINGS, { entity: "probe.nope", requiresApproval: false, posts: false })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(run(SETTINGS, { entity: "probe.par", requiresApproval: false, posts: false })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(run(RECIPIENTS, { entity: "probe.par", status: "saved", emails: [] })).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("a bad e-mail is invalid_input and names the address", async () => {
    const err = (await run(RECIPIENTS, { entity: "probe.doc", status: "approved", emails: ["ok@x.co", "no-es-correo"] }).catch((e: unknown) => e)) as { code?: string; details?: unknown };
    expect(err).toMatchObject({ code: "invalid_input" });
    expect(JSON.stringify(err.details)).toContain("no-es-correo");
  });

  it("status posted/voided on a maestro is refused, legal on a documento", async () => {
    await expect(run(RECIPIENTS, { entity: "probe.mas", status: "posted", emails: ["a@x.co"] })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(run(RECIPIENTS, { entity: "probe.mas", status: "voided", emails: ["a@x.co"] })).rejects.toMatchObject({ code: "invalid_input" });
    await run(RECIPIENTS, { entity: "probe.doc", status: "posted", emails: ["a@x.co"] });
  });

  it("recipients upsert, normalise and may be cleared", async () => {
    await run(RECIPIENTS, { entity: "probe.mas", status: "approved", emails: [" A@X.co ", "b@x.co", "a@x.co"] });
    const get = async () => (await sql`select emails from kernel.state_recipients where company_id = ${companyId} and entity = 'probe.mas' and status = 'approved'`).map((r) => r.emails);
    expect(await get()).toEqual([["a@x.co", "b@x.co"]]);
    await run(RECIPIENTS, { entity: "probe.mas", status: "approved", emails: [] });
    expect(await get()).toEqual([[]]);
  });

  it("only a company admin reads the state recipients (0052, final review m5): a member reads none", async () => {
    await run(RECIPIENTS, { entity: "probe.mas", status: "saved", emails: ["lector@x.co"] });
    const read = (caller: Caller) => withClaims(sql, caller.claims, (tx) => tx<{ emails: string[] }[]>`select emails from kernel.state_recipients where entity = 'probe.mas' and status = 'saved'`);
    expect(await read(admin)).toEqual([{ emails: ["lector@x.co"] }]);
    expect(await read(member)).toEqual([]);
  });

  it("0052: a member reads only their own audit rows of kernel.audit_log (no diff of the admin's changes); v_audit_log is as before; the admin reads all", async () => {
    // The admin's audited change of the recipients, and a refused (audited) run of the member.
    await run(RECIPIENTS, { entity: "probe.mas", status: "approved", emails: ["auditado@x.co"] });
    await expect(run(RECIPIENTS, { entity: "probe.mas", status: "approved", emails: [] }, member)).rejects.toMatchObject({ code: "forbidden" });
    const rows = (caller: Caller, view = "kernel.audit_log") =>
      withClaims(sql, caller.claims, (tx) => tx.unsafe<{ actor_user_id?: string; process_id: string }[]>(`select ${view === "kernel.audit_log" ? "actor_user_id, " : ""}process_id from ${view} where process_id = $1`, [RECIPIENTS]));
    const mine = await rows(member);
    expect(mine.length).toBeGreaterThan(0);
    expect(mine.every((r) => r.actor_user_id === seed.users.member)).toBe(true);
    expect((await rows(member, "kernel.v_audit_log")).length).toBe(mine.length);
    const all = await rows(admin);
    expect(all.some((r) => r.actor_user_id === seed.users.both)).toBe(true);
    // 0053: the recipients' entries of others (the row trigger's diffs hold the e-mails) stay the admin's; a member's own denials are theirs.
    const tableRows = (caller: Caller) => withClaims(sql, caller.claims, (tx) => tx.unsafe<{ diff: unknown }[]>("select diff from kernel.audit_log where entity = 'kernel.state_recipients' and actor_user_id is distinct from $1::uuid", [seed.users.member!]));
    expect(await tableRows(member)).toEqual([]);
    expect((await tableRows(admin)).length).toBeGreaterThan(0);
    // Inside a run on the same causal chain the chain's rows stay readable (the lifecycle's causingUser).
    const [adminRow] = await sql<{ chain_id: string }[]>`select chain_id from kernel.audit_log where company_id = ${companyId} and actor_user_id = ${seed.users.both} and process_id = ${RECIPIENTS} limit 1`;
    const onChain = await withClaims(sql, member.claims, async (tx) => {
      await tx`select set_config('erp.audit_chain_id', ${adminRow!.chain_id}, true)`;
      return tx`select 1 from kernel.audit_log where chain_id = ${adminRow!.chain_id}`;
    });
    expect(onChain.length).toBeGreaterThan(0);
  });

  it("changes are audited", async () => {
    const rows = await sql`select 1 from kernel.audit_log where company_id = ${companyId} and process_id = ${SETTINGS}`;
    expect(rows.length).toBeGreaterThan(0);
  });
});
