import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { syncRegistry } from "../../admin/sync";
import { withClaims } from "../../db/client";
import { seedTenant, testDb } from "../../db/test-db";
import { kernelModule } from "../../module/kernel-module";
import { loadModules } from "../../module/loader";
import type { Caller } from "../../process/context";
import { defineProcess } from "../../process/define";
import { runProcess } from "../../process/run";
import { runGridQuery } from "../../query/run";
import { defineEntity, Registry } from "../../registry";
import { maskedViewSql } from "../../security/masked-views";
import { describeAuditEntry, readAuditEntry, type AuditEntryDetail } from "../detail";

// Migration 0025_kernel_audit_source_and_user_state (rule 34) and the audit detail (design §22.13–14, rule 16):
//   * kernel.audit_log.source_row_id: runProcess(…, { sourceRowId }) records the record a creation was cloned from on the
//     process entry and, through the `erp.audit_source_row_id` setting, on the row trigger's insert entry (rule 37).
//   * kernel.v_audit_entries gives the company admin the entry's diff, input and source; grids, exports and consults read
//     the registry fields only, so they never carry diff or input.
//   * kernel.audit.entry: one entry with each changed field (label key, before, after) from the row changes of its run,
//     the input of a creation or a refusal, and the titles of its record and source; the viewer's field visibility
//     applies (masked: no values, hidden: left out).
//   * kernel.memberships.is_active (Task 7): kernel.current_role_ids() ignores an inactive membership.

/** Test-only entity over `kernel.audit_probe` (created below, audited by the row trigger). */
const PROBE = defineEntity({
  id: "kernel.audit_probe",
  module: "kernel",
  schema: "kernel",
  table: "audit_probe",
  label: "entity.kernel.audit_probe",
  displayField: "name",
  defaultSort: { field: "name", dir: "asc" },
  fields: [
    { name: "name", type: "text", label: "field.kernel.audit_probe.name" },
    { name: "kind", type: "enum", label: "field.kernel.audit_probe.kind", enumValues: ["customer", "supplier"], valuesKey: "grid.values.party_kind" },
    { name: "credit", type: "money", label: "field.kernel.audit_probe.credit", sensitivity: "confidential" },
    { name: "pin", type: "text", label: "field.kernel.audit_probe.pin" },
    // Declared, but a column named `secret` (or `token`, `password`) never reaches the audit (0025's trigger).
    { name: "secret", type: "text", label: "field.kernel.audit_probe.secret" },
    { name: "extra", type: "json", label: "field.kernel.audit_probe.extra", sortable: false },
  ],
});

const probeInput = z.object({
  name: z.string().min(1),
  kind: z.enum(["customer", "supplier"]).default("customer"),
  credit: z.number().optional(),
  pin: z.string().optional(),
  secret: z.string().optional(),
  // Not a field of the entity: the detail never shows it (fail closed).
  memo: z.string().optional(),
});

const probeCreate = defineProcess({
  id: "kernel.audit_probe.create",
  module: "kernel",
  kind: "create",
  description: "Crea un registro de prueba de la auditoría",
  input: probeInput,
  output: z.object({ id: z.string() }),
  handler: async (ctx, input) => {
    const [row] = await ctx.tx<{ id: string }[]>`
      insert into kernel.audit_probe (company_id, name, kind, credit, pin, secret)
      values (${ctx.companyId}, ${input.name}, ${input.kind}, ${input.credit ?? null}, ${input.pin ?? null}, ${input.secret ?? null}) returning id`;
    return { id: row!.id };
  },
});

const probeUpdate = defineProcess({
  id: "kernel.audit_probe.update",
  module: "kernel",
  kind: "update",
  description: "Cambia un registro de prueba de la auditoría",
  input: z.object({ id: z.uuid(), name: z.string(), credit: z.number(), pin: z.string(), extra: z.record(z.string(), z.unknown()).default({}) }),
  output: z.object({ id: z.string() }),
  handler: async (ctx, input) => {
    await ctx.tx`update kernel.audit_probe set name = ${input.name}, credit = ${input.credit}, pin = ${input.pin}, extra = ${ctx.tx.json(input.extra as never)}
      where id = ${input.id}`;
    return { id: input.id };
  },
});

const probeConsult = defineProcess({
  id: "kernel.audit_probe.consult",
  module: "kernel",
  kind: "consult",
  description: "Consulta los registros de prueba de la auditoría",
  input: z.object({}),
  output: z.object({}),
  handler: async () => ({}),
});

describe("kernel audit detail: before/after per field, source record, membership state (0025)", () => {
  let sql: ReturnType<typeof testDb>;
  let seed: Awaited<ReturnType<typeof seedTenant>>;
  let registry: Registry;
  let companyId: string;
  let memberRoleId: string;
  let admin: Caller;
  let member: Caller;
  let sourceId: string;
  let cloneId: string;

  const entryOf = async (where: { processId: string; rowId: string; processRow: boolean }) => {
    const [row] = await sql<{ id: string }[]>`
      select id from kernel.audit_log
      where company_id = ${companyId} and process_id = ${where.processId} and row_id = ${where.rowId}
        and (diff is null) = ${where.processRow}
      order by occurred_at desc limit 1`;
    return row!.id;
  };
  const detail = async (caller: Caller, id: string) => (await runProcess({ sql, registry }, caller, "kernel.audit.entry", { id })) as AuditEntryDetail;

  beforeAll(async () => {
    sql = testDb();
    // Test-only table, recreated each run (its columns change with the suite).
    // Checked first so a fresh database prints no "does not exist, skipping" notice.
    const [exists] = await sql<{ exists: boolean }[]>`select to_regclass('kernel.audit_probe') is not null as exists`;
    if (exists!.exists) {
      await sql`drop view if exists kernel.v_audit_probe`;
      await sql`drop table kernel.audit_probe`;
    }
    {
      await sql`create table kernel.audit_probe (
        id uuid primary key default kernel.uuid_v7(),
        company_id uuid not null,
        name text,
        kind text,
        credit numeric(18, 4),
        pin text,
        secret text,
        extra jsonb not null default '{}'::jsonb
      )`;
    }
    await sql`select kernel.enable_company_rls('kernel', 'audit_probe')`;
    await sql`grant select, insert, update on kernel.audit_probe to authenticated`;
    await sql`select kernel.enable_row_audit('kernel', 'audit_probe')`;
    await sql.unsafe(maskedViewSql(PROBE));

    registry = new Registry();
    loadModules(registry, [kernelModule]);
    registry.registerEntity(PROBE);
    for (const process of [probeCreate, probeUpdate, probeConsult]) registry.registerProcess(process);

    seed = await seedTenant(sql, { companies: 1, entitlements: [], users: [{ name: "member", companies: [0], role: "member" }] });
    companyId = seed.companies[0]!.id;
    memberRoleId = seed.companies[0]!.memberRoleId;
    admin = { claims: seed.claimsFor(seed.users.both, companyId), origin: "ui" };
    member = { claims: seed.claimsFor(seed.users.member!, companyId), origin: "ui" };
    await syncRegistry(sql, registry);
    await sql`select kernel.seed_company_defaults(${companyId})`;
    // The member's role sees the credit masked and the pin not at all; the admin-defined `canal` is the admin's only.
    await sql`insert into kernel.field_permissions (company_id, role_id, entity, field, mode) values
      (${companyId}, ${memberRoleId}, 'kernel.audit_probe', 'credit', 'masked'),
      (${companyId}, ${memberRoleId}, 'kernel.audit_probe', 'pin', 'hidden')`;
    const adminRoles = [seed.companies[0]!.adminRoleId];
    // The test entity's module ships no custom-field hook: the definition is stored without its triggers.
    await sql.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      await tx`insert into kernel.custom_fields (company_id, entity, key, label, type, max_length, required, roles_enter, roles_edit, roles_view)
        values (${companyId}, 'kernel.audit_probe', 'canal', 'Canal de venta', 'text', 20, false, ${adminRoles}, ${adminRoles}, ${adminRoles})`;
    });

    ({ id: sourceId } = await runProcess({ sql, registry }, admin, "kernel.audit_probe.create", { name: "Origen", pin: "p1", secret: "hunter2-origen" }));
    ({ id: cloneId } = await runProcess({ sql, registry }, admin, "kernel.audit_probe.create", { name: "Copia", kind: "supplier", credit: 250000, pin: "p2", secret: "hunter2-copia", memo: "nota-libre" }, { sourceRowId: sourceId }));
    await runProcess({ sql, registry }, admin, "kernel.audit_probe.update", { id: sourceId, name: "Bosque QA", credit: 1500000, pin: "p9", extra: { canal: "Norte" } });
  });

  afterAll(async () => {
    await sql`delete from kernel.audit_probe where company_id = ${companyId}`;
    await sql.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      await tx`delete from kernel.custom_fields where company_id = ${companyId}`;
    });
    await seed.cleanup();
    await sql.end();
  });

  describe("source_row_id (rule 37)", () => {
    it("is recorded on the creation's process entry and on its row change, and only there", async () => {
      const rows = await sql<{ source_row_id: string | null; process_row: boolean }[]>`
        select source_row_id, diff is null as process_row from kernel.audit_log where row_id = ${cloneId} and action = 'insert' order by process_row`;
      expect(rows).toEqual([
        { source_row_id: sourceId, process_row: false },
        { source_row_id: sourceId, process_row: true },
      ]);
      const plain = await sql`select source_row_id from kernel.audit_log where row_id = ${sourceId} and action = 'insert'`;
      expect(plain.map((r) => r.source_row_id)).toEqual([null, null]);
      // The setting is the transaction's: a later direct insert in the company carries no source.
      const [direct] = await sql<{ id: string }[]>`insert into kernel.audit_probe (company_id, name) values (${companyId}, 'Directo') returning id`;
      const [entry] = await sql`select source_row_id, origin from kernel.audit_log where row_id = ${direct!.id}`;
      expect(entry).toEqual({ source_row_id: null, origin: "db" });
    });

    it("is refused when it is not a record id, or on a process that creates nothing", async () => {
      await expect(runProcess({ sql, registry }, admin, "kernel.audit_probe.create", { name: "X" }, { sourceRowId: "not-a-uuid" })).rejects.toMatchObject({ code: "invalid_input" });
      await expect(
        runProcess({ sql, registry }, admin, "kernel.audit_probe.update", { id: sourceId, name: "Bosque QA", credit: 1500000, pin: "p9", extra: { canal: "Norte" } }, { sourceRowId: cloneId }),
      ).rejects.toMatchObject({ code: "invalid_input" });
    });
  });

  describe("kernel.v_audit_entries", () => {
    it("gives the company admin the diff, the input and the source; nobody else reads it", async () => {
      const rows = await withClaims(sql, admin.claims, (tx) => tx`select diff, input, source_row_id from kernel.v_audit_entries where row_id = ${cloneId} and action = 'insert' order by diff is null`);
      expect(rows[0]!.diff).toMatchObject({ name: { old: null, new: "Copia" } });
      expect(rows[1]!.input).toMatchObject({ name: "Copia", kind: "supplier" });
      expect(rows.map((r) => r.source_row_id)).toEqual([sourceId, sourceId]);
      expect(await withClaims(sql, member.claims, (tx) => tx`select id from kernel.v_audit_entries where row_id = ${cloneId}`)).toEqual([]);
    });

    it("keeps diff and input out of the grid, its exports and the consult (registry fields only)", async () => {
      const entity = registry.entity("kernel.audit");
      const page = await runGridQuery(sql, admin.claims, entity, { filters: [{ field: "row_id", op: "eq", value: cloneId }], sort: [], page: 1, pageSize: 10 });
      expect(page.rows.length).toBe(2);
      for (const row of page.rows) {
        expect(row).not.toHaveProperty("diff");
        expect(row).not.toHaveProperty("input");
        expect(row.source_row_id).toBe(sourceId);
      }
      const consult = (await runProcess({ sql, registry }, admin, "kernel.audit.consult", { filters: [{ field: "row_id", op: "eq", value: cloneId }] })) as { rows: Record<string, unknown>[] };
      expect(JSON.stringify(consult.rows)).not.toContain("250000");
    });
  });

  describe("kernel.audit.entry", () => {
    it("lists each changed field of an update with its label, before and after, from the row change of the run", async () => {
      for (const processRow of [true, false]) {
        const id = await entryOf({ processId: "kernel.audit_probe.update", rowId: sourceId, processRow });
        const out = await detail(admin, id);
        expect(out.entry).toMatchObject({ id, processId: "kernel.audit_probe.update", entityId: "kernel.audit_probe", entityLabel: "entity.kernel.audit_probe", rowId: sourceId, rowTitle: "Bosque QA", action: "update", sourceRowId: null });
        const byField = Object.fromEntries(out.changes.map((c) => [c.field, c]));
        expect(Object.keys(byField).sort()).toEqual(["credit", "extra.canal", "name", "pin"]);
        expect(byField.name).toEqual({ field: "name", labelKey: "field.kernel.audit_probe.name", type: "text", masked: false, before: "Origen", after: "Bosque QA" });
        expect(byField.credit).toMatchObject({ labelKey: "field.kernel.audit_probe.credit", type: "money", masked: false, before: null, after: 1500000 });
        expect(byField["extra.canal"]).toMatchObject({ labelKey: null, labelText: "Canal de venta", masked: false, before: null, after: "Norte" });
        // An update shows what changed, not what was sent.
        expect(out.input).toBeNull();
      }
    });

    it("shows a creation's input with the field labels, and the record it was cloned from", async () => {
      const out = await detail(admin, await entryOf({ processId: "kernel.audit_probe.create", rowId: cloneId, processRow: true }));
      expect(out.entry).toMatchObject({ action: "insert", rowTitle: "Copia", sourceRowId: sourceId, sourceTitle: "Bosque QA" });
      expect(out.changes.find((c) => c.field === "kind")).toMatchObject({ valuesKey: "grid.values.party_kind", before: null, after: "supplier" });
      expect(out.input).toEqual(
        expect.arrayContaining([
          { key: "name", field: "name", labelKey: "field.kernel.audit_probe.name", type: "text", masked: false, value: "Copia" },
          expect.objectContaining({ key: "kind", valuesKey: "grid.values.party_kind", value: "supplier" }),
        ]),
      );
      // Fail closed: a key the entity does not declare is not shown, and a secret column never is.
      expect(out.input!.map((i) => i.key).sort()).toEqual(["credit", "kind", "name", "pin"]);
      expect(JSON.stringify(out)).not.toContain("nota-libre");
      expect(JSON.stringify(out)).not.toContain("hunter2");
    });

    it("never records a column named secret, token or password in a row change's diff", async () => {
      const rows = await sql<{ diff: Record<string, unknown> }[]>`select diff from kernel.audit_log where row_id = ${cloneId} and diff is not null`;
      expect(rows).toHaveLength(1);
      expect(Object.keys(rows[0]!.diff)).toEqual(expect.arrayContaining(["name", "pin"]));
      expect(rows[0]!.diff).not.toHaveProperty("secret");
      expect(JSON.stringify(rows)).not.toContain("hunter2");
    });

    it("describes no field of a platform table without a registered entity (fail closed), and never its token", async () => {
      // An assistant confirmation card (0019): its bearer token is what 0020 hides from every reader.
      const token = `tok-${randomUUID()}-${randomUUID()}`;
      const [conversation] = await sql<{ id: string }[]>`
        insert into kernel.agent_conversations (company_id, user_id) values (${companyId}, ${seed.users.both}) returning id`;
      const [card] = await sql<{ id: string }[]>`
        insert into kernel.agent_confirmations (company_id, conversation_id, user_id, process_id, input, token)
        values (${companyId}, ${conversation!.id}, ${seed.users.both}, 'kernel.audit_probe.create', ${sql.json({ name: "X" })}, ${token}) returning id`;
      const [change] = await sql<{ id: string; diff: Record<string, unknown> }[]>`select id, diff from kernel.audit_log where row_id = ${card!.id} and action = 'insert'`;
      expect(change!.diff).not.toHaveProperty("token");
      expect(change!.diff).toHaveProperty("process_id");
      const out = await detail(admin, change!.id);
      expect(out.described).toBe(false);
      expect(out.changes).toEqual([]);
      expect(out.input).toBeNull();
      expect(JSON.stringify(out)).not.toContain(token);
      await sql`delete from kernel.agent_conversations where id = ${conversation!.id}`;
    });

    it("keeps two runs of one process on one record in one chain apart", async () => {
      const chainId = randomUUID();
      const inChain: Caller = { ...admin, chainId };
      const base = { id: cloneId, name: "Copia", credit: 250000, extra: {} };
      await runProcess({ sql, registry }, inChain, "kernel.audit_probe.update", { ...base, pin: "run-1" });
      await runProcess({ sql, registry }, inChain, "kernel.audit_probe.update", { ...base, pin: "run-2" });
      const runs = await sql<{ id: string }[]>`
        select id from kernel.audit_log where chain_id = ${chainId} and process_id = 'kernel.audit_probe.update' and diff is null order by occurred_at`;
      expect(runs).toHaveLength(2);
      const [first, second] = [await detail(admin, runs[0]!.id), await detail(admin, runs[1]!.id)];
      expect(first.changes.map((c) => [c.field, c.before, c.after])).toEqual([["pin", "p2", "run-1"]]);
      expect(second.changes.map((c) => [c.field, c.before, c.after])).toEqual([["pin", "run-1", "run-2"]]);
    });

    it("shows a refusal's input: the code and the process it was refused", async () => {
      await expect(runProcess({ sql, registry }, member, "kernel.audit_probe.update", { id: sourceId, name: "Nope", credit: 1, pin: "x" })).rejects.toMatchObject({ code: "forbidden" });
      const [denied] = await sql<{ id: string }[]>`
        select id from kernel.audit_log where company_id = ${companyId} and process_id = 'kernel.audit_probe.update' and action = 'denied' order by occurred_at desc limit 1`;
      const out = await detail(admin, denied!.id);
      expect(out.entry.action).toBe("denied");
      expect(out.changes).toEqual([]);
      expect(out.input).toEqual(expect.arrayContaining([expect.objectContaining({ key: "code", field: null, value: "forbidden" })]));
    });

    it("is the company admin's only, and an unknown entry is not_found", async () => {
      const id = await entryOf({ processId: "kernel.audit_probe.update", rowId: sourceId, processRow: true });
      await expect(detail(member, id)).rejects.toMatchObject({ code: "forbidden" });
      await expect(detail(admin, randomUUID())).rejects.toMatchObject({ code: "not_found" });
    });

    it("applies the viewer's field visibility: a masked field carries no values, a hidden one is left out", async () => {
      // The view is the admin's: the entry is read as the admin, then described as a member whose role masks the credit,
      // hides the pin and may not view `canal` (what a viewer who is not the admin would get).
      const updateId = await entryOf({ processId: "kernel.audit_probe.update", rowId: sourceId, processRow: true });
      const createId = await entryOf({ processId: "kernel.audit_probe.create", rowId: cloneId, processRow: true });
      const [updated, created] = await withClaims(sql, admin.claims, async (tx) => [(await readAuditEntry(tx, updateId))!, (await readAuditEntry(tx, createId))!]);
      const asMember = await withClaims(sql, member.claims, async (tx) => [await describeAuditEntry(tx, registry, updated!), await describeAuditEntry(tx, registry, created!)]);
      const [update, create] = asMember;
      expect(update!.changes.map((c) => c.field).sort()).toEqual(["credit", "name"]);
      expect(update!.changes.find((c) => c.field === "credit")).toEqual({ field: "credit", labelKey: "field.kernel.audit_probe.credit", type: "money", masked: true, before: null, after: null });
      expect(JSON.stringify(update)).not.toContain("1500000");
      expect(JSON.stringify(update)).not.toContain("p9");
      expect(JSON.stringify(update)).not.toContain("Norte");
      expect(create!.input!.map((i) => i.key).sort()).toEqual(["credit", "kind", "name"]);
      expect(create!.input!.find((i) => i.key === "credit")).toMatchObject({ masked: true, value: null });
      expect(JSON.stringify(create)).not.toContain("250000");
    });
  });

  describe("kernel.audit.entry granted to the system admin roles that already exist (0025)", () => {
    it("grants the process to a system admin role created before the migration, only to it, once", async () => {
      const adminRoleId = seed.companies[0]!.adminRoleId;
      await sql`delete from kernel.process_permissions where company_id = ${companyId} and process_id = 'kernel.audit.entry'`;
      const grants = () => sql<{ role_id: string }[]>`select role_id from kernel.process_permissions where company_id = ${companyId} and process_id = 'kernel.audit.entry' and allowed`;
      expect(await grants()).toEqual([]);
      // What 0025 runs for every company: the existing admin roles get the new process, a plain role does not.
      await sql`select kernel.grant_process_to_system_admins('kernel.audit.entry')`;
      expect(await grants()).toEqual([{ role_id: adminRoleId }]);
      await sql`select kernel.grant_process_to_system_admins('kernel.audit.entry')`;
      expect(await grants()).toHaveLength(1);
      // Users cannot call it.
      await expect(withClaims(sql, admin.claims, (tx) => tx`select kernel.grant_process_to_system_admins('kernel.audit.entry')`)).rejects.toThrow(/permission denied/);
    });
  });

  describe("kernel.memberships.is_active", () => {
    it("starts active, shows in v_memberships, and an inactive membership's roles no longer count", async () => {
      const userId = seed.users.member!;
      const [state] = await sql<{ is_active: boolean }[]>`select is_active from kernel.memberships where user_id = ${userId} and company_id = ${companyId}`;
      expect(state!.is_active).toBe(true);
      const listed = await withClaims(sql, admin.claims, (tx) => tx`select user_id, is_active from kernel.v_memberships where user_id = ${userId}`);
      expect(listed).toEqual([{ user_id: userId, is_active: true }]);
      const roles = () => withClaims(sql, member.claims, async (tx) => (await tx<{ ids: string[] }[]>`select kernel.current_role_ids() as ids`)[0]!.ids);
      expect(await roles()).toEqual([memberRoleId]);
      await sql`update kernel.memberships set is_active = false where user_id = ${userId} and company_id = ${companyId}`;
      try {
        expect(await roles()).toEqual([]);
        const listedInactive = await withClaims(sql, admin.claims, (tx) => tx`select is_active from kernel.v_memberships where user_id = ${userId}`);
        expect(listedInactive).toEqual([{ is_active: false }]);
      } finally {
        await sql`update kernel.memberships set is_active = true where user_id = ${userId} and company_id = ${companyId}`;
      }
      expect(await roles()).toEqual([memberRoleId]);
    });
  });
});
