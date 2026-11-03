import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { seedTenant, testDb } from "../../db/test-db";
import { Registry, type EntityDef } from "../../registry";
import { defineModule } from "../../module/define";
import { loadModules } from "../../module/loader";
import { kernelModule } from "../../module/kernel-module";
import { defineProcess } from "../../process/define";
import { ProcessError } from "../../process/errors";
import { runProcess } from "../../process/run";
import type { Caller } from "../../process/context";
import { syncRegistry } from "../../admin/sync";
import type { TypedHooks } from "../runner";

// The lifecycle runner (spec 2026-11-02 §5, §8, D1–D3, D9, D10): the generic processes save / submit / approve / reject / void /
// delete of every maestro and documento, applied to real rows inside runProcess, with documento snapshots. The fixture module
// `rt` (a documento with lines and a maestro, in schema rt_fixture) is created here, never in a migration; it ships its own
// create processes, as every module does.

const SCHEMA = "rt_fixture";
const field = (entity: string, name: string, type: EntityDef["fields"][number]["type"]) => ({ name, type, label: `field.${entity}.${name}` });
const trailer = (entity: string) => [field(entity, "extra", "json"), field(entity, "extra_free", "json"), field(entity, "created_at", "datetime"), field(entity, "updated_at", "datetime")];

const docEntity: EntityDef = {
  id: "rt.doc",
  module: "rt",
  schema: SCHEMA,
  table: "docs",
  label: "entity.rt.doc",
  entityType: "documento",
  typed: { numbering: "on_save", lines: { entity: "rt.doc_line", parentField: "doc_id" } },
  displayField: "name",
  defaultSort: { field: "name", dir: "asc" },
  fields: [field("rt.doc", "seq", "number"), field("rt.doc", "number", "text"), field("rt.doc", "name", "text"), field("rt.doc", "amount", "money"), field("rt.doc", "status", "text"), ...trailer("rt.doc")],
};
const lineEntity: EntityDef = {
  id: "rt.doc_line",
  module: "rt",
  schema: SCHEMA,
  table: "doc_lines",
  label: "entity.rt.doc_line",
  entityType: "lines",
  displayField: "description",
  defaultSort: { field: "description", dir: "asc" },
  fields: [field("rt.doc_line", "doc_id", "uuid"), field("rt.doc_line", "description", "text"), field("rt.doc_line", "qty", "number")],
};
const masEntity: EntityDef = {
  id: "rt.mas",
  module: "rt",
  schema: SCHEMA,
  table: "masters",
  label: "entity.rt.mas",
  entityType: "maestro",
  typed: { approvalFields: ["tax_id"] },
  importKey: ["name"],
  displayField: "name",
  defaultSort: { field: "name", dir: "asc" },
  fields: [field("rt.mas", "name", "text"), field("rt.mas", "tax_id", "text"), field("rt.mas", "note", "text"), field("rt.mas", "is_active", "boolean"),
    { ...field("rt.mas", "tags", "text"), list: true },
    { ...field("rt.mas", "kinds", "enum"), enumValues: ["x", "y"], list: true },
    ...trailer("rt.mas"),
  ],
};

/** What the hooks saw, so a test can tell they ran in the action. */
const hookCalls: { hook: string; mode?: string; id: string; status: string }[] = [];
const hooks: Record<string, TypedHooks> = {
  "rt.doc": {
    async validate(_ctx, record, mode) {
      hookCalls.push({ hook: "validate", mode, id: String(record.id), status: String(record.status) });
      if (record.name === "inválido") throw new ProcessError("invalid_input", "invalid name", { details: [{ path: ["name"], message: "El nombre no es válido" }] });
    },
    async number(ctx, record) {
      hookCalls.push({ hook: "number", id: String(record.id), status: String(record.status) });
      const [row] = await ctx.tx<{ n: number }[]>`select count(*)::int + 1 as n from rt_fixture.docs where number is not null`;
      return `FX-${row!.n}`;
    },
  },
  "rt.mas": {
    // Normalizes the tax id as a country pack does (dots out) and writes it back, so D10 can be checked after normalization.
    async validate(ctx, record) {
      const normalized = typeof record.tax_id === "string" ? record.tax_id.replaceAll(".", "") : record.tax_id;
      if (normalized !== record.tax_id) await ctx.tx`update rt_fixture.masters set tax_id = ${normalized as string} where id = ${record.id as string}`;
    },
  },
};

const createDoc = defineProcess({
  id: "rt.doc.create",
  module: "rt",
  kind: "create",
  description: "Crea un documento de prueba en Borrador",
  input: z.object({ name: z.string(), amount: z.number().optional(), requiresApproval: z.boolean().optional(), lines: z.array(z.object({ description: z.string(), qty: z.number() })).default([]) }),
  output: z.object({ id: z.string() }),
  handler: async (ctx, input) => {
    const [row] = await ctx.tx<{ id: string }[]>`
      insert into rt_fixture.docs (company_id, name, amount, requires_approval)
      values (${ctx.companyId}, ${input.name}, ${input.amount ?? 0}, ${input.requiresApproval ?? null}) returning id`;
    for (const line of input.lines) {
      await ctx.tx`insert into rt_fixture.doc_lines (company_id, doc_id, description, qty) values (${ctx.companyId}, ${row!.id}, ${line.description}, ${line.qty})`;
    }
    return { id: row!.id };
  },
});
const createMas = defineProcess({
  id: "rt.mas.create",
  module: "rt",
  kind: "create",
  description: "Crea un maestro de prueba en Borrador",
  input: z.object({ name: z.string(), taxId: z.string(), requiresApproval: z.boolean().optional() }),
  output: z.object({ id: z.string() }),
  handler: async (ctx, input) => {
    const [row] = await ctx.tx<{ id: string }[]>`
      insert into rt_fixture.masters (company_id, name, tax_id, requires_approval)
      values (${ctx.companyId}, ${input.name}, ${input.taxId}, ${input.requiresApproval ?? null}) returning id`;
    return { id: row!.id };
  },
});

const rtModule = defineModule({
  id: "rt",
  version: "0.0.1",
  dependsOn: [],
  entities: [docEntity, lineEntity, masEntity],
  processes: [createDoc, createMas],
  features: [{ id: "rt.main", label: "feature.rt.main", processes: ["rt.doc.create", "rt.mas.create"], entities: ["rt.doc", "rt.doc_line", "rt.mas"] }],
  events: { emits: [], consumes: {} },
  navigation: [],
  typedHooks: hooks,
});

const TABLES_SQL = `
  drop schema if exists ${SCHEMA} cascade;
  create schema ${SCHEMA};
  grant usage on schema ${SCHEMA} to authenticated, service_role;
  create table ${SCHEMA}.docs (
    id uuid primary key default kernel.uuid_v7(), seq bigint not null, company_id uuid not null references kernel.companies (id),
    number text, name text, amount numeric(18,4) not null default 0,
    extra jsonb not null default '{}'::jsonb, extra_free jsonb not null default '[]'::jsonb,
    created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
    created_by uuid default kernel.current_user_id(), updated_by uuid);
  create table ${SCHEMA}.doc_lines (
    id uuid primary key default kernel.uuid_v7(), seq bigint not null, company_id uuid not null references kernel.companies (id),
    doc_id uuid not null references ${SCHEMA}.docs (id), description text, qty numeric(18,4),
    created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
    created_by uuid default kernel.current_user_id(), updated_by uuid);
  create table ${SCHEMA}.masters (
    id uuid primary key default kernel.uuid_v7(), seq bigint not null, company_id uuid not null references kernel.companies (id),
    name text, tax_id text, note text, tags text[], kinds text[],
    extra jsonb not null default '{}'::jsonb, extra_free jsonb not null default '[]'::jsonb,
    created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
    created_by uuid default kernel.current_user_id(), updated_by uuid);
  create table ${SCHEMA}.uses (
    id uuid primary key default kernel.uuid_v7(), company_id uuid not null references kernel.companies (id), mas_id uuid references ${SCHEMA}.masters (id));
  select kernel.typed_columns('${SCHEMA}', 'docs', 'documento', 'rt.doc');
  select kernel.typed_columns('${SCHEMA}', 'masters', 'maestro', 'rt.mas');
`;

describe("typed lifecycle runner", () => {
  let sql: ReturnType<typeof testDb>;
  let seed: Awaited<ReturnType<typeof seedTenant>>;
  let registry: Registry;
  let companyId: string;
  let admin: Caller;
  let member: Caller;

  const run = <T = Record<string, unknown>>(processId: string, input: unknown, caller: Caller = admin): Promise<T> => runProcess({ sql, registry }, caller, processId, input);
  const refusal = async (promise: Promise<unknown>) => (await promise.then(() => null, (e: unknown) => e)) as ProcessError | null;
  const doc = async (id: string) => (await sql`select * from rt_fixture.docs where id = ${id}`)[0];
  const mas = async (id: string) => (await sql`select * from rt_fixture.masters where id = ${id}`)[0];
  const snapshots = async (id: string) => sql<{ status: string; payload: Record<string, unknown>; reason: string | null; created_by: string; chain_id: string | null }[]>`
    select status, payload, reason, created_by, chain_id from kernel.record_snapshots where company_id = ${companyId} and record_id = ${id} order by seq`;
  const newDoc = async (input: Record<string, unknown> = {}, caller: Caller = admin) => (await run<{ id: string }>("rt.doc.create", { name: "Pedido", lines: [{ description: "Café", qty: 2 }], ...input }, caller)).id;
  const savedDoc = async (input: Record<string, unknown> = {}) => {
    const id = await newDoc(input);
    await run("rt.doc.save", { id });
    return id;
  };

  beforeAll(async () => {
    sql = testDb();
    await sql.unsafe(TABLES_SQL);
    for (const table of ["docs", "doc_lines", "masters"]) {
      await sql.unsafe(`select kernel.enable_company_rls('${SCHEMA}', '${table}')`);
      await sql.unsafe(`select kernel.enable_row_audit('${SCHEMA}', '${table}')`);
      await sql.unsafe(`create trigger assign_seq before insert on ${SCHEMA}.${table} for each row execute function core.assign_seq('rt.${table}')`);
      await sql.unsafe(`create trigger touch_row before update on ${SCHEMA}.${table} for each row execute function core.touch_row()`);
      await sql.unsafe(`grant select, insert, update, delete on ${SCHEMA}.${table} to authenticated`);
      await sql.unsafe(`grant all on ${SCHEMA}.${table} to service_role`);
    }
    await sql.unsafe(`select kernel.enable_company_rls('${SCHEMA}', 'uses')`);
    await sql.unsafe(`grant select, insert on ${SCHEMA}.uses to authenticated`);
    await sql`select kernel.register_reference('rt.mas', ${SCHEMA}, 'uses', 'mas_id')`;

    registry = new Registry();
    loadModules(registry, [kernelModule, defineModule(rtModule)]);
    await syncRegistry(sql, registry); // kernel.entity_tables, which kernel.record_referenced reads
    seed = await seedTenant(sql, { companies: 1, entitlements: ["module:rt"], users: [{ name: "member", companies: [0], role: "member" }] });
    companyId = seed.companies[0]!.id;
    admin = { claims: seed.claimsFor(seed.users.both, companyId), origin: "ui" };
    const memberRole = seed.companies[0]!.memberRoleId;
    member = { claims: { ...seed.claimsFor(seed.users.member!, companyId), role_ids: [memberRole] }, origin: "ui" };
    for (const processId of ["rt.doc.create", "rt.doc.save", "rt.doc.submit", "rt.doc.approve"]) {
      await sql`insert into kernel.process_permissions (company_id, role_id, process_id) values (${companyId}, ${memberRole}, ${processId})`;
    }
  });
  afterAll(async () => {
    await sql`delete from kernel."references" where entity = 'rt.mas'`;
    await sql`delete from kernel.entity_tables where module_id = 'rt'`;
    await sql`delete from kernel.process_permissions where company_id = ${companyId}`;
    await sql.unsafe(`drop schema if exists ${SCHEMA} cascade`);
    await seed.cleanup();
    await sql.end();
  });

  describe("registration", () => {
    it("registers save, submit, approve, reject, void and delete for every maestro and documento, in the entity's feature", () => {
      for (const entity of ["rt.doc", "rt.mas"]) {
        for (const verb of ["save", "submit", "approve", "reject", "void", "delete"]) {
          const process = registry.process(`${entity}.${verb}`);
          expect(process.module).toBe("rt");
          expect(registry.module("rt").features.find((f) => f.id === "rt.main")!.processes).toContain(process.id);
        }
      }
      expect(() => registry.process("rt.doc_line.save")).toThrow(/unknown process/);
      expect(registry.process("rt.doc.delete").kind).toBe("delete");
      expect(registry.process("rt.doc.approve").kind).toBe("update");
    });

    it("a step answers the record's new updated_at, so a following step can send it as expectedUpdatedAt (Task 15 round 1)", async () => {
      const id = await newDoc();
      const out = await run<{ updatedAt?: string }>("rt.doc.save", { id });
      const row = await doc(id);
      expect(new Date(out.updatedAt!).getTime()).toBe(new Date(row!.updated_at as string).getTime());
    });

    it("reject and void require a reason", async () => {
      const id = await savedDoc();
      expect(await refusal(run("rt.doc.void", { id }))).toMatchObject({ code: "invalid_input" });
      expect(await refusal(run("rt.doc.void", { id, reason: "  " }))).toMatchObject({ code: "invalid_input" });
      expect(await refusal(run("rt.doc.reject", { id }))).toMatchObject({ code: "invalid_input" });
    });
  });

  describe("documento", () => {
    it("an illegal action is invalid_state with from and action", async () => {
      const id = await newDoc();
      const error = await refusal(run("rt.doc.approve", { id }));
      expect(error).toMatchObject({ code: "invalid_state", details: { from: "draft", action: "approve" } });
      expect((await doc(id))!.status).toBe("draft");
    });

    it("a data edit in pending is invalid_state", async () => {
      const id = await savedDoc({ requiresApproval: true });
      await run("rt.doc.submit", { id });
      const error = await refusal(run("rt.doc.save", { id, data: { name: "Otro" } }));
      expect(error).toMatchObject({ code: "invalid_state", details: { from: "pending", action: "save" } });
      expect((await doc(id))!.name).toBe("Pedido");
    });

    it("save from draft validates, numbers through the hook (numbering on_save) and writes the first snapshot", async () => {
      const id = await newDoc();
      hookCalls.length = 0;
      const result = await run<{ id: string; status: string; number?: string }>("rt.doc.save", { id, data: { name: "Pedido 1", amount: 1500.5 } });
      const row = await doc(id);
      expect(result).toMatchObject({ id, status: "saved" });
      expect(result.number).toMatch(/^FX-\d+$/);
      expect(row).toMatchObject({ status: "saved", number: result.number, name: "Pedido 1", amount: "1500.5000" });
      expect(hookCalls.map((c) => [c.hook, c.mode ?? null])).toEqual([["validate", "save"], ["number", null]]);
      const snaps = await snapshots(id);
      expect(snaps).toHaveLength(1);
      expect(snaps[0]).toMatchObject({ status: "saved", created_by: seed.users.both });
      expect(snaps[0]!.payload).toMatchObject({ header: { name: "Pedido 1", number: result.number, status: "saved" }, lines: [{ description: "Café" }], extra: {}, extra_free: [] });
      // A second Grabar keeps the number.
      const again = await run<{ number?: string }>("rt.doc.save", { id, data: { name: "Pedido 1b" } });
      expect(again.number).toBeUndefined();
      expect((await doc(id))!.number).toBe(result.number);
    });

    it("snapshot lines follow the row order (seq), not the uuid: a later line with a lower id is listed last", async () => {
      const id = await newDoc({ lines: [{ description: "Café", qty: 2 }, { description: "Pan", qty: 1 }] });
      await sql`insert into ${sql(SCHEMA)}.doc_lines (id, company_id, doc_id, description, qty) values ('00000000-0000-7000-8000-000000000001', ${companyId}, ${id}, 'Último', 1)`;
      await run("rt.doc.save", { id, data: { name: "Ordenado" } });
      const [snap] = await snapshots(id);
      expect((snap!.payload.lines as { description: string }[]).map((l) => l.description)).toEqual(["Café", "Pan", "Último"]);
    });

    it("a validate refusal rolls the save back: still draft, no number, no snapshot", async () => {
      const id = await newDoc();
      expect(await refusal(run("rt.doc.save", { id, data: { name: "inválido" } }))).toMatchObject({ code: "invalid_input" });
      expect(await doc(id)).toMatchObject({ status: "draft", number: null, name: "Pedido" });
      expect(await snapshots(id)).toHaveLength(0);
    });

    it("an unknown or system field in data is invalid_input", async () => {
      const id = await newDoc();
      expect(await refusal(run("rt.doc.save", { id, data: { nope: 1 } }))).toMatchObject({ code: "invalid_input" });
      expect(await refusal(run("rt.doc.save", { id, data: { status: "approved" } }))).toMatchObject({ code: "invalid_input" });
      expect(await refusal(run("rt.doc.save", { id, data: { amount: "mucho" } }))).toMatchObject({ code: "invalid_input" });
      expect((await doc(id))!.status).toBe("draft");
    });

    it("invalid data on a pending documento is invalid_state (D3 is checked before the data)", async () => {
      const id = await savedDoc({ requiresApproval: true });
      await run("rt.doc.submit", { id });
      const error = await refusal(run("rt.doc.save", { id, data: { amount: "mucho", nope: 1 } }));
      expect(error).toMatchObject({ code: "invalid_state", details: { from: "pending", action: "save" } });
      expect((await doc(id))!.status).toBe("pending");
    });

    it("a save whose data equals the stored values is no data change: no update, no snapshot", async () => {
      const id = await savedDoc();
      const before = await doc(id);
      expect(await snapshots(id)).toHaveLength(1);
      const result = await run("rt.doc.save", { id, data: { name: "Pedido", amount: 0, extra_free: [] } });
      expect(result).toMatchObject({ id, status: "saved" });
      const after = await doc(id);
      expect(after!.updated_at).toEqual(before!.updated_at);
      expect(await snapshots(id)).toHaveLength(1);
    });

    it("an edit in saved writes one snapshot with the new data", async () => {
      const id = await savedDoc();
      expect(await snapshots(id)).toHaveLength(1);
      await run("rt.doc.save", { id, data: { name: "Pedido editado" } });
      const snaps = await snapshots(id);
      expect(snaps).toHaveLength(2);
      expect(snaps[1]).toMatchObject({ status: "saved", payload: { header: { name: "Pedido editado" } } });
    });

    it("each transition writes one snapshot (reason on reject and void) and void keeps the reason", async () => {
      const id = await savedDoc({ requiresApproval: true });
      const steps: [string, Record<string, unknown>, string][] = [
        ["rt.doc.submit", {}, "pending"],
        ["rt.doc.reject", { reason: "Falta soporte" }, "rejected"],
        ["rt.doc.save", { data: { name: "Con soporte" } }, "saved"],
        ["rt.doc.submit", {}, "pending"],
        ["rt.doc.approve", {}, "approved"],
        ["rt.doc.void", { reason: "Duplicado" }, "voided"],
      ];
      let count = (await snapshots(id)).length;
      for (const [processId, input, status] of steps) {
        const result = await run<{ status: string }>(processId, { id, ...input });
        expect(result.status, processId).toBe(status);
        const snaps = await snapshots(id);
        expect(snaps, processId).toHaveLength(count + 1);
        expect(snaps.at(-1)!.status).toBe(status);
        count++;
      }
      const snaps = await snapshots(id);
      expect(snaps.find((s) => s.status === "rejected")!.reason).toBe("Falta soporte");
      expect(snaps.at(-1)!.reason).toBe("Duplicado");
      expect(await doc(id)).toMatchObject({ status: "voided", void_reason: "Duplicado" });
      // Voided is final.
      expect(await refusal(run("rt.doc.save", { id }))).toMatchObject({ code: "invalid_state", details: { from: "voided", action: "save" } });
    });

    it("submit without requires_approval is invalid_state", async () => {
      const id = await savedDoc({ requiresApproval: false });
      expect(await refusal(run("rt.doc.submit", { id }))).toMatchObject({ code: "invalid_state", details: { from: "saved", action: "submit" } });
    });

    it("expectedUpdatedAt older than the row is stale_record and changes nothing", async () => {
      const id = await savedDoc();
      const before = (await doc(id))!.updated_at as Date;
      await run("rt.doc.save", { id, data: { name: "Primero" }, expectedUpdatedAt: before.toISOString() });
      const error = await refusal(run("rt.doc.save", { id, data: { name: "Segundo" }, expectedUpdatedAt: before.toISOString() }));
      expect(error).toMatchObject({ code: "stale_record" });
      expect((await doc(id))!.name).toBe("Primero");
      expect(await snapshots(id)).toHaveLength(2);
    });

    it("two users acting at once on the same version: one wins, the other gets stale_record (Review Focus 3)", async () => {
      const id = await savedDoc({ requiresApproval: true });
      const version = ((await doc(id))!.updated_at as Date).toISOString();
      const results = await Promise.allSettled([
        run("rt.doc.save", { id, data: { name: "Grabado por A" }, expectedUpdatedAt: version }),
        run("rt.doc.submit", { id, expectedUpdatedAt: version }),
      ]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
      expect(rejected).toHaveLength(1);
      expect(rejected[0]!.reason).toMatchObject({ code: "stale_record" });
      expect(await snapshots(id)).toHaveLength(2);
    });

    it("delete in saved is refused; in draft it removes the header and its lines and audits it", async () => {
      const saved = await savedDoc();
      expect(await refusal(run("rt.doc.delete", { id: saved }))).toMatchObject({ code: "invalid_state", details: { from: "saved", action: "delete" } });
      expect(await doc(saved)).toBeDefined();

      const draft = await newDoc();
      const result = await run<{ id: string }>("rt.doc.delete", { id: draft });
      expect(result).toMatchObject({ id: draft });
      expect(await doc(draft)).toBeUndefined();
      expect(await sql`select 1 from rt_fixture.doc_lines where doc_id = ${draft}`).toHaveLength(0);
      const audit = await sql`select action, process_id, entity from kernel.audit_log where company_id = ${companyId} and row_id = ${draft} and action = 'delete'`;
      expect(audit).toEqual(expect.arrayContaining([expect.objectContaining({ process_id: "rt.doc.delete", entity: "rt.doc" })]));
      expect(await snapshots(draft)).toHaveLength(0);
    });

    it("an unknown record is not_found", async () => {
      expect(await refusal(run("rt.doc.save", { id: "0190a0a0-0000-7000-8000-000000000000" }))).toMatchObject({ code: "not_found" });
    });

    it("the creator approves their own record (no four-eyes) with the approve permission; reject needs its own permission", async () => {
      const id = await newDoc({ requiresApproval: true }, member);
      await run("rt.doc.save", { id }, member);
      await run("rt.doc.submit", { id }, member);
      expect(await refusal(run("rt.doc.reject", { id, reason: "No" }, member))).toMatchObject({ code: "forbidden" });
      const result = await run<{ status: string }>("rt.doc.approve", { id }, member);
      expect(result.status).toBe("approved");
      expect(await doc(id)).toMatchObject({ status: "approved", created_by: seed.users.member, updated_by: seed.users.member });
    });

    it("approve runs the validate hook in approve mode", async () => {
      const id = await savedDoc({ requiresApproval: true });
      await run("rt.doc.submit", { id });
      hookCalls.length = 0;
      await run("rt.doc.approve", { id });
      expect(hookCalls.map((c) => [c.hook, c.mode])).toEqual([["validate", "approve"]]);
    });
  });

  describe("maestro", () => {
    const newMas = async (requiresApproval = false) => (await run<{ id: string }>("rt.mas.create", { name: `Maestro ${Math.random()}`, taxId: "900", requiresApproval })).id;

    it("delete is soft: it sets deleted_at, and the record is gone for the lifecycle afterwards", async () => {
      const id = await newMas();
      await run("rt.mas.save", { id });
      await run("rt.mas.delete", { id });
      const row = await mas(id);
      expect(row!.deleted_at).toBeInstanceOf(Date);
      expect(await refusal(run("rt.mas.save", { id }))).toMatchObject({ code: "not_found" });
    });

    it("delete is refused while a registered reference points at it, with the hint to set Activo = no", async () => {
      const id = await newMas();
      await run("rt.mas.save", { id });
      await sql`insert into rt_fixture.uses (company_id, mas_id) values (${companyId}, ${id})`;
      const error = await refusal(run("rt.mas.delete", { id }));
      expect(error).toMatchObject({ code: "invalid_state", details: { from: "saved", action: "delete", reason: "referenced", messageKey: "errors.record_referenced" } });
      expect((await mas(id))!.deleted_at).toBeNull();
      const catalogue = (locale: string) => JSON.parse(readFileSync(join(import.meta.dirname, `../../../../i18n/messages/${locale}.json`), "utf8")) as { errors: Record<string, string> };
      expect(catalogue("es-419").errors.record_referenced).toContain("Activo = no");
      expect(catalogue("en").errors.record_referenced).toBeTruthy();
    });

    it("editing an approval field of an approved maestro with requires_approval sends it to pending; another field does not (D10)", async () => {
      const id = await newMas(true);
      await run("rt.mas.save", { id });
      await run("rt.mas.submit", { id });
      await run("rt.mas.approve", { id });
      expect((await mas(id))!.status).toBe("approved");
      expect(await run("rt.mas.save", { id, data: { note: "Sólo una nota" } })).toMatchObject({ status: "approved" });
      expect(await run("rt.mas.save", { id, data: { tax_id: "900373115" } })).toMatchObject({ status: "pending" });
      expect(await mas(id)).toMatchObject({ status: "pending", tax_id: "900373115", note: "Sólo una nota" });
    });

    it("D10 compares the approval fields after the validate hook normalized them: an unchanged value written another way keeps Aprobado", async () => {
      const id = await newMas(true);
      await run("rt.mas.save", { id, data: { tax_id: "900373115" } });
      await run("rt.mas.submit", { id });
      await run("rt.mas.approve", { id });
      expect(await run("rt.mas.save", { id, data: { tax_id: "900.373.115" } })).toMatchObject({ status: "approved" });
      expect(await mas(id)).toMatchObject({ status: "approved", tax_id: "900373115" });
      expect(await run("rt.mas.save", { id, data: { tax_id: "900.373.116" } })).toMatchObject({ status: "pending" });
      expect(await mas(id)).toMatchObject({ status: "pending", tax_id: "900373116" });
    });

    it("a list field is written as text[] through Grabar: an array of strings (of the enum values, for an enum); anything else is invalid_input", async () => {
      const id = await newMas();
      await run("rt.mas.save", { id, data: { tags: ["a", "b"], kinds: ["x", "y"] } });
      const stored = await mas(id);
      expect(stored).toMatchObject({ tags: ["a", "b"], kinds: ["x", "y"] });
      const [type] = await sql<{ t: string }[]>`select pg_typeof(tags)::text as t from rt_fixture.masters where id = ${id}`;
      expect(type!.t).toBe("text[]");
      // The same list again is no data change.
      await run("rt.mas.save", { id, data: { tags: ["a", "b"] } });
      expect((await mas(id))!.updated_at).toEqual(stored!.updated_at);
      await run("rt.mas.save", { id, data: { tags: [], kinds: null } });
      expect(await mas(id)).toMatchObject({ tags: [], kinds: null });
      for (const data of [{ tags: "a" }, { tags: [1] }, { kinds: ["x", "z"] }, { kinds: "x" }]) {
        expect(await refusal(run("rt.mas.save", { id, data }))).toMatchObject({ code: "invalid_input" });
      }
    });

    it("a maestro is editable in every state, may be deactivated, and gets no snapshots", async () => {
      const id = await newMas(true);
      await run("rt.mas.save", { id });
      await run("rt.mas.submit", { id });
      expect(await run("rt.mas.save", { id, data: { note: "en revisión", is_active: false } })).toMatchObject({ status: "pending" });
      expect(await mas(id)).toMatchObject({ note: "en revisión", is_active: false });
      expect(await snapshots(id)).toHaveLength(0);
      expect(await refusal(run("rt.mas.void", { id, reason: "x" }))).toMatchObject({ code: "invalid_state", details: { from: "pending", action: "void" } });
    });
  });
});

