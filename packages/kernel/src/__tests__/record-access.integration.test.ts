import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { withClaims } from "../db/client";
import { seedTenant, testDb } from "../db/test-db";
import { defineEntity, Registry, type EntityDef } from "../registry";
import { defineModule } from "../module/define";
import { loadModules } from "../module/loader";
import { kernelModule } from "../module/kernel-module";
import { defineProcess } from "../process/define";
import type { ProcessError } from "../process/errors";
import { runProcess } from "../process/run";
import type { Caller } from "../process/context";
import { syncRegistry } from "../admin/sync";
import { maskedViewSql } from "../security/masked-views";
import { assertReferencesUsable, type TypedRecord } from "../typed/runner";

// Record-level access (entity types spec 2026-11-02 §9.1, D7, D11, D12; Phase 2A.5 Task 9): kernel.record_access narrows who may read,
// use, modify, delete or void one record of a maestro or documento. Read is enforced in RLS on the record's table, on its lines and on
// its detail rows (snapshots), so every view follows; use / modify / delete / void are enforced by runProcess and the lifecycle runner.
// Rules only narrow, never widen past the role's permissions, and never apply to company admins. No rows for a record = unrestricted.
// The aggregate side of D11 (trial balance totals) is tested in the accounting module (record-access.integration.test.ts there).
// The fixture module `ra` (schema ra_fixture) is created here, never in a migration.

const SCHEMA = "ra_fixture";
const field = (entity: string, name: string, type: EntityDef["fields"][number]["type"]) => ({ name, type, label: `field.${entity}.${name}` });
const refField = (entity: string, name: string) => ({ ...field(entity, name, "ref"), ref: { entity: "ra.mas", display: "name" } });
const trailer = (entity: string) => [field(entity, "extra", "json"), field(entity, "extra_free", "json"), field(entity, "created_at", "datetime"), field(entity, "updated_at", "datetime")];

const masEntity: EntityDef = {
  id: "ra.mas", module: "ra", schema: SCHEMA, table: "masters", label: "entity.ra.mas", entityType: "maestro", importKey: ["name"],
  processIds: { attach: "ra.mas.save" },
  displayField: "name", defaultSort: { field: "name", dir: "asc" },
  fields: [field("ra.mas", "name", "text"), field("ra.mas", "is_active", "boolean"), field("ra.mas", "status", "text"), ...trailer("ra.mas")],
};
const docEntity: EntityDef = {
  id: "ra.doc", module: "ra", schema: SCHEMA, table: "docs", label: "entity.ra.doc", entityType: "documento",
  typed: { numbering: "none", lines: { entity: "ra.doc_line", parentField: "doc_id" } },
  displayField: "name", defaultSort: { field: "name", dir: "asc" },
  fields: [field("ra.doc", "name", "text"), refField("ra.doc", "mas_id"), field("ra.doc", "status", "text"), ...trailer("ra.doc")],
};
const lineEntity: EntityDef = {
  id: "ra.doc_line", module: "ra", schema: SCHEMA, table: "doc_lines", label: "entity.ra.doc_line", entityType: "lines",
  displayField: "description", defaultSort: { field: "description", dir: "asc" },
  fields: [field("ra.doc_line", "doc_id", "uuid"), field("ra.doc_line", "description", "text"), refField("ra.doc_line", "mas_id")],
};
/** A plain company table with no entity type: its policies must stay exactly as before Task 9. */
const PLAIN_TABLE = "plain";

const createMas = defineProcess({
  id: "ra.mas.create", module: "ra", kind: "create", description: "Crea un maestro de prueba en Borrador",
  input: z.object({ name: z.string() }), output: z.object({ id: z.string() }),
  handler: async (ctx, input) => {
    const [row] = await ctx.tx<{ id: string }[]>`insert into ra_fixture.masters (company_id, name) values (${ctx.companyId}, ${input.name}) returning id`;
    return { id: row!.id };
  },
});
const createDoc = defineProcess({
  id: "ra.doc.create", module: "ra", kind: "create", description: "Crea un documento de prueba en Borrador",
  input: z.object({ name: z.string().default("Doc"), masId: z.string().nullable().optional(), lines: z.array(z.object({ description: z.string(), masId: z.string().nullable().optional() })).default([]) }),
  output: z.object({ id: z.string() }),
  handler: async (ctx, input) => {
    const [row] = await ctx.tx<{ id: string }[]>`
      insert into ra_fixture.docs (company_id, name, mas_id, posts, requires_approval) values (${ctx.companyId}, ${input.name}, ${input.masId ?? null}, false, false) returning id`;
    for (const line of input.lines) {
      await ctx.tx`insert into ra_fixture.doc_lines (company_id, doc_id, description, mas_id) values (${ctx.companyId}, ${row!.id}, ${line.description}, ${line.masId ?? null})`;
    }
    return { id: row!.id };
  },
});

/** A system path (posting engine, opening, year close) checks a documento's references: usability only when callerRights is false. */
const systemCheck = defineProcess({
  id: "ra.doc.system_check", module: "ra", kind: "update", description: "Revisa las referencias de un documento de prueba como lo haría un proceso del sistema",
  input: z.object({ id: z.string().uuid(), callerRights: z.boolean() }), output: z.object({ ok: z.boolean() }),
  handler: async (ctx, input) => {
    const [row] = await ctx.tx<TypedRecord[]>`select * from ra_fixture.docs where id = ${input.id}`;
    await assertReferencesUsable(ctx, ctx.registry.entity("ra.doc"), row!, { callerRights: input.callerRights });
    return { ok: true };
  },
});

const raModule = defineModule({
  id: "ra", version: "0.0.1", dependsOn: [],
  entities: [masEntity, docEntity, lineEntity],
  processes: [createMas, createDoc, systemCheck],
  features: [{ id: "ra.main", label: "feature.ra.main", processes: ["ra.mas.create", "ra.doc.create", "ra.doc.system_check"], entities: ["ra.mas", "ra.doc", "ra.doc_line"] }],
  events: { emits: [], consumes: {} },
  navigation: [],
});

const typedTable = (name: string, type: "maestro" | "documento", entity: string, columns: string) => `
  create table ${SCHEMA}.${name} (
    id uuid primary key default kernel.uuid_v7(), seq bigint not null, company_id uuid not null references kernel.companies (id),
    ${columns}
    extra jsonb not null default '{}'::jsonb, extra_free jsonb not null default '[]'::jsonb,
    created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
    created_by uuid default kernel.current_user_id(), updated_by uuid);
  select kernel.typed_columns('${SCHEMA}', '${name}', '${type}', '${entity}');`;
const TABLES_SQL = `
  drop schema if exists ${SCHEMA} cascade;
  create schema ${SCHEMA};
  -- A module that accepts files says how a file change affects its records (kernel.notify_attachments_changed): nothing here.
  drop schema if exists ra cascade;
  create schema ra;
  create function ra.attachments_changed(text, uuid, uuid) returns void language sql as $f$ select $f$;
  grant usage on schema ${SCHEMA} to authenticated, service_role;
  ${typedTable("masters", "maestro", "ra.mas", "name text,")}
  ${typedTable("docs", "documento", "ra.doc", "name text, mas_id uuid,")}
  create table ${SCHEMA}.doc_lines (
    id uuid primary key default kernel.uuid_v7(), seq bigint not null, company_id uuid not null references kernel.companies (id),
    doc_id uuid not null references ${SCHEMA}.docs (id), description text, mas_id uuid,
    created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
    created_by uuid default kernel.current_user_id(), updated_by uuid);
  create table ${SCHEMA}.${PLAIN_TABLE} (
    id uuid primary key default kernel.uuid_v7(), seq bigint not null, company_id uuid not null references kernel.companies (id), name text,
    created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
    created_by uuid default kernel.current_user_id(), updated_by uuid);
`;

const SET = "kernel.record_access.set";
const MEMBER_PROCESSES = [
  "ra.mas.create", "ra.doc.create", "ra.mas.save", "ra.mas.delete", "ra.doc.save", "ra.doc.void", "ra.doc.delete", "ra.doc.system_check",
  "kernel.attachment.add", "kernel.attachment.remove", "kernel.attachment.reorder", "kernel.attachment.list",
];

describe("record-level access (Task 9)", () => {
  let sql: ReturnType<typeof testDb>;
  let seed: Awaited<ReturnType<typeof seedTenant>>;
  let registry: Registry;
  let companyId: string;
  let memberRoleId: string;
  /** A second non-admin role, held by `viaRole` only. */
  let roleX: string;
  let admin: Caller;
  /** Member with no grant on the narrowed records. */
  let restricted: Caller;
  /** Member named by user grants. */
  let granted: Caller;
  /** Member holding roleX, named by role grants. */
  let viaRole: Caller;

  const stepUp = async (caller: Caller): Promise<Caller> => {
    const stepUpToken = randomUUID();
    await sql`insert into kernel.step_up_verifications(user_id, company_id, token) values (${caller.claims.sub}, ${companyId}, ${stepUpToken})`;
    return { ...caller, stepUpToken };
  };
  const run = <T = Record<string, unknown>>(caller: Caller, processId: string, input: unknown): Promise<T> => runProcess({ sql, registry }, caller, processId, input);
  const setAccess = async (input: unknown, caller: Caller = admin) => run(await stepUp(caller), SET, input);
  const refusal = async (promise: Promise<unknown>) => (await promise.then(() => null, (e: unknown) => e)) as ProcessError | null;
  /** What `caller` sees of `query` (a select against the fixture), through their own claims and RLS. */
  const seen = async (caller: Caller, query: string, params: unknown[] = []) =>
    withClaims(sql, caller.claims, (tx) => tx.unsafe<Record<string, unknown>[]>(query, params as never[]));
  const newMas = async (name = "Café") => {
    const { id } = await run<{ id: string }>(admin, "ra.mas.create", { name });
    await run(admin, "ra.mas.save", { id });
    return id;
  };
  const newDoc = async (input: Record<string, unknown> = {}, caller: Caller = admin) => (await run<{ id: string }>(caller, "ra.doc.create", input)).id;
  const clearAccess = async () => sql`delete from kernel.record_access where company_id = ${companyId}`;

  beforeAll(async () => {
    sql = testDb();
    await sql.unsafe(TABLES_SQL);
    for (const table of ["masters", "docs", "doc_lines", PLAIN_TABLE]) {
      await sql.unsafe(`select kernel.enable_company_rls('${SCHEMA}', '${table}')`);
      await sql.unsafe(`select kernel.enable_row_audit('${SCHEMA}', '${table}')`);
      await sql.unsafe(`create trigger assign_seq before insert on ${SCHEMA}.${table} for each row execute function core.assign_seq('ra.${table}')`);
      await sql.unsafe(`create trigger touch_row before update on ${SCHEMA}.${table} for each row execute function core.touch_row()`);
      await sql.unsafe(`grant select, insert, update, delete on ${SCHEMA}.${table} to authenticated`);
      await sql.unsafe(`grant all on ${SCHEMA}.${table} to service_role`);
    }
    // The lines of ra.doc inherit its read right (a module declares its line tables in its own migration).
    await sql`select kernel.typed_lines(${SCHEMA}, 'doc_lines', 'ra.doc', 'doc_id')`;
    for (const entity of [masEntity, docEntity, lineEntity]) {
      await sql.unsafe(maskedViewSql(defineEntity(entity)));
      await sql.unsafe(`grant select on ${SCHEMA}.v_${entity.table} to authenticated`);
    }

    registry = new Registry();
    loadModules(registry, [kernelModule, raModule]);
    seed = await seedTenant(sql, {
      companies: 2,
      entitlements: ["module:ra"],
      users: [
        { name: "restricted", companies: [0], role: "member" },
        { name: "granted", companies: [0], role: "member" },
        { name: "viaRole", companies: [0], role: "member" },
        // A member of both companies (M1: the rules of one company never follow them into the other).
        { name: "switcher", companies: [0, 1], role: "member" },
        // A member whose membership is deactivated (M3: no grant to them).
        { name: "inactive", companies: [0], role: "member" },
      ],
    });
    companyId = seed.companies[0]!.id;
    memberRoleId = seed.companies[0]!.memberRoleId;
    for (const company of seed.companies) {
      for (const id of MEMBER_PROCESSES) {
        await sql`insert into kernel.process_permissions(company_id, role_id, process_id) values (${company.id}, ${company.memberRoleId}, ${id})`;
      }
    }
    await sql`update kernel.memberships set is_active = false where user_id = ${seed.users.inactive!} and company_id = ${companyId}`;
    const [x] = await sql<{ id: string }[]>`insert into kernel.roles(company_id, name, is_system) values (${companyId}, 'role_x', false) returning id`;
    roleX = x!.id;
    await seed.holdRoles(seed.users.viaRole!, companyId, [roleX]);
    admin = { claims: seed.claimsFor(seed.users.both, companyId), origin: "ui" };
    restricted = { claims: seed.claimsFor(seed.users.restricted!, companyId), origin: "ui" };
    granted = { claims: seed.claimsFor(seed.users.granted!, companyId), origin: "ui" };
    const via = seed.claimsFor(seed.users.viaRole!, companyId);
    viaRole = { claims: { ...via, role_ids: [...via.role_ids, roleX] }, origin: "ui" };
    await syncRegistry(sql, registry);
  });
  afterAll(async () => {
    await sql`delete from kernel.entity_tables where module_id = 'ra'`;
    await sql`delete from kernel.entity_fields where module_id = 'ra'`;
    await sql`delete from kernel.record_access_tables where table_schema = ${SCHEMA}`;
    await sql.unsafe(`drop schema if exists ${SCHEMA} cascade`);
    await sql.unsafe(`drop schema if exists ra cascade`);
    await seed.cleanup();
    await sql.end();
  });

  describe("policies", () => {
    it("a typed table and a declared line table get the record read policy; a plain table keeps company_isolation only", async () => {
      const policies = await sql<{ tablename: string; policyname: string; permissive: string; cmd: string }[]>`
        select tablename, policyname, permissive, cmd from pg_policies where schemaname = ${SCHEMA} order by tablename, policyname`;
      const of = (table: string) => policies.filter((p) => p.tablename === table).map((p) => `${p.policyname}:${p.permissive}:${p.cmd}`);
      expect(of("masters")).toEqual(["company_isolation:PERMISSIVE:ALL", "record_access_read:RESTRICTIVE:SELECT"]);
      expect(of("docs")).toEqual(["company_isolation:PERMISSIVE:ALL", "record_access_read:RESTRICTIVE:SELECT"]);
      expect(of("doc_lines")).toEqual(["company_isolation:PERMISSIVE:ALL", "record_access_read:RESTRICTIVE:SELECT"]);
      expect(of(PLAIN_TABLE)).toEqual(["company_isolation:PERMISSIVE:ALL"]);
      const [lines] = await sql<{ qual: string }[]>`select qual from pg_policies where schemaname = ${SCHEMA} and tablename = 'doc_lines' and policyname = 'record_access_read'`;
      expect(lines!.qual).toContain("'ra.doc'");
      expect(lines!.qual).toContain("doc_id");
    });

    it("an access rule is never edited in place: an update of kernel.record_access is refused", async () => {
      const mas = await newMas("Inmutable");
      await setAccess({ entity: "ra.mas", recordId: mas, grants: [{ userId: seed.users.granted, rights: ["read"] }] });
      await expect(sql`update kernel.record_access set can_use = true where record_id = ${mas}`).rejects.toThrow(/record_access_immutable/);
      await clearAccess();
    });
  });

  describe("read (RLS)", () => {
    it("no rows for a record: every member reads it (unrestricted by default)", async () => {
      const mas = await newMas("Abierto");
      for (const caller of [admin, restricted, granted]) {
        expect(await seen(caller, `select id from ${SCHEMA}.masters where id = $1`, [mas])).toHaveLength(1);
        expect(await seen(caller, `select id from ${SCHEMA}.v_masters where id = $1`, [mas])).toHaveLength(1);
      }
    });

    it("a narrowed maestro: the restricted user sees it neither in the table nor in its view; the granted user and the admin do", async () => {
      const mas = await newMas("Cliente reservado");
      await setAccess({ entity: "ra.mas", recordId: mas, grants: [{ userId: seed.users.granted, rights: ["read"] }] });
      expect(await seen(restricted, `select id from ${SCHEMA}.masters where id = $1`, [mas])).toHaveLength(0);
      expect(await seen(restricted, `select id from ${SCHEMA}.v_masters where id = $1`, [mas])).toHaveLength(0);
      expect(await seen(granted, `select id from ${SCHEMA}.v_masters where id = $1`, [mas])).toHaveLength(1);
      expect(await seen(admin, `select id from ${SCHEMA}.v_masters where id = $1`, [mas])).toHaveLength(1);
      // Other records of the entity are untouched by the rule.
      const other = await newMas("Otro cliente");
      expect(await seen(restricted, `select id from ${SCHEMA}.v_masters where id = $1`, [other])).toHaveLength(1);
      await clearAccess();
    });

    it("a narrowed documento: its lines and its snapshots are hidden with it (D11)", async () => {
      const mas = await newMas("Insumo");
      const doc = await newDoc({ name: "Pedido reservado", masId: mas, lines: [{ description: "Línea 1", masId: mas }, { description: "Línea 2" }] });
      await run(admin, "ra.doc.save", { id: doc });
      expect(await seen(restricted, `select id from ${SCHEMA}.doc_lines where doc_id = $1`, [doc])).toHaveLength(2);
      await setAccess({ entity: "ra.doc", recordId: doc, grants: [{ userId: seed.users.granted, rights: ["read", "modify"] }] });
      for (const query of [
        `select id from ${SCHEMA}.docs where id = $1`,
        `select id from ${SCHEMA}.v_docs where id = $1`,
        `select id from ${SCHEMA}.doc_lines where doc_id = $1`,
        `select id from ${SCHEMA}.v_doc_lines where doc_id = $1`,
        `select id from kernel.record_snapshots where entity = 'ra.doc' and record_id = $1`,
      ]) {
        expect(await seen(restricted, query, [doc]), query).toHaveLength(0);
        expect((await seen(granted, query, [doc])).length, query).toBeGreaterThan(0);
        expect((await seen(admin, query, [doc])).length, query).toBeGreaterThan(0);
      }
      await clearAccess();
    });

    it("a role grant: a user holding the role reads the record, one without it does not", async () => {
      const mas = await newMas("Por rol");
      await setAccess({ entity: "ra.mas", recordId: mas, grants: [{ roleId: roleX, rights: ["read"] }] });
      expect(await seen(viaRole, `select id from ${SCHEMA}.v_masters where id = $1`, [mas])).toHaveLength(1);
      expect(await seen(granted, `select id from ${SCHEMA}.v_masters where id = $1`, [mas])).toHaveLength(0);
      await clearAccess();
    });

    it("can_access_record: admin always, no rows always, otherwise only a grantee with the right", async () => {
      const mas = await newMas("Función");
      const ask = async (caller: Caller, right: string) =>
        (await withClaims(sql, caller.claims, (tx) => tx<{ ok: boolean }[]>`select kernel.can_access_record('ra.mas', ${mas}::uuid, ${right}) as ok`))[0]!.ok;
      expect(await ask(restricted, "use")).toBe(true);
      await setAccess({ entity: "ra.mas", recordId: mas, grants: [{ userId: seed.users.granted, rights: ["read", "use"] }] });
      expect(await ask(restricted, "read")).toBe(false);
      expect(await ask(granted, "read")).toBe(true);
      expect(await ask(granted, "use")).toBe(true);
      expect(await ask(granted, "modify")).toBe(false);
      for (const right of ["read", "use", "modify", "delete"]) expect(await ask(admin, right)).toBe(true);
      await expect(withClaims(sql, granted.claims, (tx) => tx`select kernel.can_access_record('ra.mas', ${mas}::uuid, 'fly')`)).rejects.toThrow();
      await clearAccess();
    });
  });

  describe("use (documento validation)", () => {
    it("a granted user who may read but not use the maestro: Grabar of a documento naming it is refused with record_forbidden", async () => {
      const mas = await newMas("Solo lectura");
      await setAccess({ entity: "ra.mas", recordId: mas, grants: [{ userId: seed.users.granted, rights: ["read"] }] });
      const header = await newDoc({ masId: mas }, granted);
      const refusedHeader = await refusal(run(granted, "ra.doc.save", { id: header }));
      expect(refusedHeader).toMatchObject({ code: "record_forbidden", details: { field: "mas_id", entity: "ra.mas", recordId: mas, right: "use" } });
      const line = await newDoc({ lines: [{ description: "x", masId: mas }] }, granted);
      const refusedLine = await refusal(run(granted, "ra.doc.save", { id: line }));
      expect(refusedLine).toMatchObject({ code: "record_forbidden", details: { field: "mas_id", entity: "ra.mas", recordId: mas, right: "use" } });
      expect((refusedLine!.details as { lineId?: string }).lineId).toBeTruthy();
      // Nothing persisted: the documento is still Borrador.
      expect((await sql`select status from ${sql(SCHEMA)}.docs where id = ${header}`)[0]!.status).toBe("draft");

      // With the use right the same Grabar goes through.
      await setAccess({ entity: "ra.mas", recordId: mas, grants: [{ userId: seed.users.granted, rights: ["read", "use"] }] });
      await expect(run(granted, "ra.doc.save", { id: header })).resolves.toMatchObject({ status: "saved" });
      await clearAccess();
    });

    it("a maestro the caller cannot read is refused exactly as an id that does not exist (no existence leak)", async () => {
      const mas = await newMas("Oculto");
      await setAccess({ entity: "ra.mas", recordId: mas, grants: [{ userId: seed.users.granted, rights: ["read", "use"] }] });
      const ghost = randomUUID();
      const hidden = await refusal(run(restricted, "ra.doc.save", { id: await newDoc({ masId: mas }, restricted) }));
      const missing = await refusal(run(restricted, "ra.doc.save", { id: await newDoc({ masId: ghost }, restricted) }));
      expect(hidden?.code).toBe("maestro_not_usable");
      expect(missing?.code).toBe("maestro_not_usable");
      const shape = (e: ProcessError | null, id: string) => ({ message: e!.message.replace(id, "<id>").replace(/ra\.doc [0-9a-f-]{36}/, "ra.doc <doc>"), details: { ...(e!.details as object), recordId: "<id>" } });
      expect(shape(hidden, mas)).toEqual(shape(missing, ghost));
      await clearAccess();
    });

    it("the admin is never narrowed: they use a maestro restricted to someone else", async () => {
      const mas = await newMas("Restringido a otro");
      await setAccess({ entity: "ra.mas", recordId: mas, grants: [{ userId: seed.users.granted, rights: ["read"] }] });
      await expect(run(admin, "ra.doc.save", { id: await newDoc({ masId: mas }) })).resolves.toMatchObject({ status: "saved" });
      await clearAccess();
    });
  });

  describe("modify, delete, void (runProcess guard)", () => {
    it("void is enforced on a documento: read + modify but no void → record_forbidden; with void → Anulado", async () => {
      const doc = await newDoc({ name: "Para anular" });
      await run(admin, "ra.doc.save", { id: doc });
      await setAccess({ entity: "ra.doc", recordId: doc, grants: [{ userId: seed.users.granted, rights: ["read", "modify"] }] });
      const refused = await refusal(run(granted, "ra.doc.void", { id: doc, reason: "Error" }));
      expect(refused).toMatchObject({ code: "record_forbidden", details: { entity: "ra.doc", recordId: doc, right: "void" } });
      expect((await sql`select status from ${sql(SCHEMA)}.docs where id = ${doc}`)[0]!.status).toBe("saved");
      // The refusal is audited as a denial.
      const [denied] = await sql`select input from kernel.audit_log where company_id = ${companyId} and actor_user_id = ${seed.users.granted!} and action = 'denied' and process_id = 'ra.doc.void' order by occurred_at desc limit 1`;
      expect(denied?.input).toMatchObject({ code: "record_forbidden" });

      await setAccess({ entity: "ra.doc", recordId: doc, grants: [{ userId: seed.users.granted, rights: ["read", "modify", "void"] }] });
      await expect(run(granted, "ra.doc.void", { id: doc, reason: "Error" })).resolves.toMatchObject({ status: "voided" });
      await clearAccess();
    });

    it("modify is enforced: read only → Grabar refused with record_forbidden; the restricted user gets not_found as for a missing id", async () => {
      const doc = await newDoc({ name: "Solo ver" });
      await setAccess({ entity: "ra.doc", recordId: doc, grants: [{ userId: seed.users.granted, rights: ["read"] }] });
      expect(await refusal(run(granted, "ra.doc.save", { id: doc }))).toMatchObject({ code: "record_forbidden", details: { right: "modify" } });
      const hidden = await refusal(run(restricted, "ra.doc.save", { id: doc }));
      const ghost = randomUUID();
      const missing = await refusal(run(restricted, "ra.doc.save", { id: ghost }));
      expect(hidden?.code).toBe("not_found");
      expect(missing?.code).toBe("not_found");
      expect(hidden!.message.replace(doc, "<id>")).toBe(missing!.message.replace(ghost, "<id>"));
      expect(hidden!.details).toEqual(missing!.details);
      await clearAccess();
    });

    it("delete is enforced on a maestro", async () => {
      const mas = await newMas("No borrar");
      await setAccess({ entity: "ra.mas", recordId: mas, grants: [{ userId: seed.users.granted, rights: ["read", "modify"] }] });
      expect(await refusal(run(granted, "ra.mas.delete", { id: mas }))).toMatchObject({ code: "record_forbidden", details: { right: "delete" } });
      await setAccess({ entity: "ra.mas", recordId: mas, grants: [{ userId: seed.users.granted, rights: ["read", "delete"] }] });
      await expect(run(granted, "ra.mas.delete", { id: mas })).resolves.toMatchObject({ deleted: true });
      await clearAccess();
    });

    it("a rule never widens past the role: a grant of void to a user whose role may not run void is still forbidden", async () => {
      const doc = await newDoc({ name: "Sin permiso de rol" });
      await run(admin, "ra.doc.save", { id: doc });
      await sql`delete from kernel.process_permissions where company_id = ${companyId} and role_id = ${memberRoleId} and process_id = 'ra.doc.void'`;
      try {
        await setAccess({ entity: "ra.doc", recordId: doc, grants: [{ userId: seed.users.granted, rights: ["read", "modify", "void"] }] });
        expect(await refusal(run(granted, "ra.doc.void", { id: doc, reason: "x" }))).toMatchObject({ code: "forbidden" });
      } finally {
        await sql`insert into kernel.process_permissions(company_id, role_id, process_id) values (${companyId}, ${memberRoleId}, 'ra.doc.void')`;
        await clearAccess();
      }
    });

    it("the admin is never narrowed: they Grabar and Anular a documento restricted to someone else", async () => {
      const doc = await newDoc({ name: "Del admin" });
      await setAccess({ entity: "ra.doc", recordId: doc, grants: [{ userId: seed.users.granted, rights: ["read"] }] });
      await expect(run(admin, "ra.doc.save", { id: doc })).resolves.toMatchObject({ status: "saved" });
      await expect(run(admin, "ra.doc.void", { id: doc, reason: "x" })).resolves.toMatchObject({ status: "voided" });
      await clearAccess();
    });
  });

  describe("kernel.record_access.set", () => {
    it("is admin-only and step-up", async () => {
      const mas = await newMas("Proceso");
      expect(await refusal(setAccess({ entity: "ra.mas", recordId: mas, grants: [] }, granted))).toMatchObject({ code: "forbidden" });
      expect(await refusal(run(admin, SET, { entity: "ra.mas", recordId: mas, grants: [] }))).toMatchObject({ code: "step_up_required" });
      const [row] = await sql`select step_up, kind from kernel.registered_processes where process_id = ${SET}`;
      expect(row).toMatchObject({ step_up: true, kind: "update" });
    });

    it("refuses rights the entity type does not have, a grant without read, two grantees, and an unknown record", async () => {
      const mas = await newMas("Validación");
      const doc = await newDoc({ name: "Validación" });
      const bad = async (input: unknown) => (await refusal(setAccess(input)))?.code;
      expect(await bad({ entity: "ra.mas", recordId: mas, grants: [{ userId: seed.users.granted, rights: ["read", "void"] }] })).toBe("invalid_input");
      expect(await bad({ entity: "ra.doc", recordId: doc, grants: [{ userId: seed.users.granted, rights: ["read", "use"] }] })).toBe("invalid_input");
      expect(await bad({ entity: "ra.doc", recordId: doc, grants: [{ userId: seed.users.granted, rights: ["read", "delete"] }] })).toBe("invalid_input");
      expect(await bad({ entity: "ra.mas", recordId: mas, grants: [{ userId: seed.users.granted, rights: ["use"] }] })).toBe("invalid_input");
      expect(await bad({ entity: "ra.mas", recordId: mas, grants: [{ userId: seed.users.granted, roleId: roleX, rights: ["read"] }] })).toBe("invalid_input");
      expect(await bad({ entity: "ra.mas", recordId: mas, grants: [{ userId: seed.users.granted, rights: ["read"] }, { userId: seed.users.granted, rights: ["read", "use"] }] })).toBe("invalid_input");
      expect(await bad({ entity: "ra.doc_line", recordId: mas, grants: [] })).toBe("invalid_input");
      expect(await bad({ entity: "ra.mas", recordId: randomUUID(), grants: [] })).toBe("not_found");
      expect(await bad({ entity: "ra.mas", recordId: mas, grants: [{ userId: randomUUID(), rights: ["read"] }] })).toBe("invalid_input");
      expect(await bad({ entity: "ra.mas", recordId: mas, grants: [{ roleId: randomUUID(), rights: ["read"] }] })).toBe("invalid_input");
      expect(await sql`select 1 from kernel.record_access where record_id = any(${[mas, doc]}::uuid[])`).toHaveLength(0);
    });

    it("replaces the whole set, audited; an empty set makes the record unrestricted again", async () => {
      const mas = await newMas("Reemplazo");
      await setAccess({ entity: "ra.mas", recordId: mas, grants: [{ userId: seed.users.granted, rights: ["read", "use"] }, { roleId: roleX, rights: ["read"] }] });
      const rows = async () => sql<{ grantee_user_id: string | null; grantee_role_id: string | null; can_read: boolean; can_use: boolean; can_modify: boolean; can_delete: boolean; can_void: boolean }[]>`
        select grantee_user_id, grantee_role_id, can_read, can_use, can_modify, can_delete, can_void from kernel.record_access where company_id = ${companyId} and entity = 'ra.mas' and record_id = ${mas} order by grantee_role_id nulls first`;
      expect(await rows()).toEqual([
        { grantee_user_id: seed.users.granted, grantee_role_id: null, can_read: true, can_use: true, can_modify: false, can_delete: false, can_void: false },
        { grantee_user_id: null, grantee_role_id: roleX, can_read: true, can_use: false, can_modify: false, can_delete: false, can_void: false },
      ]);
      await setAccess({ entity: "ra.mas", recordId: mas, grants: [{ roleId: roleX, rights: ["read", "modify"] }] });
      expect(await rows()).toEqual([{ grantee_user_id: null, grantee_role_id: roleX, can_read: true, can_use: false, can_modify: true, can_delete: false, can_void: false }]);
      expect(await seen(granted, `select id from ${SCHEMA}.v_masters where id = $1`, [mas])).toHaveLength(0);

      // The process run and every row change are in the append-only audit log (the history of the rules).
      const [audit] = await sql`select input from kernel.audit_log where company_id = ${companyId} and process_id = ${SET} and action = 'update' order by occurred_at desc limit 1`;
      expect(audit?.input).toMatchObject({ entity: "ra.mas", recordId: mas });
      const rowAudit = await sql`select action from kernel.audit_log where company_id = ${companyId} and entity = 'kernel.record_access' order by occurred_at`;
      expect(rowAudit.map((r) => r.action)).toEqual(expect.arrayContaining(["insert", "delete"]));

      await setAccess({ entity: "ra.mas", recordId: mas, grants: [] });
      expect(await rows()).toEqual([]);
      expect(await seen(granted, `select id from ${SCHEMA}.v_masters where id = $1`, [mas])).toHaveLength(1);
    });

    it("a non-admin cannot write kernel.record_access directly (RLS)", async () => {
      const mas = await newMas("Directo");
      await expect(withClaims(sql, granted.claims, (tx) => tx`
        insert into kernel.record_access (company_id, entity, record_id, grantee_user_id, can_read) values (${companyId}, 'ra.mas', ${mas}, ${seed.users.granted!}, true)`)).rejects.toThrow();
    });
  });

  describe("fix round 1", () => {
    it("I5: the read policies are set-based: a restricted count of 100k lines takes well under a second with a rule in force", async () => {
      const big = await newDoc({ name: "Volumen" });
      const narrowed = await newDoc({ name: "Con regla" });
      await setAccess({ entity: "ra.doc", recordId: narrowed, grants: [{ userId: seed.users.granted, rights: ["read"] }] });
      const ROWS = 100_000;
      await sql.begin(async (tx) => {
        await tx`set local session_replication_role = replica`;
        await tx`insert into ra_fixture.doc_lines (company_id, doc_id, seq, description) select ${companyId}, ${big}, 1000000 + g, 'x' from generate_series(1, ${ROWS}) g`;
      });
      await sql`analyze ra_fixture.doc_lines`;
      try {
        const timed = async (caller: Caller) => {
          const started = performance.now();
          const [row] = await seen(caller, `select count(*)::int as n from ${SCHEMA}.doc_lines where doc_id = $1`, [big]);
          return { n: row!.n as number, ms: performance.now() - started };
        };
        await timed(restricted);
        const restrictedRun = await timed(restricted);
        const adminRun = await timed(admin);
        console.info(`record_access I5: ${ROWS} lines, restricted ${restrictedRun.ms.toFixed(0)} ms, admin ${adminRun.ms.toFixed(0)} ms`);
        expect(restrictedRun.n).toBe(ROWS);
        expect(adminRun.n).toBe(ROWS);
        expect(restrictedRun.ms).toBeLessThan(1000);
        // The policies call no per-row plpgsql: the hidden ids are computed once per statement.
        const quals = await sql<{ qual: string }[]>`select qual from pg_policies where policyname = 'record_access_read'`;
        for (const { qual } of quals) expect(qual).not.toContain("can_access_record");
      } finally {
        await sql.begin(async (tx) => {
          await tx`set local session_replication_role = replica`;
          await tx`delete from ra_fixture.doc_lines where doc_id = ${big}`;
        });
        await clearAccess();
      }
    }, 120_000);

    it("I5: snapshots, mail log and attachments filter only the entity the rule targets", async () => {
      const doc = await newDoc({ name: "Detalle" });
      await run(admin, "ra.doc.save", { id: doc });
      // A detail row of another entity carrying the same id is not hidden by a rule on ra.doc.
      await sql.begin(async (tx) => {
        await tx`set local session_replication_role = replica`;
        await tx`insert into kernel.record_snapshots (company_id, entity, record_id, status, payload, seq)
                 select company_id, 'ra.mas', record_id, status, payload, seq + 900000 from kernel.record_snapshots where entity = 'ra.doc' and record_id = ${doc} limit 1`;
      });
      await setAccess({ entity: "ra.doc", recordId: doc, grants: [{ userId: seed.users.granted, rights: ["read"] }] });
      const snaps = await seen(restricted, `select entity from kernel.record_snapshots where record_id = $1`, [doc]);
      expect(snaps.map((r) => r.entity)).toEqual(["ra.mas"]);
      await sql.begin(async (tx) => {
        await tx`set local session_replication_role = replica`;
        await tx`delete from kernel.record_snapshots where entity = 'ra.mas' and record_id = ${doc}`;
      });
      await clearAccess();
    });

    it("M1: a rule of company A narrows A only; a member switching to B and back follows the active company; an admin of B only is narrowed in A", async () => {
      const mas = await newMas("Solo en A");
      await setAccess({ entity: "ra.mas", recordId: mas, grants: [{ userId: seed.users.granted, rights: ["read"] }] });
      const companyB = seed.companies[1]!;
      const adminB: Caller = { claims: seed.claimsFor(seed.users.both, companyB.id), origin: "ui" };
      const { id: masB } = await run<{ id: string }>(adminB, "ra.mas.create", { name: "En B" });
      const inA: Caller = { claims: seed.claimsFor(seed.users.switcher!, companyId), origin: "ui" };
      const inB: Caller = { claims: seed.claimsFor(seed.users.switcher!, companyB.id), origin: "ui" };
      const reads = async (caller: Caller, id: string) => (await seen(caller, `select id from ${SCHEMA}.v_masters where id = $1`, [id])).length;
      expect(await reads(inA, mas)).toBe(0);
      expect(await reads(inB, masB)).toBe(1);
      expect(await reads(inB, mas)).toBe(0);
      expect(await reads(inA, mas)).toBe(0);
      // The same id as B's record narrowed in A does not narrow B's: rules are per company.
      await sql.begin(async (tx) => {
        await tx`set local session_replication_role = replica`;
        await tx`insert into kernel.record_access (company_id, entity, record_id, grantee_user_id, can_read, seq) values (${companyId}, 'ra.mas', ${masB}, ${seed.users.granted!}, true, 900001)`;
      });
      expect(await reads(inB, masB)).toBe(1);
      // An admin of B who is only a member in A is narrowed in A.
      await seed.holdRoles(seed.users.switcher!, companyB.id, [companyB.adminRoleId]);
      const adminOfB: Caller = { claims: { ...inB.claims, role_ids: [...inB.claims.role_ids, companyB.adminRoleId] }, origin: "ui" };
      expect(await reads(adminOfB, masB)).toBe(1);
      const backInA: Caller = { claims: { ...inA.claims, role_ids: [...inA.claims.role_ids, companyB.adminRoleId] }, origin: "ui" };
      expect(await reads(backInA, mas)).toBe(0);
      await clearAccess();
    });

    it("M3: a grant to a member whose membership is inactive is refused", async () => {
      const mas = await newMas("Inactivo");
      expect(await refusal(setAccess({ entity: "ra.mas", recordId: mas, grants: [{ userId: seed.users.inactive, rights: ["read"] }] }))).toMatchObject({ code: "invalid_input" });
      expect(await sql`select 1 from kernel.record_access where record_id = ${mas}`).toHaveLength(0);
    });

    it("M5: a rule goes with its role or user (on delete cascade)", async () => {
      const rules = await sql<{ conname: string; confdeltype: string }[]>`
        select conname, confdeltype from pg_constraint where conrelid = 'kernel.record_access'::regclass and contype = 'f' and confrelid in ('kernel.roles'::regclass, 'kernel.users'::regclass)`;
      expect(rules).toHaveLength(2);
      for (const rule of rules) expect(rule.confdeltype, rule.conname).toBe("c");
    });

    it("I3: the audit log hides the entries of a record the caller cannot read (its own, its lines', its process runs); admins and grantees see them", async () => {
      const doc = await newDoc({ name: "Auditado", lines: [{ description: "L1" }, { description: "L2" }] }, restricted);
      await run(restricted, "ra.doc.save", { id: doc });
      const lineIds = (await sql<{ id: string }[]>`select id from ra_fixture.doc_lines where doc_id = ${doc} order by id`).map((r) => r.id);
      // A line update that does not carry the parent column, and a deleted line.
      await sql`update ra_fixture.doc_lines set description = 'L1 bis' where id = ${lineIds[0]!}`;
      await sql`delete from ra_fixture.doc_lines where id = ${lineIds[1]!}`;
      const ids = [doc, ...lineIds];
      const audit = (caller: Caller) => seen(caller, `select entity, row_id, action from kernel.audit_log where row_id = any($1::uuid[])`, [ids]);
      const before = await audit(restricted);
      expect(new Set(before.map((r) => r.entity))).toEqual(new Set(["ra.doc", "ra_fixture.docs", "ra_fixture.doc_lines"]));
      await setAccess({ entity: "ra.doc", recordId: doc, grants: [{ userId: seed.users.granted, rights: ["read"] }] });
      expect(await audit(restricted)).toEqual([]);
      expect(await seen(restricted, `select 1 from kernel.v_audit_log where row_id = any($1::uuid[])`, [ids])).toEqual([]);
      expect((await audit(granted)).length).toBe(before.length);
      expect((await audit(admin)).length).toBe(before.length);
      expect((await seen(admin, `select 1 from kernel.v_audit_entries where row_id = any($1::uuid[])`, [ids])).length).toBe(before.length);
      await clearAccess();
    });

    it("I4: attaching, removing and reordering files needs modify on the record", async () => {
      const mas = await newMas("Con archivos");
      const file = (name: string) => ({
        entity: "ra.mas", recordId: mas, tag: "Foto", fileName: name, mimeType: "image/png", sizeBytes: 100,
        storagePath: `${seed.tenantId}/${companyId}/ra.mas/${mas}/0192-${name}`,
      });
      const { id: fileId } = await run<{ id: string }>(granted, "kernel.attachment.add", file("a.png"));
      await setAccess({ entity: "ra.mas", recordId: mas, grants: [{ userId: seed.users.granted, rights: ["read"] }] });
      const forbidden = { code: "record_forbidden", details: { entity: "ra.mas", recordId: mas, right: "modify" } };
      expect(await refusal(run(granted, "kernel.attachment.add", file("b.png")))).toMatchObject(forbidden);
      expect(await refusal(run(granted, "kernel.attachment.reorder", { entity: "ra.mas", recordId: mas, orderedIds: [fileId] }))).toMatchObject(forbidden);
      expect(await refusal(run(granted, "kernel.attachment.remove", { id: fileId }))).toMatchObject(forbidden);
      // Still listed (read is granted), and the restricted user gets not_found as for a missing record.
      expect(await run<unknown[]>(granted, "kernel.attachment.list", { entity: "ra.mas", recordId: mas })).toHaveLength(1);
      expect(await refusal(run(restricted, "kernel.attachment.add", file("c.png")))).toMatchObject({ code: "not_found" });
      await setAccess({ entity: "ra.mas", recordId: mas, grants: [{ userId: seed.users.granted, rights: ["read", "modify"] }] });
      await expect(run(granted, "kernel.attachment.remove", { id: fileId })).resolves.toMatchObject({ id: fileId });
      await clearAccess();
    });

    it("I2: a system-chosen reference needs usability only (callerRights: false); a user-picked one keeps the use right", async () => {
      const mas = await newMas("Elegido por el sistema");
      await setAccess({ entity: "ra.mas", recordId: mas, grants: [{ userId: seed.users.granted, rights: ["read"] }] });
      const ofGranted = await newDoc({ masId: mas }, granted);
      expect(await refusal(run(granted, "ra.doc.system_check", { id: ofGranted, callerRights: true }))).toMatchObject({ code: "record_forbidden", details: { right: "use" } });
      await expect(run(granted, "ra.doc.system_check", { id: ofGranted, callerRights: false })).resolves.toEqual({ ok: true });
      const ofRestricted = await newDoc({ masId: mas }, restricted);
      expect(await refusal(run(restricted, "ra.doc.system_check", { id: ofRestricted, callerRights: true }))).toMatchObject({ code: "maestro_not_usable" });
      await expect(run(restricted, "ra.doc.system_check", { id: ofRestricted, callerRights: false })).resolves.toEqual({ ok: true });
      // Usability still applies: a Borrador maestro is refused either way.
      const { id: draft } = await run<{ id: string }>(admin, "ra.mas.create", { name: "Borrador" });
      const ofDraft = await newDoc({ masId: draft }, granted);
      expect(await refusal(run(granted, "ra.doc.system_check", { id: ofDraft, callerRights: false }))).toMatchObject({ code: "maestro_not_usable" });
      await clearAccess();
    });
  });
});
