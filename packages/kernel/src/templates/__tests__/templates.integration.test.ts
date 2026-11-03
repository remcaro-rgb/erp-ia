import { randomUUID } from "node:crypto";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { withClaims } from "../../db/client";
import { seedTenant, testDb } from "../../db/test-db";
import { MemoryFileStore, setExportsStore, setFileStore } from "../../files/store";
import { registerCountryPack, type CountryPack } from "../../localization/country-pack";
import { registerCatalogue } from "../../registry/labels";
import { defineEntity, Registry, type EntityDef } from "../../registry";
import { defineModule } from "../../module/define";
import { loadModules } from "../../module/loader";
import { kernelModule } from "../../module/kernel-module";
import { defineProcess } from "../../process/define";
import type { ProcessError } from "../../process/errors";
import { runProcess } from "../../process/run";
import type { Caller } from "../../process/context";
import { syncRegistry } from "../../admin/sync";
import { maskedViewSql } from "../../security/masked-views";
import { pdfText } from "./pdf-text";

// PDF templates (entity types spec 2026-11-02 §6, Phase 2A.5 Task 11, migration 0048): kernel.doc_templates holds the company's templates
// per entity and scope, one default each; kernel.doc_template.save (admin, step-up) writes a new version on every save,
// kernel.doc_template.set_default picks the default, kernel.doc_template.print renders a record or a list as the caller (masked fields
// empty, record-level access, the grid state of the list) and stores the PDF as a finished export job, downloaded by a signed link.
// The fixture module `tp` (schema tp_fixture) is created here, never in a migration.

const SCHEMA = "tp_fixture";
const field = (entity: string, name: string, type: EntityDef["fields"][number]["type"]) => ({ name, type, label: `field.${entity}.${name}` });
const trailer = (entity: string) => [field(entity, "extra", "json"), field(entity, "extra_free", "json"), field(entity, "created_at", "datetime"), field(entity, "updated_at", "datetime")];

const clientEntity: EntityDef = {
  id: "tp.client", module: "tp", schema: SCHEMA, table: "clients", label: "entity.tp.client", entityType: "maestro", importKey: ["name"],
  displayField: "name", defaultSort: { field: "name", dir: "asc" },
  fields: [
    field("tp.client", "name", "text"), field("tp.client", "balance", "money"), field("tp.client", "credit_limit", "money"), field("tp.client", "secret", "text"),
    field("tp.client", "status", "text"), field("tp.client", "is_active", "boolean"), ...trailer("tp.client"),
  ],
};
const orderEntity: EntityDef = {
  id: "tp.order", module: "tp", schema: SCHEMA, table: "orders", label: "entity.tp.order", entityType: "documento",
  typed: { numbering: "none", lines: { entity: "tp.order_line", parentField: "order_id" } },
  displayField: "name", defaultSort: { field: "name", dir: "asc" },
  fields: [field("tp.order", "name", "text"), field("tp.order", "status", "text"), ...trailer("tp.order")],
};
const lineEntity: EntityDef = {
  id: "tp.order_line", module: "tp", schema: SCHEMA, table: "order_lines", label: "entity.tp.order_line", entityType: "lines",
  displayField: "description", defaultSort: { field: "line_no", dir: "asc" },
  fields: [field("tp.order_line", "order_id", "uuid"), field("tp.order_line", "line_no", "number"), field("tp.order_line", "description", "text"), field("tp.order_line", "amount", "money")],
};

const consult = (entity: string) =>
  defineProcess({
    id: `${entity}.consult`, module: "tp", kind: "consult", description: "Consulta registros de prueba",
    input: z.object({}), output: z.object({}), handler: async () => ({}),
  });
const createClient = defineProcess({
  id: "tp.client.create", module: "tp", kind: "create", description: "Crea un cliente de prueba",
  input: z.object({ name: z.string(), balance: z.number().default(0), creditLimit: z.number().default(0), secret: z.string().default("") }),
  output: z.object({ id: z.string() }),
  handler: async (ctx, input) => {
    const [row] = await ctx.tx<{ id: string }[]>`
      insert into tp_fixture.clients (company_id, name, balance, credit_limit, secret) values (${ctx.companyId}, ${input.name}, ${input.balance}, ${input.creditLimit}, ${input.secret}) returning id`;
    return { id: row!.id };
  },
});
const createOrder = defineProcess({
  id: "tp.order.create", module: "tp", kind: "create", description: "Crea un pedido de prueba",
  input: z.object({ name: z.string(), lines: z.array(z.object({ description: z.string(), amount: z.number() })) }),
  output: z.object({ id: z.string() }),
  handler: async (ctx, input) => {
    const [row] = await ctx.tx<{ id: string }[]>`insert into tp_fixture.orders (company_id, name, posts, requires_approval) values (${ctx.companyId}, ${input.name}, false, false) returning id`;
    let n = 0;
    for (const line of input.lines) {
      n += 1;
      await ctx.tx`insert into tp_fixture.order_lines (company_id, order_id, line_no, description, amount) values (${ctx.companyId}, ${row!.id}, ${n}, ${line.description}, ${line.amount})`;
    }
    return { id: row!.id };
  },
});

const tpModule = defineModule({
  id: "tp", version: "0.0.1", dependsOn: [],
  entities: [clientEntity, orderEntity, lineEntity],
  processes: [consult("tp.client"), consult("tp.order"), createClient, createOrder],
  features: [{ id: "tp.main", label: "feature.tp.main", processes: ["tp.client.consult", "tp.order.consult", "tp.client.create", "tp.order.create"], entities: ["tp.client", "tp.order", "tp.order_line"] }],
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
  drop schema if exists tp cascade;
  create schema tp;
  create function tp.attachments_changed(text, uuid, uuid) returns void language sql as $f$ select $f$;
  grant usage on schema ${SCHEMA} to authenticated, service_role;
  ${typedTable("clients", "maestro", "tp.client", "name text, balance numeric(18,4), credit_limit numeric(18,4), secret text,")}
  ${typedTable("orders", "documento", "tp.order", "name text,")}
  create table ${SCHEMA}.order_lines (
    id uuid primary key default kernel.uuid_v7(), seq bigint not null, company_id uuid not null references kernel.companies (id),
    order_id uuid not null references ${SCHEMA}.orders (id), line_no int, description text, amount numeric(18,4),
    created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
    created_by uuid default kernel.current_user_id(), updated_by uuid);
`;

const CATALOGUE: Record<string, string> = {
  "common.print.page_number": "Página {n} de {total}",
  "field.tp.client.name": "Razón social",
  "field.tp.client.balance": "Saldo pendiente",
};

const MEMBER_PROCESSES = ["tp.client.consult", "tp.order.consult", "tp.client.create", "tp.order.create", "kernel.doc_template.print"];
const SAVE = "kernel.doc_template.save";
const SET_DEFAULT = "kernel.doc_template.set_default";
const PRINT = "kernel.doc_template.print";

describe("PDF templates (Task 11)", () => {
  let sql: ReturnType<typeof testDb>;
  let seed: Awaited<ReturnType<typeof seedTenant>>;
  let registry: Registry;
  let companyId: string;
  let admin: Caller;
  /** A member: credit_limit masked, secret hidden, no record rules. */
  let member: Caller;
  /** A member of company 0 whose role may not consult tp.client. */
  let outsider: Caller;
  const exportsStore = new MemoryFileStore();
  const filesStore = new MemoryFileStore();

  const stepUp = async (caller: Caller, company: string = companyId): Promise<Caller> => {
    const stepUpToken = randomUUID();
    await sql`insert into kernel.step_up_verifications(user_id, company_id, token) values (${caller.claims.sub}, ${company}, ${stepUpToken})`;
    return { ...caller, stepUpToken };
  };
  const run = <T = Record<string, unknown>>(caller: Caller, processId: string, input: unknown): Promise<T> => runProcess({ sql, registry }, caller, processId, input);
  const asAdmin = async <T = Record<string, unknown>>(processId: string, input: unknown): Promise<T> => run<T>(await stepUp(admin), processId, input);
  const refusal = async (promise: Promise<unknown>) => (await promise.then(() => null, (e: unknown) => e)) as ProcessError | null;
  const newClient = async (name: string, extra: { balance?: number; creditLimit?: number; secret?: string } = {}) => (await run<{ id: string }>(admin, "tp.client.create", { name, ...extra })).id;
  /** The PDF behind a print's fileId, as the stored export job says. */
  const printed = async (fileId: string) => {
    const [job] = await sql<{ storage_path: string; status: string; format: string; user_id: string; row_count: number; file_name: string; entity: string }[]>`
      select storage_path, status, format, user_id, row_count, file_name, entity from kernel.export_jobs where id = ${fileId}`;
    expect(job).toBeDefined();
    return { job: job!, text: pdfText(await exportsStore.get(job!.storage_path)) };
  };
  const block = (b: Record<string, unknown>) => ({ x: 40, y: 40, w: 400, ...b });

  beforeAll(async () => {
    sql = testDb();
    setExportsStore(exportsStore);
    setFileStore(filesStore);
    registerCountryPack({ code: "CO", taxIdText: (id: string) => (id === "900373115" ? "900373115-3" : id), taxIdLabel: () => "NIT" } as unknown as CountryPack);
    // The catalogue the app registers at boot (packages/i18n); here a few of its keys.
    registerCatalogue((locale, key) => (locale === "es-419" ? CATALOGUE[key] : undefined));
    await sql.unsafe(TABLES_SQL);
    for (const table of ["clients", "orders", "order_lines"]) {
      await sql.unsafe(`select kernel.enable_company_rls('${SCHEMA}', '${table}')`);
      await sql.unsafe(`select kernel.enable_row_audit('${SCHEMA}', '${table}')`);
      await sql.unsafe(`create trigger assign_seq before insert on ${SCHEMA}.${table} for each row execute function core.assign_seq('tp.${table}')`);
      await sql.unsafe(`create trigger touch_row before update on ${SCHEMA}.${table} for each row execute function core.touch_row()`);
      await sql.unsafe(`grant select, insert, update, delete on ${SCHEMA}.${table} to authenticated`);
      await sql.unsafe(`grant all on ${SCHEMA}.${table} to service_role`);
    }
    await sql`select kernel.typed_lines(${SCHEMA}, 'order_lines', 'tp.order', 'order_id')`;
    for (const entity of [clientEntity, orderEntity, lineEntity]) {
      await sql.unsafe(maskedViewSql(defineEntity(entity)));
      await sql.unsafe(`grant select on ${SCHEMA}.v_${entity.table} to authenticated`);
    }

    registry = new Registry();
    loadModules(registry, [kernelModule, tpModule]);
    seed = await seedTenant(sql, {
      companies: 2,
      entitlements: ["module:tp"],
      users: [
        { name: "member", companies: [0], role: "member" },
        { name: "outsider", companies: [0], role: "member" },
      ],
    });
    companyId = seed.companies[0]!.id;
    const memberRole = seed.companies[0]!.memberRoleId;
    for (const id of MEMBER_PROCESSES) await sql`insert into kernel.process_permissions(company_id, role_id, process_id) values (${companyId}, ${memberRole}, ${id})`;
    await sql`insert into kernel.field_permissions(company_id, role_id, entity, field, mode) values (${companyId}, ${memberRole}, 'tp.client', 'credit_limit', 'masked'), (${companyId}, ${memberRole}, 'tp.client', 'secret', 'hidden'), (${companyId}, ${memberRole}, 'tp.order_line', 'amount', 'masked')`;
    // The outsider holds a role of its own with print but no consult of tp.client.
    const [other] = await sql<{ id: string }[]>`insert into kernel.roles(company_id, name, is_system) values (${companyId}, 'sin_clientes', false) returning id`;
    await sql`update kernel.membership_roles set role_id = ${other!.id} where membership_id = (select id from kernel.memberships where user_id = ${seed.users.outsider!} and company_id = ${companyId})`;
    await sql`insert into kernel.process_permissions(company_id, role_id, process_id) values (${companyId}, ${other!.id}, ${PRINT})`;

    admin = { claims: seed.claimsFor(seed.users.both, companyId), origin: "ui" };
    member = { claims: seed.claimsFor(seed.users.member!, companyId), origin: "ui" };
    outsider = { claims: { ...seed.claimsFor(seed.users.outsider!, companyId), role_ids: [other!.id] }, origin: "ui" };
    await syncRegistry(sql, registry);
    await sql`update kernel.users set full_name = 'Ana Restrepo' where id = ${seed.users.member!}`;
    // The demo company's data, through the admin process (migration 0048 adds the address, city and phone).
    await asAdmin("kernel.admin.company.update", { legalName: "Café del Norte S.A.S.", addressLine: "Carrera 43A # 1-50", city: "Medellín", phoneCc: "57", phone: "6044441234" });
    await sql`update kernel.companies set tax_id = '900373115' where id = ${companyId}`;
  });
  afterAll(async () => {
    registerCatalogue(undefined);
    setExportsStore(undefined);
    setFileStore(undefined);
    await sql`delete from kernel.doc_templates where company_id = any(${seed.companies.map((c) => c.id)}::uuid[])`;
    await sql`delete from kernel.entity_tables where module_id = 'tp'`;
    await sql`delete from kernel.entity_fields where module_id = 'tp'`;
    await sql`delete from kernel.record_access_tables where table_schema = ${SCHEMA}`;
    await sql.unsafe(`drop schema if exists ${SCHEMA} cascade`);
    await sql.unsafe(`drop schema if exists tp cascade`);
    await seed.cleanup();
    await sql.end();
  });

  describe("table (0048)", () => {
    it("kernel.doc_templates has company RLS, row audit, seq and one default per company, entity and scope", async () => {
      const policies = await sql<{ policyname: string }[]>`select policyname from pg_policies where schemaname = 'kernel' and tablename = 'doc_templates' order by policyname`;
      expect(policies.map((p) => p.policyname)).toEqual(expect.arrayContaining(["company_isolation", "admin_writes", "admin_updates"]));
      const [audit] = await sql`select 1 from pg_trigger where tgrelid = 'kernel.doc_templates'::regclass and tgname = 'audit_row_change'`;
      expect(audit).toBeDefined();
      const insert = (name: string) => sql`
        insert into kernel.doc_templates (company_id, entity, scope, name, blocks, is_default) values (${companyId}, 'tp.client', 'list', ${name}, '[]'::jsonb, true)`;
      await insert("Uno");
      await expect(insert("Dos")).rejects.toThrow(/doc_templates_one_default/);
      const [row] = await sql<{ seq: string; version: number }[]>`select seq, version from kernel.doc_templates where company_id = ${companyId} and name = 'Uno'`;
      expect(Number(row!.seq)).toBeGreaterThan(0);
      expect(row!.version).toBe(1);
      await sql`delete from kernel.doc_templates where company_id = ${companyId} and name = 'Uno'`;
    });

    it("a member reads the company's templates but cannot write them outside the admin process", async () => {
      const { id } = await asAdmin<{ id: string }>(SAVE, { entity: "tp.client", scope: "record", name: "Solo lectura", blocks: [] });
      const seen = await withClaims(sql, member.claims, async (tx) => ({
        read: (await tx`select id from kernel.v_doc_templates where id = ${id}`).length,
        updated: (await tx`update kernel.doc_templates set name = 'x' where id = ${id} returning id`).length,
      }));
      expect(seen).toEqual({ read: 1, updated: 0 });
      await expect(withClaims(sql, member.claims, (tx) => tx`insert into kernel.doc_templates (company_id, entity, scope, name, blocks) values (${companyId}, 'tp.client', 'record', 'Intrusa', '[]'::jsonb)`)).rejects.toThrow();
    });

    it("the baseline of a new role includes printing (kernel.seed_role_defaults)", async () => {
      const [role] = await sql<{ id: string }[]>`insert into kernel.roles(company_id, name, is_system) values (${companyId}, 'nuevo_rol', false) returning id`;
      await sql`select kernel.seed_role_defaults(${companyId}, ${role!.id})`;
      const [grant] = await sql`select 1 from kernel.process_permissions where role_id = ${role!.id} and process_id = ${PRINT}`;
      expect(grant).toBeDefined();
    });
  });

  describe("kernel.doc_template.save", () => {
    it("creates version 1 and every save of the same template is a new version", async () => {
      const first = await asAdmin<{ id: string; version: number }>(SAVE, { entity: "tp.client", scope: "record", name: "Ficha", blocks: [block({ kind: "text", value: "Ficha v1" })] });
      expect(first.version).toBe(1);
      const second = await asAdmin<{ id: string; version: number }>(SAVE, { id: first.id, entity: "tp.client", scope: "record", name: "Ficha", blocks: [block({ kind: "text", value: "Ficha v2" })] });
      expect(second).toEqual({ id: first.id, version: 2 });
      const third = await asAdmin<{ version: number }>(SAVE, { id: first.id, entity: "tp.client", scope: "record", name: "Ficha", blocks: [block({ kind: "text", value: "Ficha v3" })] });
      expect(third.version).toBe(3);
      const [row] = await sql<{ version: number; blocks: unknown }[]>`select version, blocks from kernel.doc_templates where id = ${first.id}`;
      expect(row!.version).toBe(3);
      expect(row!.blocks).toEqual([expect.objectContaining({ value: "Ficha v3" })]);
      const audits = await sql`select 1 from kernel.audit_log where process_id = ${SAVE} and row_id = ${first.id}`;
      expect(audits.length).toBeGreaterThanOrEqual(3);
    });

    it("refuses a save over a version the caller did not read (expectedVersion), as stale_record", async () => {
      const { id } = await asAdmin<{ id: string; version: number }>(SAVE, { entity: "tp.client", scope: "record", name: "Concurrente", blocks: [] });
      const second = await asAdmin<{ version: number }>(SAVE, { id, expectedVersion: 1, entity: "tp.client", scope: "record", name: "Concurrente", blocks: [block({ kind: "text", value: "Primera edición" })] });
      expect(second.version).toBe(2);
      // A second admin still holding version 1 does not overwrite the first's save.
      const stale = await refusal(asAdmin(SAVE, { id, expectedVersion: 1, entity: "tp.client", scope: "record", name: "Concurrente", blocks: [block({ kind: "text", value: "Segunda edición" })] }));
      expect(stale).toMatchObject({ code: "stale_record" });
      const [row] = await sql<{ version: number; blocks: unknown }[]>`select version, blocks from kernel.doc_templates where id = ${id}`;
      expect(row).toEqual({ version: 2, blocks: [expect.objectContaining({ value: "Primera edición" })] });
    });

    it("is admin only and asks for the step-up", async () => {
      expect(await refusal(run(await stepUp(member), SAVE, { entity: "tp.client", scope: "record", name: "X", blocks: [] }))).toMatchObject({ code: "forbidden" });
      expect(await refusal(run(admin, SAVE, { entity: "tp.client", scope: "record", name: "X", blocks: [] }))).toMatchObject({ code: "step_up_required" });
    });

    it("refuses an entity that is not a maestro or documento, a field the entity does not have and an unknown variable", async () => {
      expect(await refusal(asAdmin(SAVE, { entity: "tp.order_line", scope: "record", name: "X", blocks: [] }))).toMatchObject({ code: "invalid_input" });
      expect(await refusal(asAdmin(SAVE, { entity: "tp.client", scope: "record", name: "X", blocks: [block({ kind: "field", value: "nope" })] }))).toMatchObject({ code: "invalid_input" });
      expect(await refusal(asAdmin(SAVE, { entity: "tp.client", scope: "record", name: "X", blocks: [block({ kind: "variable", value: "empresa.clave" })] }))).toMatchObject({ code: "invalid_input" });
      expect(await refusal(asAdmin(SAVE, { entity: "tp.order", scope: "record", name: "X", blocks: [block({ kind: "lines", columns: ["nope"] })] }))).toMatchObject({ code: "invalid_input" });
    });

    it("never moves a template to another entity or scope", async () => {
      const { id } = await asAdmin<{ id: string }>(SAVE, { entity: "tp.client", scope: "record", name: "Fija", blocks: [] });
      expect(await refusal(asAdmin(SAVE, { id, entity: "tp.order", scope: "record", name: "Fija", blocks: [] }))).toMatchObject({ code: "invalid_input" });
      expect(await refusal(asAdmin(SAVE, { id: randomUUID(), entity: "tp.client", scope: "record", name: "Fija", blocks: [] }))).toMatchObject({ code: "not_found" });
    });
  });

  describe("kernel.doc_template.set_default", () => {
    it("one default per entity and scope: choosing another unsets the previous; null goes back to the built-in default", async () => {
      const a = await asAdmin<{ id: string }>(SAVE, { entity: "tp.order", scope: "list", name: "A", blocks: [] });
      const b = await asAdmin<{ id: string }>(SAVE, { entity: "tp.order", scope: "list", name: "B", blocks: [] });
      await asAdmin(SET_DEFAULT, { entity: "tp.order", scope: "list", id: a.id });
      await asAdmin(SET_DEFAULT, { entity: "tp.order", scope: "list", id: b.id });
      const defaults = await sql<{ id: string; version: number }[]>`select id, version from kernel.doc_templates where company_id = ${companyId} and entity = 'tp.order' and scope = 'list' and is_default`;
      expect(defaults.map((d) => d.id)).toEqual([b.id]);
      // Choosing the default is not a new version of the template.
      expect(defaults[0]!.version).toBe(1);
      await asAdmin(SET_DEFAULT, { entity: "tp.order", scope: "list", id: null });
      expect(await sql`select 1 from kernel.doc_templates where company_id = ${companyId} and entity = 'tp.order' and scope = 'list' and is_default`).toHaveLength(0);
      expect(await refusal(asAdmin(SET_DEFAULT, { entity: "tp.client", scope: "list", id: a.id }))).toMatchObject({ code: "not_found" });
    });

    it("is admin only and asks for the step-up", async () => {
      const { id } = await asAdmin<{ id: string }>(SAVE, { entity: "tp.order", scope: "record", name: "Predeterminable", blocks: [] });
      expect(await refusal(run(await stepUp(member), SET_DEFAULT, { entity: "tp.order", scope: "record", id }))).toMatchObject({ code: "forbidden" });
      expect(await refusal(run(admin, SET_DEFAULT, { entity: "tp.order", scope: "record", id }))).toMatchObject({ code: "step_up_required" });
      expect(await sql`select 1 from kernel.doc_templates where id = ${id} and is_default`).toHaveLength(0);
    });
  });

  describe("kernel.doc_template.print", () => {
    it("prints a record with the built-in default: Café del Norte's data, money as $ 1.234.567,00, the masked and hidden fields empty", async () => {
      const id = await newClient("Tienda La Esquina", { balance: 1234567, creditLimit: 9876543, secret: "no pagar" });
      const { fileId } = await run<{ fileId: string }>(member, PRINT, { entity: "tp.client", recordId: id, labels: { name: "Nombre", balance: "Saldo" } });
      const { job, text } = await printed(fileId);
      expect(job).toMatchObject({ status: "done", format: "pdf", user_id: seed.users.member, entity: "tp.client", row_count: 1 });
      expect(job.file_name).toMatch(/\.pdf$/);
      for (const shown of ["Café del Norte S.A.S.", "900373115-3", "Carrera 43A # 1-50", "Medellín", "Tienda La Esquina", "$ 1.234.567,00", "Ana Restrepo", "Saldo"]) expect(text).toContain(shown);
      expect(text).not.toContain("9.876.543");
      expect(text).not.toContain("no pagar");
      expect(text).not.toContain("••••••");
      // The admin, who sees every field, gets the credit limit.
      const full = await printed((await run<{ fileId: string }>(admin, PRINT, { entity: "tp.client", recordId: id })).fileId);
      expect(full.text).toContain("$ 9.876.543,00");
    });

    it("without the screen's labels the built-in template labels the fields from the catalogue; the page number and the tax id label are the catalogue's and the pack's", async () => {
      const id = await newClient("Cliente sin etiquetas", { balance: 5 });
      const { text } = await printed((await run<{ fileId: string }>(member, PRINT, { entity: "tp.client", recordId: id })).fileId);
      for (const shown of ["Razón social", "Saldo pendiente", "NIT", "900373115-3", "Página 1 de 1"]) expect(text).toContain(shown);
      expect(text).not.toMatch(/\bbalance\b/);
      // The caller may give the page number's words in its language.
      const english = await printed((await run<{ fileId: string }>(member, PRINT, { entity: "tp.client", recordId: id, pageText: "Page {n} of {total}" })).fileId);
      expect(english.text).toContain("Page 1 of 1");
    });

    it("prints the company's default template, and a chosen one by id", async () => {
      const id = await newClient("Cliente con plantilla", { balance: 10 });
      const mine = await asAdmin<{ id: string }>(SAVE, { entity: "tp.client", scope: "record", name: "Membrete", blocks: [block({ kind: "text", value: "Plantilla de la empresa" }), block({ kind: "field", y: 80, value: "name" })] });
      const other = await asAdmin<{ id: string }>(SAVE, { entity: "tp.client", scope: "record", name: "Otra", blocks: [block({ kind: "text", value: "Plantilla elegida" })] });
      await asAdmin(SET_DEFAULT, { entity: "tp.client", scope: "record", id: mine.id });
      const byDefault = await printed((await run<{ fileId: string }>(member, PRINT, { entity: "tp.client", recordId: id })).fileId);
      expect(byDefault.text).toContain("Plantilla de la empresa");
      expect(byDefault.text).toContain("Cliente con plantilla");
      const chosen = await printed((await run<{ fileId: string }>(member, PRINT, { entity: "tp.client", recordId: id, templateId: other.id })).fileId);
      expect(chosen.text).toContain("Plantilla elegida");
      // A template of another entity or scope is refused; an unknown one is not found.
      const listTemplate = await asAdmin<{ id: string }>(SAVE, { entity: "tp.client", scope: "list", name: "Lista", blocks: [] });
      expect(await refusal(run(member, PRINT, { entity: "tp.client", recordId: id, templateId: listTemplate.id }))).toMatchObject({ code: "invalid_input" });
      expect(await refusal(run(member, PRINT, { entity: "tp.client", recordId: id, templateId: randomUUID() }))).toMatchObject({ code: "not_found" });
      await asAdmin(SET_DEFAULT, { entity: "tp.client", scope: "record", id: null });
    });

    it("a record the caller cannot read is refused exactly like one that does not exist", async () => {
      const id = await newClient("Cliente reservado");
      await asAdmin("kernel.record_access.set", { entity: "tp.client", recordId: id, grants: [{ userId: seed.users.both, rights: ["read"] }] });
      const hidden = await refusal(run(member, PRINT, { entity: "tp.client", recordId: id }));
      const missing = await refusal(run(member, PRINT, { entity: "tp.client", recordId: randomUUID() }));
      expect(hidden).toMatchObject({ code: "not_found" });
      expect(missing).toMatchObject({ code: "not_found" });
      expect(hidden!.message.replace(id, "<id>")).toBe(missing!.message.replace(/[0-9a-f-]{36}/, "<id>"));
      expect(hidden!.details).toEqual(missing!.details);
      await asAdmin("kernel.record_access.set", { entity: "tp.client", recordId: id, grants: [] });
    });

    it("a list prints the grid state's filter, sort and columns and excludes the rows hidden by record access", async () => {
      const ids = [await newClient("Lista Alfa", { balance: 100 }), await newClient("Lista Beta", { balance: 200 }), await newClient("Lista Gamma", { balance: 300 })];
      await newClient("Fuera del filtro");
      await asAdmin("kernel.record_access.set", { entity: "tp.client", recordId: ids[1], grants: [{ userId: seed.users.both, rights: ["read"] }] });
      const gridState = { filters: [{ field: "name", op: "starts", value: "Lista" }], sort: [{ field: "name", dir: "desc" }], page: 1, pageSize: 50, columns: ["name", "balance"] };
      const { job, text } = await printed((await run<{ fileId: string }>(member, PRINT, { entity: "tp.client", gridState, title: "Clientes" })).fileId);
      expect(job.row_count).toBe(2);
      expect(text).toContain("Lista Alfa");
      expect(text).toContain("Lista Gamma");
      expect(text).not.toContain("Lista Beta");
      expect(text).not.toContain("Fuera del filtro");
      expect(text.indexOf("Lista Gamma")).toBeLessThan(text.indexOf("Lista Alfa"));
      // The total of the money column counts only the rows printed.
      expect(text).toContain("$ 400,00");
      // The admin is never narrowed (D12).
      const all = await printed((await run<{ fileId: string }>(admin, PRINT, { entity: "tp.client", gridState })).fileId);
      expect(all.job.row_count).toBe(3);
      expect(all.text).toContain("Lista Beta");
      // A masked field cannot filter the list (rule 14), as in the grid.
      expect(await refusal(run(member, PRINT, { entity: "tp.client", gridState: { ...gridState, filters: [{ field: "credit_limit", op: "gt", value: 1 }] } }))).toMatchObject({ code: "forbidden" });
      await asAdmin("kernel.record_access.set", { entity: "tp.client", recordId: ids[1], grants: [] });
    });

    it("a documento prints its lines in the record's table; a line column the caller sees masked prints empty, its total too", async () => {
      const { id } = await run<{ id: string }>(admin, "tp.order.create", { name: "Pedido 7", lines: [{ description: "Café de origen", amount: 1000 }, { description: "Filtros", amount: 234567 }] });
      const { text } = await printed((await run<{ fileId: string }>(member, PRINT, { entity: "tp.order", recordId: id })).fileId);
      expect(text).toContain("Pedido 7");
      expect(text).toContain("Café de origen");
      expect(text).toContain("Filtros");
      expect(text).not.toContain("234.567");
      expect(text).not.toContain("235.567");
      expect(text).not.toContain("••••••");
      const full = await printed((await run<{ fileId: string }>(admin, PRINT, { entity: "tp.order", recordId: id })).fileId);
      expect(full.text).toContain("$ 234.567,00");
      expect(full.text).toContain("$ 235.567,00");
    });

    it("refuses a record whose lines pass the PDF limit (pdf_too_large) instead of printing a part of them", async () => {
      const { id } = await run<{ id: string }>(admin, "tp.order.create", { name: "Pedido enorme", lines: [] });
      await sql`
        insert into tp_fixture.order_lines (company_id, order_id, line_no, description, amount)
        select ${companyId}, ${id}, n, 'Línea ' || n, 1 from generate_series(1, 2001) n`;
      expect(await refusal(run(admin, PRINT, { entity: "tp.order", recordId: id }))).toMatchObject({ code: "invalid_input", details: ["pdf_too_large"] });
      await sql`delete from tp_fixture.order_lines where order_id = ${id} and line_no > 2000`;
      const { job } = await printed((await run<{ fileId: string }>(admin, PRINT, { entity: "tp.order", recordId: id })).fileId);
      expect(job.row_count).toBe(1);
    });

    it("refuses a caller whose roles may not consult the entity, and an entity that is not a maestro or documento", async () => {
      const id = await newClient("Sin consulta");
      expect(await refusal(run(outsider, PRINT, { entity: "tp.client", recordId: id }))).toMatchObject({ code: "forbidden" });
      expect(await refusal(run(member, PRINT, { entity: "tp.order_line", recordId: id }))).toMatchObject({ code: "invalid_input" });
    });

    it("draws the blocks over the template's background PDF (an attachment of the template)", async () => {
      const { id: templateId } = await asAdmin<{ id: string }>(SAVE, { entity: "tp.client", scope: "record", name: "Con fondo", blocks: [block({ kind: "field", y: 120, value: "name" })] });
      const bg = await PDFDocument.create();
      const font = await bg.embedFont(StandardFonts.Helvetica);
      bg.addPage([612, 792]).drawText("MEMBRETE CAFE DEL NORTE", { x: 40, y: 740, size: 14, font });
      const bytes = Buffer.from(await bg.save());
      const path = `${companyId}/kernel.doc_template/${templateId}/${randomUUID()}.pdf`;
      await filesStore.put(path, bytes, "application/pdf");
      const [attachment] = await sql<{ id: string }[]>`
        insert into kernel.attachments (company_id, entity, record_id, tag, file_name, mime_type, size_bytes, storage_path)
        values (${companyId}, 'kernel.doc_template', ${templateId}, 'Fondo', 'membrete.pdf', 'application/pdf', ${bytes.length}, ${path}) returning id`;
      const saved = await asAdmin<{ version: number }>(SAVE, { id: templateId, entity: "tp.client", scope: "record", name: "Con fondo", blocks: [block({ kind: "field", y: 120, value: "name" })], backgroundFileId: attachment!.id });
      expect(saved.version).toBe(2);
      const client = await newClient("Cliente con membrete");
      const { text } = await printed((await run<{ fileId: string }>(member, PRINT, { entity: "tp.client", recordId: client, templateId })).fileId);
      expect(text).toContain("MEMBRETE CAFE DEL NORTE");
      expect(text).toContain("Cliente con membrete");

      // A background must be a PDF attached to the template itself.
      const png = `${companyId}/kernel.doc_template/${templateId}/${randomUUID()}.png`;
      await filesStore.put(png, Buffer.from("not a pdf"), "image/png");
      const [image] = await sql<{ id: string }[]>`
        insert into kernel.attachments (company_id, entity, record_id, tag, file_name, mime_type, size_bytes, storage_path)
        values (${companyId}, 'kernel.doc_template', ${templateId}, 'Logo', 'logo.png', 'image/png', 9, ${png}) returning id`;
      expect(await refusal(asAdmin(SAVE, { id: templateId, entity: "tp.client", scope: "record", name: "Con fondo", blocks: [], backgroundFileId: image!.id }))).toMatchObject({ code: "invalid_input" });
      // A PDF without pages, or with a page larger than a template can place blocks on, is no background.
      const attach = async (doc: PDFDocument | Buffer, name: string) => {
        const pdfBytes = Buffer.isBuffer(doc) ? doc : Buffer.from(await doc.save());
        const at = `${companyId}/kernel.doc_template/${templateId}/${randomUUID()}.pdf`;
        await filesStore.put(at, pdfBytes, "application/pdf");
        const [row] = await sql<{ id: string }[]>`
          insert into kernel.attachments (company_id, entity, record_id, tag, file_name, mime_type, size_bytes, storage_path)
          values (${companyId}, 'kernel.doc_template', ${templateId}, 'Fondo', ${name}, 'application/pdf', ${pdfBytes.length}, ${at}) returning id`;
        return row!.id;
      };
      // Written by hand: pdf-lib adds a blank page to a document saved without any.
      const noPages = "%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [] /Count 0 >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n";
      const empty = await attach(Buffer.from(noPages, "latin1"), "vacio.pdf");
      const huge = await PDFDocument.create();
      huge.addPage([2400, 2400]);
      const oversized = await attach(huge, "enorme.pdf");
      for (const backgroundFileId of [empty, oversized]) {
        expect(await refusal(asAdmin(SAVE, { id: templateId, entity: "tp.client", scope: "record", name: "Con fondo", blocks: [], backgroundFileId }))).toMatchObject({ code: "invalid_input" });
      }
      const other = await asAdmin<{ id: string }>(SAVE, { entity: "tp.client", scope: "record", name: "Ajena", blocks: [] });
      expect(await refusal(asAdmin(SAVE, { id: other.id, entity: "tp.client", scope: "record", name: "Ajena", blocks: [], backgroundFileId: attachment!.id }))).toMatchObject({ code: "invalid_input" });
    });

    it("the company's logo (an image attachment of a template) prints in the letterhead; a phone and a logo are validated", async () => {
      const { id: templateId } = await asAdmin<{ id: string }>(SAVE, { entity: "tp.client", scope: "record", name: "Con logo", blocks: [block({ kind: "image", w: 60, h: 30, value: "empresa.logo" })] });
      const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
      const path = `${companyId}/kernel.doc_template/${templateId}/${randomUUID()}.png`;
      await filesStore.put(path, png, "image/png");
      const [logo] = await sql<{ id: string }[]>`
        insert into kernel.attachments (company_id, entity, record_id, tag, file_name, mime_type, size_bytes, storage_path)
        values (${companyId}, 'kernel.doc_template', ${templateId}, 'Logo', 'logo-cafe.png', 'image/png', ${png.length}, ${path}) returning id`;
      await asAdmin("kernel.admin.company.update", { logoAttachmentId: logo!.id });
      const client = await newClient("Cliente con logo");
      const { job } = await printed((await run<{ fileId: string }>(member, PRINT, { entity: "tp.client", recordId: client, templateId })).fileId);
      expect(Buffer.from(await exportsStore.get(job.storage_path)).toString("latin1")).toContain("/Subtype /Image");
      await asAdmin("kernel.admin.company.update", { logoAttachmentId: null });

      // A PDF is no logo; a phone is country code + number (rule 11).
      const [pdf] = await sql<{ id: string }[]>`
        insert into kernel.attachments (company_id, entity, record_id, tag, file_name, mime_type, size_bytes, storage_path)
        values (${companyId}, 'kernel.doc_template', ${templateId}, 'Otro', 'otro.pdf', 'application/pdf', 1, ${`${path}.pdf`}) returning id`;
      expect(await refusal(asAdmin("kernel.admin.company.update", { logoAttachmentId: pdf!.id }))).toMatchObject({ code: "invalid_input" });
      // A file stored as a PNG whose bytes are not one is refused as a logo; set anyway (outside the process), the print goes out without it.
      const fake = `${companyId}/kernel.doc_template/${templateId}/${randomUUID()}.png`;
      await filesStore.put(fake, Buffer.from("not really a png"), "image/png");
      const [bad] = await sql<{ id: string }[]>`
        insert into kernel.attachments (company_id, entity, record_id, tag, file_name, mime_type, size_bytes, storage_path)
        values (${companyId}, 'kernel.doc_template', ${templateId}, 'Logo', 'falso.png', 'image/png', 16, ${fake}) returning id`;
      expect(await refusal(asAdmin("kernel.admin.company.update", { logoAttachmentId: bad!.id }))).toMatchObject({ code: "invalid_input" });
      await sql`update kernel.companies set logo_attachment_id = ${bad!.id} where id = ${companyId}`;
      const withoutLogo = await printed((await run<{ fileId: string }>(member, PRINT, { entity: "tp.client", recordId: client, templateId })).fileId);
      expect(Buffer.from(await exportsStore.get(withoutLogo.job.storage_path)).toString("latin1")).not.toContain("/Subtype /Image");
      await sql`update kernel.companies set logo_attachment_id = null where id = ${companyId}`;
      expect(await refusal(asAdmin("kernel.admin.company.update", { phoneCc: "57", phone: "12" }))).toMatchObject({ code: "invalid_input" });
      const [company] = await sql<{ phone: string; phone_cc: string; city: string }[]>`select phone, phone_cc, city from kernel.companies where id = ${companyId}`;
      expect(company).toEqual({ phone: "6044441234", phone_cc: "57", city: "Medellín" });
    });

    it("the printed file is the caller's export job: the other member of the company does not see it", async () => {
      const id = await newClient("Privado");
      const { fileId } = await run<{ fileId: string }>(member, PRINT, { entity: "tp.client", recordId: id });
      const seen = await withClaims(sql, outsider.claims, (tx) => tx`select id from kernel.v_export_jobs where id = ${fileId}`);
      expect(seen).toHaveLength(0);
    });

    it("a print's job row is only a finished PDF of the caller's company; an export's only a queued job (kernel.export_jobs insert policy)", async () => {
      const other = seed.companies[1]!.id;
      const insert = (processId: string, status: string, path: string | null) =>
        withClaims(sql, member.claims, async (tx) => {
          await tx`select set_config('erp.audit_process_id', ${processId}, true)`;
          const id = randomUUID();
          await tx`
            insert into kernel.export_jobs (id, company_id, user_id, entity, format, state, status, storage_path, file_name)
            values (${id}, ${companyId}, ${seed.users.member!}, 'tp.client', 'pdf', '{}'::jsonb, ${status}, ${path?.replace("<id>", id) ?? null}, 'x.pdf')`;
        });
      await expect(insert(PRINT, "queued", `${companyId}/<id>.pdf`)).rejects.toThrow(/row-level security/);
      await expect(insert(PRINT, "done", `${other}/<id>.pdf`)).rejects.toThrow(/row-level security/);
      await expect(insert(PRINT, "done", null)).rejects.toThrow(/row-level security/);
      await expect(insert("kernel.export.run", "done", `${companyId}/<id>.pdf`)).rejects.toThrow(/row-level security/);
    });

    it("after a company switch nothing of the other company prints, saves or becomes the default, and its print jobs are not seen", async () => {
      const company1 = seed.companies[1]!.id;
      const admin1: Caller = { claims: seed.claimsFor(seed.users.both, company1), origin: "ui" };
      const asAdmin1 = async <T = Record<string, unknown>>(processId: string, input: unknown): Promise<T> => run<T>(await stepUp(admin1, company1), processId, input);
      // Company 0: a record, a template and a print job of its admin.
      const record0 = await newClient("Cliente de la empresa 0");
      const template0 = await asAdmin<{ id: string }>(SAVE, { entity: "tp.client", scope: "record", name: "Plantilla de la empresa 0", blocks: [] });
      const { fileId } = await run<{ fileId: string }>(admin, PRINT, { entity: "tp.client", recordId: record0 });
      // The same user, admin of company 1 too, after switching to it.
      const record1 = (await run<{ id: string }>(admin1, "tp.client.create", { name: "Cliente de la empresa 1" })).id;
      expect(await refusal(run(admin1, PRINT, { entity: "tp.client", recordId: record0 }))).toMatchObject({ code: "not_found" });
      expect(await refusal(run(admin1, PRINT, { entity: "tp.client", recordId: record1, templateId: template0.id }))).toMatchObject({ code: "not_found" });
      expect(await refusal(asAdmin1(SAVE, { id: template0.id, entity: "tp.client", scope: "record", name: "Robada", blocks: [] }))).toMatchObject({ code: "not_found" });
      expect(await refusal(asAdmin1(SET_DEFAULT, { entity: "tp.client", scope: "record", id: template0.id }))).toMatchObject({ code: "not_found" });
      const [template] = await sql<{ name: string; is_default: boolean; company_id: string }[]>`select name, is_default, company_id from kernel.doc_templates where id = ${template0.id}`;
      expect(template).toEqual({ name: "Plantilla de la empresa 0", is_default: false, company_id: companyId });
      const seen = await withClaims(sql, admin1.claims, (tx) => tx`select id from kernel.v_export_jobs where id = ${fileId}`);
      expect(seen).toHaveLength(0);
      // Its own record prints in company 1.
      const { job } = await printed((await run<{ fileId: string }>(admin1, PRINT, { entity: "tp.client", recordId: record1 })).fileId);
      expect(job.row_count).toBe(1);
    });
  });
});
