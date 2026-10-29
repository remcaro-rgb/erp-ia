import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withClaims } from "../../db/client";
import { seedTenant, testDb } from "../../db/test-db";
import { loadModules } from "../../module/loader";
import { kernelModule } from "../../module/kernel-module";
import type { Caller } from "../../process/context";
import { runProcess } from "../../process/run";
import { Registry } from "../../registry";
import { gridDenial } from "../../query/access";
import { runGridQuery } from "../../query/run";
import { syncRegistry } from "../sync";

// Migration 0023_kernel_audit_view (rule 34) and the audit viewer (design §5.9, §6, rule 16): `kernel.v_audit_entries`
// is the company-wide audit log for the company admin only (`kernel.is_company_admin()`), with the actor's e-mail (and,
// since 0025, the recorded input, diff and source record, which only the entry's detail reads); `kernel.audit.consult`
// is a consult process of its own feature that only the admin role receives from the role defaults, and its grid
// (`kernel.audit`) opens only for a caller allowed it.

describe("kernel audit viewer: v_audit_entries and kernel.audit.consult", () => {
  let sql: ReturnType<typeof testDb>;
  let seed: Awaited<ReturnType<typeof seedTenant>>;
  let registry: Registry;
  let companyA: string;
  let companyB: string;
  let admin: Caller;
  let adminInB: Caller;
  let member: Caller;
  const chain = randomUUID();

  const entry = (companyId: string, actor: string, processId: string, origin = "ui") => sql`
    insert into kernel.audit_log (company_id, actor_user_id, origin, process_id, entity, row_id, action, input, diff, chain_id)
    values (${companyId}, ${actor}, ${origin}, ${processId}, 'core.parties', ${randomUUID()}, 'insert',
            ${sql.json({ creditLimit: 123456789 })}, ${sql.json({ credit_limit: { old: null, new: 123456789 } })}, ${chain})`;

  beforeAll(async () => {
    sql = testDb();
    registry = new Registry();
    loadModules(registry, [kernelModule]);
    seed = await seedTenant(sql, { companies: 2, entitlements: [], users: [{ name: "member", companies: [0], role: "member" }] });
    companyA = seed.companies[0]!.id;
    companyB = seed.companies[1]!.id;
    admin = { claims: seed.claimsFor(seed.users.both, companyA), origin: "ui" };
    adminInB = { claims: seed.claimsFor(seed.users.both, companyB), origin: "ui" };
    member = { claims: seed.claimsFor(seed.users.member!, companyA), origin: "ui" };
    await syncRegistry(sql, registry);
    await sql`select kernel.seed_company_defaults(${companyA})`;
    await sql`select kernel.seed_company_defaults(${companyB})`;
    await entry(companyA, seed.users.both, "probe.audit.admin", "agent");
    await entry(companyA, seed.users.member!, "probe.audit.member");
    await entry(companyB, seed.users.both, "probe.audit.other");
  });
  afterAll(async () => {
    await seed.cleanup();
    await sql.end();
  });

  const visible = (caller: Caller) =>
    withClaims(sql, caller.claims, (tx) => tx<Record<string, unknown>[]>`select * from kernel.v_audit_entries where chain_id = ${chain} order by process_id`);

  it("shows the company admin every entry of the active company, with the actor's e-mail, its input, diff and source (0025)", async () => {
    const rows = await visible(admin);
    expect(rows.map((r) => r.process_id)).toEqual(["probe.audit.admin", "probe.audit.member"]);
    expect(Object.keys(rows[0]!).sort()).toEqual([
      "action",
      "actor",
      "actor_user_id",
      "chain_id",
      "company_id",
      "conversation_id",
      "diff",
      "entity",
      "id",
      "input",
      "occurred_at",
      "origin",
      "process_id",
      "row_id",
      "source_row_id",
    ]);
    const mine = rows.find((r) => r.process_id === "probe.audit.admin")!;
    expect(mine).toMatchObject({ origin: "agent", entity: "core.parties", action: "insert", actor_user_id: seed.users.both, actor: expect.stringMatching(/^both-.*@test\.local$/) });
    // The detail of an entry (kernel.audit.entry) reads them; the grid, its exports and the consult never do.
    expect(mine.diff).toEqual({ credit_limit: { old: null, new: 123456789 } });
    const page = await runGridQuery(sql, admin.claims, registry.entity("kernel.audit"), { filters: [{ field: "chain_id", op: "eq", value: chain }], sort: [], page: 1, pageSize: 10 });
    expect(JSON.stringify(page.rows)).not.toContain("123456789");
  });

  it("follows the active company and shows nothing to a member who is not the admin", async () => {
    expect((await visible(adminInB)).map((r) => r.process_id)).toEqual(["probe.audit.other"]);
    expect(await visible(member)).toEqual([]);
    // Even with the process granted, the view itself is the admin's (rule 14: the view is the gate of every channel).
    const [role] = await sql<{ id: string }[]>`select id from kernel.roles where company_id = ${companyA} and name = 'member'`;
    await sql`insert into kernel.process_permissions (company_id, role_id, process_id) values (${companyA}, ${role!.id}, 'kernel.audit.consult')`;
    try {
      expect(await visible(member)).toEqual([]);
      await expect(runProcess({ sql, registry }, member, "kernel.audit.consult", {})).rejects.toMatchObject({ code: "forbidden" });
    } finally {
      await sql`delete from kernel.process_permissions where company_id = ${companyA} and role_id = ${role!.id} and process_id = 'kernel.audit.consult'`;
    }
  });

  it("registers kernel.audit.consult as a consult of feature kernel.audit, granted by the defaults to the admin role only, without step-up", async () => {
    const [registered] = await sql`select module_id, feature_id, kind, step_up from kernel.registered_processes where process_id = 'kernel.audit.consult'`;
    expect(registered).toMatchObject({ module_id: "kernel", feature_id: "kernel.audit", kind: "consult", step_up: false });
    const grants = await sql<{ name: string }[]>`
      select r.name from kernel.process_permissions pp join kernel.roles r on r.id = pp.role_id
      where pp.company_id = ${companyA} and pp.process_id = 'kernel.audit.consult'`;
    expect(grants.map((g) => g.name)).toEqual(["admin"]);
    expect(await sql`select 1 from kernel.sensitive_processes where company_id = ${companyA} and process_id = 'kernel.audit.consult'`).toHaveLength(0);
  });

  it("answers the admin's consult with a page of entries (filters, sort) and is itself audited as a consult", async () => {
    const result = await runProcess<never>({ sql, registry }, admin, "kernel.audit.consult", {
      filters: [{ field: "chain_id", op: "eq", value: chain }],
      sort: [{ field: "process_id", dir: "desc" }],
    });
    const { rows, total } = result as { rows: { process_id: string; actor: string }[]; total: number };
    expect(total).toBe(2);
    expect(rows.map((r) => r.process_id)).toEqual(["probe.audit.member", "probe.audit.admin"]);
    const [consulted] = await sql`select action, origin from kernel.audit_log where company_id = ${companyA} and process_id = 'kernel.audit.consult' order by occurred_at desc limit 1`;
    expect(consulted).toMatchObject({ action: "consult", origin: "ui" });
  });

  it("opens the kernel.audit grid for the admin and refuses it to the member", async () => {
    const entity = registry.entity("kernel.audit");
    expect(await gridDenial({ sql, registry }, admin.claims, entity)).toBeNull();
    expect(await gridDenial({ sql, registry }, member.claims, entity)).toBe("forbidden");
    const page = await runGridQuery(sql, admin.claims, entity, { filters: [{ field: "origin", op: "eq", value: "agent" }, { field: "chain_id", op: "eq", value: chain }], sort: [], page: 1, pageSize: 10 });
    expect(page.rows.map((r) => r.process_id)).toEqual(["probe.audit.admin"]);
  });
});
