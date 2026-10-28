import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { testDb, seedTenant } from "../db/test-db";
import { withClaims } from "../db/client";
import { writeAudit, setAuditContext } from "../audit/audit";
import { enqueueEvent } from "../events/outbox";

// Audit rows are append-only, so this suite never deletes them: every run seeds its own tenant.
describe("audit log and outbox", () => {
  let sql: ReturnType<typeof testDb>;
  let seed: Awaited<ReturnType<typeof seedTenant>>;
  const company = (index: number) => seed.companies[index]!;
  const adminClaims = (index = 0) => seed.claimsFor(seed.users.both, company(index).id);

  beforeAll(async () => {
    sql = testDb();
    seed = await seedTenant(sql, { companies: 2 });
  });
  afterAll(async () => {
    await seed.cleanup();
    await sql.end();
  });

  it("a direct update produces an audit row with a column diff and origin db", async () => {
    const roleId = company(0).memberRoleId;
    await withClaims(sql, adminClaims(), async (tx) => {
      await tx`update kernel.roles set name = 'renamed' where id = ${roleId}`;
    });
    const [row] = await sql`select * from kernel.audit_log where row_id = ${roleId} and action = 'update' order by occurred_at desc limit 1`;
    expect(row!.origin).toBe("db");
    expect(row!.entity).toBe("kernel.roles");
    expect(row!.company_id).toBe(company(0).id);
    expect(row!.actor_user_id).toBe(seed.users.both);
    expect(row!.diff).toEqual({ name: { old: "member", new: "renamed" } });
  });

  it("an update that changes nothing writes no audit row", async () => {
    const roleId = company(0).adminRoleId;
    const [beforeRow] = await sql<{ n: number }[]>`select count(*)::int as n from kernel.audit_log where row_id = ${roleId}`;
    await withClaims(sql, adminClaims(), async (tx) => {
      await tx`update kernel.roles set name = name where id = ${roleId}`;
    });
    const [afterRow] = await sql<{ n: number }[]>`select count(*)::int as n from kernel.audit_log where row_id = ${roleId}`;
    expect(afterRow!.n).toBe(beforeRow!.n);
  });

  it("a company update is audited under the company's own id and its admin can read it", async () => {
    const companyId = company(0).id;
    await sql`update kernel.companies set legal_name = 'Renamed S.A.S.' where id = ${companyId}`;
    const [row] = await sql`select * from kernel.audit_log where row_id = ${companyId} and action = 'update' order by occurred_at desc, id desc limit 1`;
    expect(row!.entity).toBe("kernel.companies");
    expect(row!.company_id).toBe(companyId);
    const visible = await withClaims(sql, adminClaims(), (tx) =>
      tx`select id from kernel.audit_log where id = ${row!.id}`);
    expect(visible).toHaveLength(1);
    const hidden = await withClaims(sql, adminClaims(1), (tx) =>
      tx`select id from kernel.audit_log where id = ${row!.id}`);
    expect(hidden).toHaveLength(0);
  });

  it("an update from NULL to a value records old null and the new value", async () => {
    const companyId = company(1).id;
    await sql`update kernel.companies set trade_name = 'Trade Name' where id = ${companyId}`;
    const [row] = await sql`select diff from kernel.audit_log where row_id = ${companyId} and action = 'update' order by occurred_at desc, id desc limit 1`;
    expect(row!.diff).toEqual({ trade_name: { old: null, new: "Trade Name" } });
  });

  it("an insert and a delete on kernel.roles are audited", async () => {
    const created = await withClaims(sql, adminClaims(), async (tx) => {
      const [role] = await tx<{ id: string }[]>`insert into kernel.roles(company_id, name) values (${company(0).id}, 'temp') returning id`;
      return role!.id;
    });
    await withClaims(sql, adminClaims(), async (tx) => {
      await tx`delete from kernel.roles where id = ${created}`;
    });
    const rows = await sql`select action, diff from kernel.audit_log where row_id = ${created} order by occurred_at, id`;
    expect(rows.map((r) => r.action)).toEqual(["insert", "delete"]);
    expect(rows[0]!.diff).toMatchObject({ name: { old: null, new: "temp" } });
    expect(rows[1]!.diff).toMatchObject({ name: { old: "temp", new: null } });
    expect(rows[0]!.diff).not.toHaveProperty("updated_at");
  });

  it("setAuditContext makes a direct update carry origin, process id and chain id", async () => {
    const roleId = company(0).memberRoleId;
    const chainId = randomUUID();
    const processId = "kernel.role.rename";
    const [current] = await sql<{ name: string }[]>`select name from kernel.roles where id = ${roleId}`;
    await withClaims(sql, adminClaims(), async (tx) => {
      await setAuditContext(tx, { origin: "ui", processId, chainId, actorUserId: seed.users.both });
      await tx`update kernel.roles set name = 'by-process' where id = ${roleId}`;
    });
    const [row] = await sql`select * from kernel.audit_log where row_id = ${roleId} and chain_id = ${chainId}`;
    expect(row!.origin).toBe("ui");
    expect(row!.process_id).toBe(processId);
    expect(row!.diff).toEqual({ name: { old: current!.name, new: "by-process" } });
  });

  it("the audit context is transaction-local", async () => {
    const roleId = company(0).memberRoleId;
    await withClaims(sql, adminClaims(), async (tx) => {
      await setAuditContext(tx, { origin: "agent", chainId: randomUUID(), actorUserId: seed.users.both });
    });
    await withClaims(sql, adminClaims(), async (tx) => {
      await tx`update kernel.roles set name = 'after-context' where id = ${roleId}`;
    });
    const [row] = await sql`select origin, process_id from kernel.audit_log where row_id = ${roleId} order by occurred_at desc, id desc limit 1`;
    expect(row).toMatchObject({ origin: "db", process_id: null });
  });

  it("audit rows cannot be updated or deleted", async () => {
    await expect(sql`delete from kernel.audit_log`).rejects.toThrow(/append-only/);
    await expect(sql`update kernel.audit_log set entity = 'x'`).rejects.toThrow(/append-only/);
    await expect(sql`truncate kernel.audit_log`).rejects.toThrow(/append-only/);
  });

  it("writeAudit records a process entry the caller can read back, and only for its own company", async () => {
    const chainId = randomUUID();
    const rowId = randomUUID();
    await withClaims(sql, adminClaims(), (tx) =>
      writeAudit(tx, {
        companyId: company(0).id,
        actorUserId: seed.users.both,
        origin: "agent",
        processId: "core.party.create",
        entity: "core.parties",
        rowId,
        action: "insert",
        input: { name: "Acme" },
        diff: { name: { old: null, new: "Acme" } },
        chainId,
        agentRunId: "run-1",
      }));
    const own = await withClaims(sql, adminClaims(), (tx) => tx`select * from kernel.audit_log where chain_id = ${chainId}`);
    expect(own).toHaveLength(1);
    expect(own[0]).toMatchObject({ origin: "agent", process_id: "core.party.create", input: { name: "Acme" }, agent_run_id: "run-1" });
    const other = await withClaims(sql, adminClaims(1), (tx) => tx`select * from kernel.audit_log where chain_id = ${chainId}`);
    expect(other).toHaveLength(0);
  });

  it("an authenticated caller cannot write audit rows for another company or as another user", async () => {
    const entry = { origin: "api" as const, entity: "x", action: "consult" as const, chainId: randomUUID() };
    await expect(withClaims(sql, adminClaims(), (tx) =>
      writeAudit(tx, { ...entry, companyId: company(1).id, actorUserId: seed.users.both })))
      .rejects.toMatchObject({ code: "42501" });
    await expect(withClaims(sql, adminClaims(), (tx) =>
      writeAudit(tx, { ...entry, companyId: company(0).id, actorUserId: seed.users.onlyA })))
      .rejects.toMatchObject({ code: "42501" });
  });

  it("enqueueEvent writes an undispatched outbox row", async () => {
    const chainId = randomUUID();
    const id = await sql.begin((tx) =>
      enqueueEvent(tx, { companyId: company(0).id, event: "core.party.created", payload: { id: "x" }, chainId }));
    const [row] = await sql`select dispatched_at, attempts, payload, chain_id from kernel.outbox where id = ${id}`;
    expect(row!.dispatched_at).toBeNull();
    expect(row!.attempts).toBe(0);
    expect(row!.payload).toEqual({ id: "x" });
    expect(row!.chain_id).toBe(chainId);
  });

  it("outbox rows are company-scoped and callers cannot mark them dispatched", async () => {
    const id = await withClaims(sql, adminClaims(), (tx) =>
      enqueueEvent(tx, { companyId: company(0).id, event: "core.party.created", payload: {}, chainId: randomUUID() }));
    expect(await withClaims(sql, adminClaims(1), (tx) => tx`select id from kernel.outbox where id = ${id}`)).toHaveLength(0);
    await expect(withClaims(sql, adminClaims(), (tx) => tx`update kernel.outbox set dispatched_at = now() where id = ${id}`))
      .rejects.toMatchObject({ code: "42501" });
    await expect(withClaims(sql, adminClaims(1), (tx) =>
      enqueueEvent(tx, { companyId: company(0).id, event: "e", payload: {}, chainId: randomUUID() })))
      .rejects.toMatchObject({ code: "42501" });
  });
});
