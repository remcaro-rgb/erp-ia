import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import ExcelJS from "exceljs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { start } from "workflow/api";
import { z } from "zod";
import { syncRegistry } from "../../admin/sync";
import type { Caller } from "../../process/context";
import { seedTenant, testDb, type SeededTenant } from "../../db/test-db";
import { openExport } from "../../exports/render";
import { MemoryFileStore, setFileStore } from "../../files/store";
import { defineModule } from "../../module/define";
import { kernelModule } from "../../module/kernel-module";
import { loadModules } from "../../module/loader";
import { defineProcess } from "../../process/define";
import { ProcessError } from "../../process/errors";
import { runProcess } from "../../process/run";
import { defineEntity, registry, type EntityDef } from "../../registry";
import { registerCatalogue } from "../../registry/labels";
import { maskedViewSql } from "../../security/masked-views";
import { IMPORT_PROCESSES } from "../processes";
import { runImport } from "../run";
import { previewImport, submitImport } from "../submit";

// Import and export of typed entities (entity types spec 2026-11-02 §2.5, D14, §10.2; Phase 2A.5 Task 13; Review Focus 2 and 5).
// Every imported row runs the entity's registered processes as the importer: a documento is created with its lines (header and Líneas
// sheets joined by `ref`) and stays Borrador; a maestro is created and then follows the lifecycle as the screen's Grabar does (Grabado,
// then Pendiente de Aprobación when the company requires approval of it). Nothing is ever approved or posted by an import. A maestro
// hidden from the importer by record access is never matched by its import key: the duplicate is refused without telling anything
// about it. An export prints the lifecycle state's label and leaves out the records hidden from the caller.
// The fixture module `ti` (schema ti_fixture) is created here, never in a migration.

const SCHEMA = "ti_fixture";
const field = (entity: string, name: string, type: EntityDef["fields"][number]["type"]) => ({ name, type, label: `field.${entity}.${name}` });
const STATUS = (entity: string) => ({ ...field(entity, "status", "enum"), enumValues: ["draft", "saved", "pending", "rejected", "approved", "posted", "voided"], valuesKey: "grid.values.record_status" });
const trailer = (entity: string) => [field(entity, "extra", "json"), field(entity, "extra_free", "json"), field(entity, "created_at", "datetime"), field(entity, "updated_at", "datetime")];

const masEntity: EntityDef = {
  id: "ti.mas", module: "ti", schema: SCHEMA, table: "masters", label: "entity.ti.mas", entityType: "maestro", importKey: ["name"],
  displayField: "name", defaultSort: { field: "name", dir: "asc" },
  fields: [field("ti.mas", "name", "text"), field("ti.mas", "code", "text"), field("ti.mas", "is_active", "boolean"), STATUS("ti.mas"), ...trailer("ti.mas")],
};
const docEntity: EntityDef = {
  id: "ti.doc", module: "ti", schema: SCHEMA, table: "docs", label: "entity.ti.doc", entityType: "documento",
  typed: { numbering: "none", lines: { entity: "ti.doc_line", parentField: "doc_id" } },
  displayField: "name", defaultSort: { field: "name", dir: "asc" },
  fields: [field("ti.doc", "name", "text"), { ...field("ti.doc", "mas_id", "ref"), ref: { entity: "ti.mas", display: "name" } }, STATUS("ti.doc"), ...trailer("ti.doc")],
};
const lineEntity: EntityDef = {
  id: "ti.doc_line", module: "ti", schema: SCHEMA, table: "doc_lines", label: "entity.ti.doc_line", entityType: "lines",
  displayField: "description", defaultSort: { field: "description", dir: "asc" },
  fields: [field("ti.doc_line", "doc_id", "uuid"), field("ti.doc_line", "description", "text"), field("ti.doc_line", "qty", "number"), { ...field("ti.doc_line", "mas_id", "ref"), ref: { entity: "ti.mas", display: "name" } }],
};

/** The module's own refusal of a duplicate name (as core's `refuseDuplicate`): it names the value the caller gave. */
const createMas = defineProcess({
  id: "ti.mas.create", module: "ti", kind: "create", description: "Crea un maestro de prueba en Borrador",
  input: z.object({ name: z.string().trim().min(1), code: z.string().trim().min(1).optional() }), output: z.object({ id: z.string() }),
  handler: async (ctx, input) => {
    try {
      const [row] = await ctx.tx<{ id: string }[]>`insert into ti_fixture.masters (company_id, name, code) values (${ctx.companyId}, ${input.name}, ${input.code ?? null}) returning id`;
      return { id: row!.id };
    } catch (error) {
      const pg = error as { code?: string; constraint_name?: string };
      if (pg.code === "23505") {
        const detail = pg.constraint_name === "masters_code_key" ? `Ya existe un maestro con el código ${input.code}` : `Ya existe un maestro llamado ${input.name}`;
        throw new ProcessError("invalid_input", "duplicate in ti.mas.create", { details: [detail], cause: error });
      }
      throw error;
    }
  },
});
const createDoc = defineProcess({
  id: "ti.doc.create", module: "ti", kind: "create", description: "Crea un documento de prueba en Borrador con sus líneas",
  input: z.object({
    name: z.string().trim().min(1),
    masId: z.uuid().nullable().optional(),
    lines: z.array(z.object({ description: z.string().trim().min(1), qty: z.number().positive(), masId: z.uuid().nullable().optional() }).strict()).min(1),
  }),
  output: z.object({ id: z.string() }),
  handler: async (ctx, input) => {
    const [row] = await ctx.tx<{ id: string }[]>`insert into ti_fixture.docs (company_id, name, mas_id) values (${ctx.companyId}, ${input.name}, ${input.masId ?? null}) returning id`;
    for (const line of input.lines) {
      await ctx.tx`insert into ti_fixture.doc_lines (company_id, doc_id, description, qty, mas_id) values (${ctx.companyId}, ${row!.id}, ${line.description}, ${line.qty}, ${line.masId ?? null})`;
    }
    return { id: row!.id };
  },
});
const consult = (entity: string) =>
  defineProcess({ id: `${entity}.consult`, module: "ti", kind: "consult", description: "Consulta", input: z.object({}), output: z.object({}), handler: async () => ({}) });

const tiModule = defineModule({
  id: "ti", version: "0.0.1", dependsOn: [],
  entities: [masEntity, docEntity, lineEntity],
  processes: [createMas, createDoc, consult("ti.mas"), consult("ti.doc")],
  features: [{ id: "ti.main", label: "feature.ti.main", processes: ["ti.mas.create", "ti.doc.create", "ti.mas.consult", "ti.doc.consult"], entities: ["ti.mas", "ti.doc", "ti.doc_line"] }],
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
  drop schema if exists ti cascade;
  create schema ti;
  create function ti.attachments_changed(text, uuid, uuid) returns void language sql as $f$ select $f$;
  grant usage on schema ${SCHEMA} to authenticated, service_role;
  ${typedTable("masters", "maestro", "ti.mas", "name text not null, code text,")}
  create unique index masters_name_key on ${SCHEMA}.masters (company_id, lower(name));
  -- A second unique key that is not the import key (m4).
  alter table ${SCHEMA}.masters add constraint masters_code_key unique (company_id, code);
  ${typedTable("docs", "documento", "ti.doc", "name text, mas_id uuid,")}
  create table ${SCHEMA}.doc_lines (
    id uuid primary key default kernel.uuid_v7(), seq bigint not null, company_id uuid not null references kernel.companies (id),
    doc_id uuid not null references ${SCHEMA}.docs (id), description text, qty numeric, mas_id uuid,
    created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
    created_by uuid default kernel.current_user_id(), updated_by uuid);
`;

const MEMBER_PROCESSES = [
  "ti.mas.create", "ti.mas.save", "ti.mas.submit", "ti.mas.consult", "ti.doc.create", "ti.doc.consult",
  "kernel.attachment.add", ...IMPORT_PROCESSES.map((p) => p.id),
];
const MAS_LABELS = { name: "Nombre", code: "Código" };
const DOC_LABELS = { ref: "ref", name: "Nombre", masId: "Maestro", "lines.description": "Descripción", "lines.qty": "Cantidad", "lines.masId": "Maestro de la línea" };

describe("import and export of typed entities (Task 13)", () => {
  const sql = testDb();
  const store = new MemoryFileStore();
  let seed: SeededTenant;
  let companyId: string;
  let admin: Caller;
  /** A member narrowed out of the reserved maestro. */
  let restricted: Caller;
  /** The only member the reserved maestro is granted to. */
  let granted: Caller;

  const csv = (...lines: string[]) => new TextEncoder().encode(`${lines.join("\r\n")}\r\n`);
  const xlsx = async (header: unknown[][], lines: unknown[][]) => {
    const book = new ExcelJS.Workbook();
    book.addWorksheet("Datos").addRows(header);
    book.addWorksheet("Líneas").addRows(lines);
    return new Uint8Array(await book.xlsx.writeBuffer());
  };
  /** Imports `bytes` as `caller` through the route's path (kernel.import.run with step-up, then the runImport workflow). */
  const importAs = async (caller: Caller, entity: string, fileName: string, bytes: Uint8Array, labels: Record<string, string>) => {
    const stepUpToken = randomUUID();
    await sql`insert into kernel.step_up_verifications(user_id, company_id, token) values (${caller.claims.sub}, ${companyId}, ${stepUpToken})`;
    const ids = await submitImport({ sql, registry }, { ...caller, stepUpToken }, { entity, fileName, bytes });
    const run = await start(runImport, [{ ...ids, claims: caller.claims, labels }]);
    const summary = await run.returnValue;
    const [row] = await sql<{ errors_attachment_id: string | null }[]>`select errors_attachment_id from kernel.imports where id = ${ids.importId}`;
    const errors = row?.errors_attachment_id
      ? new TextDecoder().decode(await store.get((await sql<{ storage_path: string }[]>`select storage_path from kernel.attachments where id = ${row.errors_attachment_id}`)[0]!.storage_path)).trimEnd().split("\r\n")
      : [];
    return { summary, errors };
  };
  const masters = async () => sql<{ name: string; status: string; requires_approval: boolean }[]>`
    select name, status, requires_approval from ti_fixture.masters where company_id = ${companyId} order by name`;
  const setApproval = (requires: boolean) => sql`
    insert into kernel.entity_type_settings (company_id, entity, requires_approval) values (${companyId}, 'ti.mas', ${requires})
    on conflict (company_id, entity) do update set requires_approval = excluded.requires_approval`;

  beforeAll(async () => {
    await sql.unsafe(TABLES_SQL);
    for (const table of ["masters", "docs", "doc_lines"]) {
      await sql.unsafe(`select kernel.enable_company_rls('${SCHEMA}', '${table}')`);
      await sql.unsafe(`select kernel.enable_row_audit('${SCHEMA}', '${table}')`);
      await sql.unsafe(`create trigger assign_seq before insert on ${SCHEMA}.${table} for each row execute function core.assign_seq('ti.${table}')`);
      await sql.unsafe(`create trigger touch_row before update on ${SCHEMA}.${table} for each row execute function core.touch_row()`);
      await sql.unsafe(`grant select, insert, update, delete on ${SCHEMA}.${table} to authenticated`);
      await sql.unsafe(`grant all on ${SCHEMA}.${table} to service_role`);
    }
    await sql`select kernel.typed_lines(${SCHEMA}, 'doc_lines', 'ti.doc', 'doc_id')`;
    for (const entity of [masEntity, docEntity, lineEntity]) {
      await sql.unsafe(maskedViewSql(defineEntity(entity)));
      await sql.unsafe(`grant select on ${SCHEMA}.v_${entity.table} to authenticated`);
    }

    loadModules(registry, [kernelModule, tiModule]);
    seed = await seedTenant(sql, {
      companies: 1,
      entitlements: ["module:ti"],
      users: [
        { name: "restricted", companies: [0], role: "member" },
        { name: "granted", companies: [0], role: "member" },
      ],
    });
    companyId = seed.companies[0]!.id;
    for (const id of MEMBER_PROCESSES) {
      await sql`insert into kernel.process_permissions(company_id, role_id, process_id) values (${companyId}, ${seed.companies[0]!.memberRoleId}, ${id})`;
      await sql`insert into kernel.process_permissions(company_id, role_id, process_id) values (${companyId}, ${seed.companies[0]!.adminRoleId}, ${id})`;
    }
    admin = { claims: seed.claimsFor(seed.users.both, companyId), origin: "ui" };
    restricted = { claims: seed.claimsFor(seed.users.restricted!, companyId), origin: "ui" };
    granted = { claims: seed.claimsFor(seed.users.granted!, companyId), origin: "ui" };
    await syncRegistry(sql, registry);
    setFileStore(store);
    // The application's catalogue, as the web app and the worker register it at boot (packages/i18n).
    const catalogues = Object.fromEntries(["es-419", "en"].map((locale) => [locale, JSON.parse(readFileSync(join(import.meta.dirname, `../../../../i18n/messages/${locale}.json`), "utf8"))]));
    registerCatalogue((locale, key) => {
      let node: unknown = catalogues[locale] ?? catalogues["es-419"];
      for (const part of key.split(".")) node = typeof node === "object" && node !== null ? (node as Record<string, unknown>)[part] : undefined;
      return typeof node === "string" ? node : undefined;
    });
  });

  afterAll(async () => {
    registerCatalogue(undefined);
    setFileStore(undefined);
    await sql`delete from kernel.record_access where company_id = ${companyId}`;
    await sql`delete from kernel.entity_type_settings where company_id = ${companyId}`;
    await sql`delete from kernel.step_up_verifications where company_id = ${companyId}`;
    await sql`delete from kernel.process_permissions where company_id = ${companyId}`;
    await sql`delete from kernel.entity_tables where module_id = 'ti'`;
    await sql`delete from kernel.entity_fields where module_id = 'ti'`;
    await sql`delete from kernel.record_access_tables where table_schema = ${SCHEMA}`;
    await sql.unsafe(`drop schema if exists ${SCHEMA} cascade`);
    await sql.unsafe(`drop schema if exists ti cascade`);
    await seed.cleanup();
    await sql.end();
  });

  it("an imported maestro is Grabado; with Requiere aprobación it lands Pendiente de Aprobación, never Aprobado (Review Focus 5)", async () => {
    const plain = await importAs(admin, "ti.mas", "maestros.csv", csv("Nombre", "Abierto", "Otro"), MAS_LABELS);
    expect(plain.summary).toMatchObject({ status: "done", created: 2, rejected: 0 });
    await setApproval(true);
    const approval = await importAs(admin, "ti.mas", "maestros.csv", csv("Nombre", "Con aprobación"), MAS_LABELS);
    expect(approval.summary).toMatchObject({ status: "done", created: 1, rejected: 0 });
    await setApproval(false);
    expect(await masters()).toEqual([
      { name: "Abierto", status: "saved", requires_approval: false },
      { name: "Con aprobación", status: "pending", requires_approval: true },
      { name: "Otro", status: "saved", requires_approval: false },
    ]);
  });

  it("an imported documento lands Borrador with its lines, never approved or posted; a line failure fails its whole document only (Review Focus 5)", async () => {
    const bytes = await xlsx(
      [["ref", "Nombre", "Maestro"], ["A", "Pedido A", "abierto"], ["B", "Pedido B", null], ["C", "Pedido C", null]],
      [["ref", "Descripción", "Cantidad", "Maestro de la línea"], ["A", "Uno", 1, "Otro"], ["B", "Mala", 0, null], ["A", "Dos", 2, null], ["B", "Buena", 1, null], ["C", "Tres", 3, null]],
    );
    const { summary, errors } = await importAs(admin, "ti.doc", "documentos.xlsx", bytes, DOC_LABELS);
    expect(summary).toMatchObject({ status: "done", total: 3, created: 2, rejected: 1 });
    const docs = await sql<{ name: string; status: string; mas: string | null; lines: string[] }[]>`
      select d.name, d.status, m.name as mas,
             array(select l.description || ':' || l.qty::int || ':' || coalesce(lm.name, '') from ti_fixture.doc_lines l
                   left join ti_fixture.masters lm on lm.id = l.mas_id where l.doc_id = d.id order by l.seq) as lines
      from ti_fixture.docs d left join ti_fixture.masters m on m.id = d.mas_id where d.company_id = ${companyId} order by d.name`;
    expect(docs).toEqual([
      { name: "Pedido A", status: "draft", mas: "Abierto", lines: ["Uno:1:Otro", "Dos:2:"] },
      { name: "Pedido C", status: "draft", mas: null, lines: ["Tres:3:"] },
    ]);
    // Nothing of document B was kept, not even its valid line.
    expect((await sql`select count(*)::int as n from ti_fixture.doc_lines where description in ('Mala', 'Buena')`)[0]!.n).toBe(0);
    // m1: each row named with its sheet; the refused document's lines follow it with their own cells.
    expect(errors).toEqual([
      "fila;error;ref;Nombre;Maestro;ref;Descripción;Cantidad;Maestro de la línea",
      "Datos 3;Líneas, fila 3: Cantidad: debe ser mayor que 0;B;Pedido B;;;;;",
      "Líneas 3;;;;;B;Mala;0;",
      "Líneas 5;;;;;B;Buena;1;",
    ]);
  });

  it("a narrowed user's import never matches a maestro hidden from them: its duplicate is refused generically, a visible one by the module (Review Focus 2)", async () => {
    const { id: reserved } = (await runProcess({ sql, registry }, admin, "ti.mas.create", { name: "Cliente reservado" })) as { id: string };
    await sql`insert into kernel.record_access (company_id, entity, record_id, grantee_user_id, can_read, can_use, can_modify, can_delete)
              values (${companyId}, 'ti.mas', ${reserved}, ${granted.claims.sub}, true, true, true, true)`;
    const file = csv("Nombre", "cliente reservado", "Abierto", "Nuevo del restringido");

    const preview = await previewImport({ sql, registry }, restricted, { entity: "ti.mas", fileName: "maestros.csv", bytes: file }, MAS_LABELS);
    expect(preview.rows.map((r) => r.errors)).toEqual([["Ya existe un registro con ese valor"], ["Ya existe un maestro llamado Abierto"], []]);

    const { summary, errors } = await importAs(restricted, "ti.mas", "maestros.csv", file, MAS_LABELS);
    expect(summary).toMatchObject({ status: "done", created: 1, rejected: 2 });
    expect(errors).toEqual(["fila;error;Nombre", "2;Ya existe un registro con ese valor;cliente reservado", "3;Ya existe un maestro llamado Abierto;Abierto"]);
    // The granted user sees it, so the module's own message is theirs.
    const theirs = await previewImport({ sql, registry }, granted, { entity: "ti.mas", fileName: "maestros.csv", bytes: csv("Nombre", "cliente reservado") }, MAS_LABELS);
    expect(theirs.rows[0]!.errors).toEqual(["Ya existe un maestro llamado cliente reservado"]);
    expect((await masters()).map((m) => m.name)).toContain("Nuevo del restringido");
  });

  it("a duplicate is judged by the unique key that actually refused it, not only the import key (m4)", async () => {
    const make = async (name: string, code: string) => ((await runProcess({ sql, registry }, admin, "ti.mas.create", { name, code })) as { id: string }).id;
    await make("Con código visible", "V-1");
    const hidden = await make("Con código oculto", "H-1");
    await sql`insert into kernel.record_access (company_id, entity, record_id, grantee_user_id, can_read) values (${companyId}, 'ti.mas', ${hidden}, ${granted.claims.sub}, true)`;
    const preview = await previewImport({ sql, registry }, restricted, { entity: "ti.mas", fileName: "maestros.csv", bytes: csv("Nombre;Código", "Nuevo uno;V-1", "Nuevo dos;H-1") }, MAS_LABELS);
    expect(preview.rows.map((r) => r.errors)).toEqual([["Ya existe un maestro con el código V-1"], ["Ya existe un registro con ese valor"]]);
  });

  it("an export prints the state's label (Grabado) and leaves out the records hidden from the caller (Review Focus 2)", async () => {
    const spec = { entity: "ti.mas", format: "csv" as const, state: { filters: [], sort: [{ field: "name", dir: "asc" as const }], page: 1, pageSize: 25, columns: ["name", "status"] }, labels: { name: "Nombre", status: "Estado" } };
    const read = async (caller: Caller) => {
      const file = await openExport(sql, registry, caller.claims, spec);
      return new TextDecoder().decode(new Uint8Array(await new Response(file.body as ReadableStream).arrayBuffer())).replace(/^\uFEFF/, "").trimEnd().split("\r\n");
    };
    const mine = await read(restricted);
    expect(mine[0]).toBe('"Nombre";"Estado"');
    expect(mine).toContain('"Abierto";"Grabado"');
    expect(mine).toContain('"Con aprobación";"Pendiente de Aprobación"');
    expect(mine.some((line) => line.includes("reservado"))).toBe(false);
    expect((await read(granted)).some((line) => line.includes("Cliente reservado"))).toBe(true);
    expect((await read(admin)).some((line) => line.includes("Cliente reservado"))).toBe(true);
  });
});
