import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { seedTenant, testDb } from "../../db/test-db";
import { Registry, type EntityDef } from "../../registry";
import { defineModule } from "../../module/define";
import { loadModules } from "../../module/loader";
import { kernelModule } from "../../module/kernel-module";
import { defineProcess } from "../../process/define";
import type { ProcessError } from "../../process/errors";
import { runProcess } from "../../process/run";
import type { Caller } from "../../process/context";
import { syncRegistry } from "../../admin/sync";
import type { TypedHooks } from "../runner";

// The maestro usability gate (spec 2026-11-02 §5.2 last paragraph, §10 D10): a documento may only reference maestros that are usable,
// checked by the lifecycle runner on Grabar, Aprobar and the posting step, for the header's ref fields and for its lines'. Also the
// security-definer kernel.record_referenced, which the maestro Eliminar uses so a hidden referencing row still blocks the delete.
// The fixture module `us` (schema us_fixture) is created here, never in a migration.

const SCHEMA = "us_fixture";
const field = (entity: string, name: string, type: EntityDef["fields"][number]["type"]) => ({ name, type, label: `field.${entity}.${name}` });
const refField = (entity: string, name: string) => ({ ...field(entity, name, "ref"), ref: { entity: "us.mas", display: "name" } });
const trailer = (entity: string) => [field(entity, "extra", "json"), field(entity, "extra_free", "json"), field(entity, "created_at", "datetime"), field(entity, "updated_at", "datetime")];

const masEntity: EntityDef = {
  id: "us.mas",
  module: "us",
  schema: SCHEMA,
  table: "masters",
  label: "entity.us.mas",
  entityType: "maestro",
  importKey: ["name"],
  displayField: "name",
  defaultSort: { field: "name", dir: "asc" },
  fields: [field("us.mas", "name", "text"), field("us.mas", "is_active", "boolean"), ...trailer("us.mas")],
};
const docEntity: EntityDef = {
  id: "us.doc",
  module: "us",
  schema: SCHEMA,
  table: "docs",
  label: "entity.us.doc",
  entityType: "documento",
  typed: { numbering: "on_save", lines: { entity: "us.doc_line", parentField: "doc_id" } },
  displayField: "name",
  defaultSort: { field: "name", dir: "asc" },
  fields: [field("us.doc", "number", "text"), field("us.doc", "name", "text"), refField("us.doc", "mas_id"), refField("us.doc", "alt_id"), field("us.doc", "status", "text"), ...trailer("us.doc")],
};
const lineEntity: EntityDef = {
  id: "us.doc_line",
  module: "us",
  schema: SCHEMA,
  table: "doc_lines",
  label: "entity.us.doc_line",
  entityType: "lines",
  displayField: "description",
  defaultSort: { field: "description", dir: "asc" },
  fields: [field("us.doc_line", "doc_id", "uuid"), field("us.doc_line", "description", "text"), refField("us.doc_line", "mas_id")],
};

const hooks: Record<string, TypedHooks> = {
  "us.doc": {
    // A document named "flip" deactivates its maestro while it is being numbered (after the Grabar gate, before the posting gate).
    async number(ctx, record) {
      if (record.name === "flip") await ctx.tx`update us_fixture.masters set is_active = false where id = ${record.mas_id as string}`;
      return `US-${String(record.id).slice(-6)}`;
    },
    async post() {},
  },
};

const createMas = defineProcess({
  id: "us.mas.create",
  module: "us",
  kind: "create",
  description: "Crea un maestro de prueba en Borrador",
  input: z.object({ name: z.string(), requiresApproval: z.boolean().optional() }),
  output: z.object({ id: z.string() }),
  handler: async (ctx, input) => {
    const [row] = await ctx.tx<{ id: string }[]>`
      insert into us_fixture.masters (company_id, name, requires_approval) values (${ctx.companyId}, ${input.name}, ${input.requiresApproval ?? null}) returning id`;
    return { id: row!.id };
  },
});
const createDoc = defineProcess({
  id: "us.doc.create",
  module: "us",
  kind: "create",
  description: "Crea un documento de prueba en Borrador",
  input: z.object({
    name: z.string().default("Doc"),
    masId: z.string().nullable().optional(),
    altId: z.string().nullable().optional(),
    posts: z.boolean().optional(),
    requiresApproval: z.boolean().optional(),
    lines: z.array(z.object({ description: z.string(), masId: z.string().nullable().optional() })).default([]),
  }),
  output: z.object({ id: z.string() }),
  handler: async (ctx, input) => {
    const [row] = await ctx.tx<{ id: string }[]>`
      insert into us_fixture.docs (company_id, name, mas_id, alt_id, posts, requires_approval)
      values (${ctx.companyId}, ${input.name}, ${input.masId ?? null}, ${input.altId ?? null}, ${input.posts ?? null}, ${input.requiresApproval ?? null}) returning id`;
    for (const line of input.lines) {
      await ctx.tx`insert into us_fixture.doc_lines (company_id, doc_id, description, mas_id) values (${ctx.companyId}, ${row!.id}, ${line.description}, ${line.masId ?? null})`;
    }
    return { id: row!.id };
  },
});

const usModule = defineModule({
  id: "us",
  version: "0.0.1",
  dependsOn: [],
  entities: [masEntity, docEntity, lineEntity],
  processes: [createMas, createDoc],
  features: [{ id: "us.main", label: "feature.us.main", processes: ["us.mas.create", "us.doc.create"], entities: ["us.mas", "us.doc", "us.doc_line"] }],
  events: { emits: [], consumes: {} },
  navigation: [],
  typedHooks: hooks,
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
  grant usage on schema ${SCHEMA} to authenticated, service_role;
  ${typedTable("masters", "maestro", "us.mas", "name text,")}
  ${typedTable("docs", "documento", "us.doc", "number text, name text, mas_id uuid, alt_id uuid,")}
  create table ${SCHEMA}.doc_lines (
    id uuid primary key default kernel.uuid_v7(), seq bigint not null, company_id uuid not null references kernel.companies (id),
    doc_id uuid not null references ${SCHEMA}.docs (id), description text, mas_id uuid,
    created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
    created_by uuid default kernel.current_user_id(), updated_by uuid);
  create table ${SCHEMA}.hidden_uses (
    id uuid primary key default kernel.uuid_v7(), company_id uuid not null references kernel.companies (id), mas_id uuid references ${SCHEMA}.masters (id));
`;

describe("maestro usability gate (Task 7)", () => {
  let sql: ReturnType<typeof testDb>;
  let seed: Awaited<ReturnType<typeof seedTenant>>;
  let registry: Registry;
  let companyId: string;
  let otherCompanyId: string;
  let admin: Caller;

  const run = <T = Record<string, unknown>>(processId: string, input: unknown): Promise<T> => runProcess({ sql, registry }, admin, processId, input);
  const refusal = async (promise: Promise<unknown>) => (await promise.then(() => null, (e: unknown) => e)) as ProcessError | null;
  const doc = async (id: string) => (await sql`select * from ${sql(SCHEMA)}.docs where id = ${id}`)[0];
  /** A maestro walked to `saved` (or `approved` when it requires approval). */
  const newMas = async (input: { name?: string; requiresApproval?: boolean; approve?: boolean; save?: boolean } = {}) => {
    const { id } = await run<{ id: string }>("us.mas.create", { name: input.name ?? "Café", ...(input.requiresApproval !== undefined ? { requiresApproval: input.requiresApproval } : {}) });
    if (input.save !== false) await run("us.mas.save", { id });
    if (input.requiresApproval && input.approve) {
      await run("us.mas.submit", { id });
      await run("us.mas.approve", { id });
    }
    return id;
  };
  const newDoc = async (input: Record<string, unknown> = {}) => (await run<{ id: string }>("us.doc.create", input)).id;

  beforeAll(async () => {
    sql = testDb();
    await sql.unsafe(TABLES_SQL);
    for (const table of ["masters", "docs", "doc_lines"]) {
      await sql.unsafe(`select kernel.enable_company_rls('${SCHEMA}', '${table}')`);
      await sql.unsafe(`select kernel.enable_row_audit('${SCHEMA}', '${table}')`);
      await sql.unsafe(`create trigger assign_seq before insert on ${SCHEMA}.${table} for each row execute function core.assign_seq('us.${table}')`);
      await sql.unsafe(`create trigger touch_row before update on ${SCHEMA}.${table} for each row execute function core.touch_row()`);
      await sql.unsafe(`grant select, insert, update, delete on ${SCHEMA}.${table} to authenticated`);
      await sql.unsafe(`grant all on ${SCHEMA}.${table} to service_role`);
    }
    // hidden_uses: a reference the caller cannot read (a policy that shows no row), to prove record_referenced does not depend on RLS.
    await sql.unsafe(`alter table ${SCHEMA}.hidden_uses enable row level security`);
    await sql.unsafe(`create policy nothing on ${SCHEMA}.hidden_uses for select to authenticated using (false)`);
    await sql.unsafe(`grant select on ${SCHEMA}.hidden_uses to authenticated`);
    await sql.unsafe(`grant all on ${SCHEMA}.hidden_uses to service_role`);
    await sql`select kernel.register_reference('us.mas', ${SCHEMA}, 'hidden_uses', 'mas_id')`;

    registry = new Registry();
    loadModules(registry, [kernelModule, defineModule(usModule)]);
    seed = await seedTenant(sql, { companies: 2, entitlements: ["module:us"] });
    companyId = seed.companies[0]!.id;
    otherCompanyId = seed.companies[1]!.id;
    admin = { claims: seed.claimsFor(seed.users.both, companyId), origin: "ui" };
    await syncRegistry(sql, registry);
  });
  afterAll(async () => {
    await sql`delete from kernel."references" where entity = 'us.mas'`;
    await sql`delete from kernel.entity_tables where module_id = 'us'`;
    await sql.unsafe(`drop schema if exists ${SCHEMA} cascade`);
    await seed.cleanup();
    await sql.end();
  });

  describe("registry sync", () => {
    it("records the table of every maestro and documento (not lines) in kernel.entity_tables", async () => {
      const rows = await sql<{ entity: string; entity_type: string; table_schema: string; table_name: string }[]>`
        select entity, entity_type, table_schema, table_name from kernel.entity_tables where module_id = 'us' order by entity`;
      expect(rows).toEqual([
        { entity: "us.doc", entity_type: "documento", table_schema: SCHEMA, table_name: "docs" },
        { entity: "us.mas", entity_type: "maestro", table_schema: SCHEMA, table_name: "masters" },
      ]);
    });
  });

  describe("Grabar", () => {
    it("refuses a maestro that is still pending, naming the field and the record", async () => {
      const masId = await newMas({ requiresApproval: true });
      await run("us.mas.submit", { id: masId });
      const id = await newDoc({ masId });
      const error = await refusal(run("us.doc.save", { id }));
      expect(error).toMatchObject({ code: "maestro_not_usable", details: { field: "mas_id", entity: "us.mas", recordId: masId } });
      expect((await doc(id))!.status).toBe("draft");
    });

    it("refuses a maestro that is only saved when it requires approval, and a draft maestro", async () => {
      const waiting = await newMas({ requiresApproval: true });
      expect(await refusal(run("us.doc.save", { id: await newDoc({ masId: waiting }) }))).toMatchObject({ code: "maestro_not_usable" });
      const draft = await newMas({ save: false });
      expect(await refusal(run("us.doc.save", { id: await newDoc({ masId: draft }) }))).toMatchObject({ code: "maestro_not_usable" });
    });

    it("accepts a saved maestro that needs no approval, and an approved one that does", async () => {
      const plain = await newMas();
      expect(await run("us.doc.save", { id: await newDoc({ masId: plain }) })).toMatchObject({ status: "saved" });
      const approved = await newMas({ requiresApproval: true, approve: true });
      expect(await run("us.doc.save", { id: await newDoc({ masId: approved }) })).toMatchObject({ status: "saved" });
    });

    it("refuses an inactive maestro", async () => {
      const masId = await newMas();
      await run("us.mas.save", { id: masId, data: { is_active: false } });
      expect(await refusal(run("us.doc.save", { id: await newDoc({ masId }) }))).toMatchObject({ code: "maestro_not_usable", details: { recordId: masId } });
    });

    it("refuses a deleted maestro and a maestro of another company", async () => {
      const gone = await newMas();
      await run("us.mas.delete", { id: gone });
      expect(await refusal(run("us.doc.save", { id: await newDoc({ masId: gone }) }))).toMatchObject({ code: "maestro_not_usable" });

      const [foreign] = await sql<{ id: string }[]>`
        insert into us_fixture.masters (company_id, name, status, requires_approval) values (${otherCompanyId}, 'Ajeno', 'saved', false) returning id`;
      expect(await refusal(run("us.doc.save", { id: await newDoc({ masId: foreign!.id }) }))).toMatchObject({ code: "maestro_not_usable", details: { recordId: foreign!.id } });
    });

    it("skips null refs and checks every ref field of the header", async () => {
      const ok = await newMas();
      const bad = await newMas({ requiresApproval: true });
      expect(await run("us.doc.save", { id: await newDoc({ masId: null, altId: null }) })).toMatchObject({ status: "saved" });
      expect(await run("us.doc.save", { id: await newDoc({ masId: ok, altId: null }) })).toMatchObject({ status: "saved" });
      expect(await refusal(run("us.doc.save", { id: await newDoc({ masId: ok, altId: bad }) }))).toMatchObject({ code: "maestro_not_usable", details: { field: "alt_id", recordId: bad } });
    });

    it("checks the ref fields of the lines, naming the line", async () => {
      const ok = await newMas();
      const bad = await newMas({ requiresApproval: true });
      expect(await run("us.doc.save", { id: await newDoc({ lines: [{ description: "a", masId: ok }, { description: "b", masId: null }] }) })).toMatchObject({ status: "saved" });
      const id = await newDoc({ lines: [{ description: "a", masId: ok }, { description: "b", masId: bad }] });
      const [line] = await sql<{ id: string }[]>`select id from us_fixture.doc_lines where doc_id = ${id} and description = 'b'`;
      const error = await refusal(run("us.doc.save", { id }));
      expect(error).toMatchObject({ code: "maestro_not_usable", details: { field: "mas_id", entity: "us.mas", recordId: bad, lineId: line!.id } });
      expect((await doc(id))!.status).toBe("draft");
    });

    it("checks again on a later Grabar of a saved documento", async () => {
      const masId = await newMas();
      const id = await newDoc({ masId });
      await run("us.doc.save", { id });
      await run("us.mas.save", { id: masId, data: { is_active: false } });
      expect(await refusal(run("us.doc.save", { id, data: { name: "Otro" } }))).toMatchObject({ code: "maestro_not_usable" });
      expect((await doc(id))!.name).toBe("Doc");
    });
  });

  describe("Aprobar and posting", () => {
    it("the check reruns at Aprobar: a maestro deactivated meanwhile leaves the documento pending", async () => {
      const masId = await newMas();
      const id = await newDoc({ masId, requiresApproval: true });
      await run("us.doc.save", { id });
      await run("us.doc.submit", { id });
      await run("us.mas.save", { id: masId, data: { is_active: false } });
      expect(await refusal(run("us.doc.approve", { id }))).toMatchObject({ code: "maestro_not_usable", details: { field: "mas_id", recordId: masId } });
      expect((await doc(id))!.status).toBe("pending");
      await run("us.mas.save", { id: masId, data: { is_active: true } });
      expect(await run("us.doc.approve", { id })).toMatchObject({ status: "approved" });
    });

    it("the posting step checks too: a maestro that stops being usable before posting rolls the whole Grabar back", async () => {
      const masId = await newMas();
      const id = await newDoc({ name: "flip", masId, posts: true });
      const error = await refusal(run("us.doc.save", { id }));
      expect(error).toMatchObject({ code: "maestro_not_usable", details: { recordId: masId } });
      const row = await doc(id);
      expect(row).toMatchObject({ status: "draft", number: null });
      const [mas] = await sql<{ is_active: boolean }[]>`select is_active from us_fixture.masters where id = ${masId}`;
      expect(mas!.is_active).toBe(true);
      expect(await sql`select 1 from kernel.record_snapshots where record_id = ${id}`).toHaveLength(0);
    });

    it("a usable maestro lets a posting documento post", async () => {
      const masId = await newMas();
      expect(await run("us.doc.save", { id: await newDoc({ masId, posts: true }) })).toMatchObject({ status: "posted" });
    });
  });

  describe("kernel.record_referenced", () => {
    it("a reference row the caller cannot read still blocks the maestro Eliminar", async () => {
      const masId = await newMas();
      await sql`insert into us_fixture.hidden_uses (company_id, mas_id) values (${companyId}, ${masId})`;
      const visible = await sql.begin(async (tx) => {
        await tx`select set_config('role', 'authenticated', true)`;
        return tx`select * from us_fixture.hidden_uses where mas_id = ${masId}`;
      });
      expect(visible).toHaveLength(0);
      expect(await refusal(run("us.mas.delete", { id: masId }))).toMatchObject({ code: "invalid_state", details: { reason: "referenced", messageKey: "errors.record_referenced" } });
      const [row] = await sql<{ deleted_at: Date | null }[]>`select deleted_at from us_fixture.masters where id = ${masId}`;
      expect(row!.deleted_at).toBeNull();
    });

    it("an unreferenced maestro is deleted (soft)", async () => {
      const masId = await newMas();
      expect(await run("us.mas.delete", { id: masId })).toMatchObject({ deleted: true });
      const [row] = await sql<{ deleted_at: Date | null }[]>`select deleted_at from us_fixture.masters where id = ${masId}`;
      expect(row!.deleted_at).not.toBeNull();
    });
  });
});
