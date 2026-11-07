import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import type { JwtClaims, Tx } from "../../db/client";
import { seedTenant, testDb } from "../../db/test-db";
import { syncModuleManifest } from "../../entitlements/resolver";
import { defineModule } from "../../module/define";
import { kernelModule } from "../../module/kernel-module";
import { loadModules } from "../../module/loader";
import type { Caller } from "../../process/context";
import { defineProcess } from "../../process/define";
import { runProcess } from "../../process/run";
import { defineEntity, Registry } from "../../registry";
import type { ResolvedEntityDef } from "../../registry/entities";
import { consultProcessesOf } from "../../query/access";
import { linksSyncInput, linksVoidInput, type TrailResult } from "..";

// The document link table and trail (design §22.27, plan 2B Task 31, migration 0124_kernel_document_links): a registered create or update
// process links the document it owns to the documents it comes from through ctx.links.sync (the set of one kind into one document, so
// the same call twice changes nothing and a Borrador's edit or delete resyncs it), and marks every link of a document it voids through
// ctx.links.markVoided (kept, never deleted). kernel.document_link.trail walks the links up and down from a record the caller sees, to a
// depth and a size cap, cycle-safe; a document the caller may not see is walked through but never named, only counted (`hidden`).

const SCHEMA = "lprobe_fixture";
const OTHER = "lother_fixture";
const KINDS = ["quote", "order", "delivery", "invoice", "receipt"] as const;
type Kind = (typeof KINDS)[number];
const TABLE: Record<Kind, string> = { quote: "quotes", order: "orders", delivery: "deliveries", invoice: "invoices", receipt: "receipts" };
const TRAIL = "kernel.document_link.trail";
const STATUSES = ["draft", "saved", "pending", "rejected", "approved", "posted", "voided"] as const;

const docEntity = (module: string, schema: string, name: string, table: string) =>
  defineEntity({
    entityType: "documento",
    id: `${module}.${name}`,
    module,
    schema,
    table,
    label: `entity.${module}.${name}`,
    displayField: "number",
    defaultSort: { field: "number", dir: "asc" },
    fields: [{ name: "number", type: "text", label: `field.${module}.${name}.number` }],
  });

const end = z.object({ entity: z.string(), id: z.uuid() });
const createDoc = defineProcess({
  id: "lprobe.doc.create",
  module: "lprobe",
  kind: "create",
  recordAccess: "none",
  description: "Crea un documento de prueba y sus vínculos",
  input: z.object({ kind: z.enum(KINDS), number: z.string(), status: z.enum(STATUSES).default("saved"), link: z.object({ kind: z.string(), from: z.array(end) }).optional() }),
  output: z.object({ id: z.string() }),
  handler: async (ctx, input) => {
    const [row] = await ctx.tx.unsafe<{ id: string }[]>(`insert into ${SCHEMA}.${TABLE[input.kind]} (company_id, number, status) values ($1, $2, $3) returning id`, [ctx.companyId, input.number, input.status]);
    if (input.link) await ctx.links!.sync({ to: { entity: `lprobe.${input.kind}`, id: row!.id }, kind: input.link.kind, from: input.link.from });
    return { id: row!.id };
  },
});
const syncLinks = defineProcess({
  id: "lprobe.link.sync",
  module: "lprobe",
  kind: "update",
  recordAccess: "none",
  description: "Sincroniza los vínculos de un documento de prueba",
  input: linksSyncInput,
  output: z.object({ inserted: z.number(), removed: z.number() }),
  handler: async (ctx, input) => ctx.links!.sync(input),
});
const voidLinks = defineProcess({
  id: "lprobe.link.void",
  module: "lprobe",
  kind: "update",
  recordAccess: "none",
  description: "Marca anulados los vínculos de un documento de prueba",
  input: linksVoidInput,
  output: z.object({ marked: z.number() }),
  handler: async (ctx, input) => ctx.links!.markVoided(input),
});
const crossLinks = defineProcess({
  id: "lprobe.link.cross",
  module: "lprobe",
  kind: "update",
  recordAccess: "none",
  description: "Intenta vincular un documento de otro módulo",
  input: z.object({ to: z.uuid(), from: z.uuid() }),
  output: z.object({ inserted: z.number(), removed: z.number() }),
  handler: async (ctx, input) => ctx.links!.sync({ to: { entity: "lother.note", id: input.to }, kind: "quote_to_note", from: [{ entity: "lprobe.quote", id: input.from }] }),
});
const peekLinks = defineProcess({
  id: "lprobe.link.peek",
  module: "lprobe",
  kind: "consult",
  description: "Consulta que intenta vincular",
  input: linksSyncInput,
  output: z.object({ inserted: z.number(), removed: z.number() }),
  handler: async (ctx, input) => ctx.links!.sync(input),
});
const removeLinks = defineProcess({
  id: "lprobe.link.remove",
  module: "lprobe",
  kind: "delete",
  recordAccess: "none",
  description: "Eliminación que intenta vincular",
  input: linksSyncInput,
  output: z.object({ inserted: z.number(), removed: z.number() }),
  handler: async (ctx, input) => ctx.links!.sync(input),
});
const removeVoid = defineProcess({
  id: "lprobe.link.remove_void",
  module: "lprobe",
  kind: "delete",
  recordAccess: "none",
  description: "Eliminación que intenta marcar anulados vínculos",
  input: linksVoidInput,
  output: z.object({ marked: z.number() }),
  handler: async (ctx, input) => ctx.links!.markVoided(input),
});
const consults = KINDS.map((kind) =>
  defineProcess({ id: `lprobe.${kind}.consult`, module: "lprobe", kind: "consult", description: `Consulta ${kind} de prueba`, input: z.object({}), output: z.object({}), handler: async () => ({}) }),
);
const lprobe = defineModule({
  id: "lprobe",
  version: "0.0.1",
  dependsOn: [],
  entities: KINDS.map((kind) => docEntity("lprobe", SCHEMA, kind, TABLE[kind])),
  processes: [createDoc, syncLinks, voidLinks, crossLinks, peekLinks, removeLinks, removeVoid, ...consults],
  features: [],
  events: { emits: [], consumes: {} },
  navigation: [],
});
const createNote = defineProcess({
  id: "lother.note.create",
  module: "lother",
  kind: "create",
  recordAccess: "none",
  description: "Crea una nota de prueba de otro módulo",
  input: z.object({ number: z.string() }),
  output: z.object({ id: z.string() }),
  handler: async (ctx, input) => {
    const [row] = await ctx.tx.unsafe<{ id: string }[]>(`insert into ${OTHER}.notes (company_id, number, status) values ($1, $2, 'saved') returning id`, [ctx.companyId, input.number]);
    return { id: row!.id };
  },
});
const consultNote = defineProcess({ id: "lother.note.consult", module: "lother", kind: "consult", description: "Consulta notas de prueba", input: z.object({}), output: z.object({}), handler: async () => ({}) });
const lother = defineModule({
  id: "lother",
  version: "0.0.1",
  dependsOn: [],
  entities: [docEntity("lother", OTHER, "note", "notes")],
  processes: [createNote, consultNote],
  features: [],
  events: { emits: [], consumes: {} },
  navigation: [],
});

const tableSql = (schema: string, table: string, entity: string) => `
  create table ${schema}.${table} (
    id uuid primary key default kernel.uuid_v7(), seq bigint not null, company_id uuid not null references kernel.companies (id), number text,
    extra jsonb not null default '{}'::jsonb, extra_free jsonb not null default '[]'::jsonb,
    created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
    created_by uuid default kernel.current_user_id(), updated_by uuid);
  select kernel.typed_columns('${schema}', '${table}', 'documento', '${entity}');
  create trigger assign_seq before insert on ${schema}.${table} for each row execute function core.assign_seq('${entity}');
  select kernel.enable_company_rls('${schema}', '${table}');
  grant select, insert, update, delete on ${schema}.${table} to authenticated;
  grant all on ${schema}.${table} to service_role;
  create view ${schema}.v_${table} with (security_invoker = true) as select * from ${schema}.${table};
  grant select on ${schema}.v_${table} to authenticated, service_role;`;

interface LinkRow {
  id: string;
  seq: string;
  company_id: string;
  from_entity: string;
  from_id: string;
  to_entity: string;
  to_id: string;
  kind: string;
  origin: string;
  chain_id: string | null;
  voided_at: Date | null;
  voided_chain_id: string | null;
  voided_ends: string[];
  void_reason: string | null;
}

describe("document links (0124)", () => {
  let sql: ReturnType<typeof testDb>;
  let seed: Awaited<ReturnType<typeof seedTenant>>;
  let registry: Registry;
  let companyA: string;
  let companyB: string;
  let admin: Caller;
  let adminInB: Caller;
  /** Every probe consult but the invoice's. */
  let noInvoices: Caller;
  /** Every consult; a record rule (RLS) hides one invoice from them. */
  let ruled: Caller;
  /** Every consult; the invoice number is a hidden field for them. */
  let fieldHidden: Caller;
  let ruledRole: string;
  let fieldHiddenRole: string;
  const run = <T = unknown>(caller: Caller, id: string, input: unknown = {}, chainId?: string) =>
    runProcess({ sql, registry }, chainId ? { ...caller, chainId } : caller, id, input) as Promise<T>;
  const create = async (kind: Kind, link?: { kind: string; from: { entity: string; id: string }[] }, status: (typeof STATUSES)[number] = "saved", caller: Caller = admin) =>
    (await run<{ id: string }>(caller, createDoc.id, { kind, number: `${kind}-${randomUUID().slice(0, 6)}`, status, ...(link ? { link } : {}) })).id;
  const ref = (kind: Kind, id: string) => ({ entity: `lprobe.${kind}`, id });
  const trail = (caller: Caller, input: Record<string, unknown>) => run<TrailResult>(caller, "kernel.document_link.trail", input);
  const linksOf = (id: string) =>
    sql<LinkRow[]>`select id, seq::text, company_id, from_entity, from_id, to_entity, to_id, kind, origin, chain_id, voided_at, voided_chain_id, void_reason, voided_ends
                   from kernel.document_links where from_id = ${id} or to_id = ${id} order by seq`;
  const maxSeq = async (company: string) => (await sql<{ max: string | null }[]>`select max(seq)::text as max from kernel.document_links where company_id = ${company}`)[0]!.max;
  const rollback = new Error("rollback");
  async function asUser<T>(caller: Caller, processId: string | null, fn: (tx: Tx) => Promise<T>): Promise<T> {
    let out: T | undefined;
    await sql.begin(async (tx) => {
      await tx`select set_config('request.jwt.claims', ${JSON.stringify({ role: "authenticated", ...caller.claims })}, true), set_config('role', 'authenticated', true)`;
      if (processId) await tx`select set_config('erp.audit_process_id', ${processId}, true), set_config('erp.audit_chain_id', ${randomUUID()}, true)`;
      out = await fn(tx as unknown as Tx);
      throw rollback;
    }).catch((e: unknown) => {
      if (e !== rollback) throw e;
    });
    return out as T;
  }

  beforeAll(async () => {
    sql = testDb();
    await sql.unsafe(`drop schema if exists ${SCHEMA} cascade; drop schema if exists ${OTHER} cascade;
      create schema ${SCHEMA}; create schema ${OTHER};
      grant usage on schema ${SCHEMA} to authenticated, service_role; grant usage on schema ${OTHER} to authenticated, service_role;
      ${KINDS.map((kind) => tableSql(SCHEMA, TABLE[kind], `lprobe.${kind}`)).join("\n")}
      ${tableSql(OTHER, "notes", "lother.note")}`);
    seed = await seedTenant(sql, {
      companies: 2,
      entitlements: ["module:lprobe", "module:lother"],
      users: [
        { name: "noInvoices", companies: [0], role: "member" },
        { name: "ruled", companies: [0], role: "member" },
        { name: "fieldHidden", companies: [0], role: "member" },
      ],
    });
    companyA = seed.companies[0]!.id;
    companyB = seed.companies[1]!.id;
    registry = new Registry();
    loadModules(registry, [kernelModule, lprobe, lother]);
    await syncModuleManifest(sql, kernelModule);
    await syncModuleManifest(sql, lprobe);
    await syncModuleManifest(sql, lother);

    const role = async (name: string) => (await sql<{ id: string }[]>`insert into kernel.roles(company_id, name, is_system) values (${companyA}, ${name}, false) returning id`)[0]!.id;
    const grant = (company: string, roleId: string, processId: string) =>
      sql`insert into kernel.process_permissions(company_id, role_id, process_id) values (${company}, ${roleId}, ${processId}) on conflict do nothing`;
    const callerWith = async (user: string, roleId: string, origin: Caller["origin"] = "ui"): Promise<Caller> => {
      await seed.holdRoles(user, companyA, [roleId]);
      return { claims: { ...seed.claimsFor(user, companyA), role_ids: [roleId] } as JwtClaims, origin };
    };
    const roleNoInvoices = await role("Ventas sin facturas");
    ruledRole = await role("Ventas con regla");
    const roleFieldHidden = await role("Ventas sin número");
    fieldHiddenRole = roleFieldHidden;
    // The trail is a baseline grant (kernel.seed_role_defaults, `kernel.document_link.%`); the probe consults are given here.
    for (const roleId of [roleNoInvoices, ruledRole, roleFieldHidden]) await sql`select kernel.seed_role_defaults(${companyA}::uuid, ${roleId}::uuid)`;
    // The baseline also gives every consult of an entitled module: this role loses the invoice's.
    await sql`delete from kernel.process_permissions where company_id = ${companyA} and role_id = ${roleNoInvoices} and process_id = 'lprobe.invoice.consult'`;
    expect(await sql`select 1 from kernel.process_permissions where role_id = ${roleNoInvoices} and process_id = 'kernel.document_link.trail'`).toHaveLength(1);
    for (const c of consults) {
      if (c.id !== "lprobe.invoice.consult") await grant(companyA, roleNoInvoices, c.id);
      await grant(companyA, ruledRole, c.id);
      await grant(companyA, roleFieldHidden, c.id);
    }
    await sql`insert into kernel.field_permissions(company_id, role_id, entity, field, mode) values (${companyA}, ${roleFieldHidden}, 'lprobe.invoice', 'number', 'hidden')`;
    noInvoices = await callerWith(seed.users.noInvoices!, roleNoInvoices);
    ruled = await callerWith(seed.users.ruled!, ruledRole);
    fieldHidden = await callerWith(seed.users.fieldHidden!, roleFieldHidden);
    admin = { claims: seed.claimsFor(seed.users.both, companyA), origin: "ui" };
    adminInB = { claims: seed.claimsFor(seed.users.both, companyB), origin: "ui" };
  });
  afterAll(async () => {
    await sql`delete from kernel.document_links where company_id = any(${[companyA, companyB]}::uuid[])`;
    await sql`delete from kernel.record_access where company_id = any(${[companyA, companyB]}::uuid[])`;
    await sql`delete from kernel.field_permissions where company_id = any(${[companyA, companyB]}::uuid[])`;
    await sql`delete from kernel.process_permissions where company_id = any(${[companyA, companyB]}::uuid[])`;
    await sql.unsafe(`drop schema if exists ${SCHEMA} cascade; drop schema if exists ${OTHER} cascade`);
    await seed.cleanup();
    for (const module of ["lprobe", "lother"]) {
      await sql`delete from kernel.registered_processes where module_id = ${module}`;
      await sql`delete from kernel.entity_tables where module_id = ${module}`;
      await sql`delete from kernel.module_features where module_id = ${module}`;
    }
    await sql.end();
  });

  describe("sync", () => {
    it("inserts one row per from with the run's chain id, the company and a gap-free seq", async () => {
      const q1 = await create("quote");
      const q2 = await create("quote");
      const order = await create("order");
      const before = Number((await maxSeq(companyA)) ?? 0);
      const chain = randomUUID();
      expect(await run(admin, syncLinks.id, { to: ref("order", order), kind: "quote_to_order", from: [ref("quote", q1), ref("quote", q2)] }, chain)).toEqual({ inserted: 2, removed: 0 });
      const rows = await linksOf(order);
      expect(rows.map((r) => [r.from_id, r.to_entity, r.to_id, r.kind, r.origin, r.chain_id, r.company_id])).toEqual([
        [q1, "lprobe.order", order, "quote_to_order", "process", chain, companyA],
        [q2, "lprobe.order", order, "quote_to_order", "process", chain, companyA],
      ]);
      expect(rows.map((r) => Number(r.seq))).toEqual([before + 1, before + 2]);
    });

    it("the same sync twice leaves one row per link and burns no seq", async () => {
      const quote = await create("quote");
      const order = await create("order", { kind: "quote_to_order", from: [ref("quote", quote)] });
      const top = await maxSeq(companyA);
      expect(await run(admin, syncLinks.id, { to: ref("order", order), kind: "quote_to_order", from: [ref("quote", quote), ref("quote", quote)] })).toEqual({ inserted: 0, removed: 0 });
      expect(await linksOf(order)).toHaveLength(1);
      expect(await maxSeq(companyA)).toBe(top);
    });

    it("links many to many, read back in both directions", async () => {
      const ids = (r: TrailResult, direction: "up" | "down") => r.nodes.filter((n) => n.direction === direction).map((n) => n.id).sort();
      // One quote → two orders; one order from two quotes.
      const q1 = await create("quote");
      const q2 = await create("quote");
      const o1 = await create("order", { kind: "quote_to_order", from: [ref("quote", q1)] });
      const o2 = await create("order", { kind: "quote_to_order", from: [ref("quote", q1), ref("quote", q2)] });
      expect(ids(await trail(admin, ref("quote", q1)), "down")).toEqual([o1, o2].sort());
      expect(ids(await trail(admin, { ...ref("order", o2), direction: "up" }), "up")).toEqual([q1, q2].sort());
      // Two orders → one delivery (the delivery covers both orders' links).
      const d1 = await create("delivery", { kind: "order_to_delivery", from: [ref("order", o1), ref("order", o2)] });
      const d2 = await create("delivery", { kind: "order_to_delivery", from: [ref("order", o1)] });
      expect(ids(await trail(admin, { ...ref("delivery", d1), depth: 1 }), "up")).toEqual([o1, o2].sort());
      expect(ids(await trail(admin, { ...ref("order", o1), depth: 1 }), "down")).toEqual([d1, d2].sort());
      // One invoice from two deliveries; one receipt over two invoices.
      const i1 = await create("invoice", { kind: "delivery_to_invoice", from: [ref("delivery", d1), ref("delivery", d2)] });
      const i2 = await create("invoice", { kind: "delivery_to_invoice", from: [ref("delivery", d2)] });
      const r1 = await create("receipt", { kind: "invoice_to_receipt", from: [ref("invoice", i1), ref("invoice", i2)] });
      expect(ids(await trail(admin, { ...ref("invoice", i1), depth: 1 }), "up")).toEqual([d1, d2].sort());
      expect(ids(await trail(admin, { ...ref("receipt", r1), depth: 1 }), "up")).toEqual([i1, i2].sort());
      expect(ids(await trail(admin, { ...ref("delivery", d2), depth: 1 }), "down")).toEqual([i1, i2].sort());
      // From the first quote down to the receipt, each document once at its nearest depth.
      const down = (await trail(admin, { ...ref("quote", q1), direction: "down" })).nodes;
      expect(down.map((n) => [n.entity, n.depth])).toEqual(expect.arrayContaining([["lprobe.order", 1], ["lprobe.delivery", 2], ["lprobe.invoice", 3], ["lprobe.receipt", 4]]));
      expect(new Set(down.map((n) => n.id)).size).toBe(down.length);
      expect(down.filter((n) => n.entity === "lprobe.receipt").map((n) => n.id)).toEqual([r1]);
    });

    it("from: [] removes a Borrador's links, a non-Borrador's never; a partial sync removes the extra", async () => {
      const q1 = await create("quote");
      const q2 = await create("quote");
      const draft = await create("order", { kind: "quote_to_order", from: [ref("quote", q1), ref("quote", q2)] }, "draft");
      expect(await run(admin, syncLinks.id, { to: ref("order", draft), kind: "quote_to_order", from: [ref("quote", q2)] })).toEqual({ inserted: 0, removed: 1 });
      expect((await linksOf(draft)).map((r) => r.from_id)).toEqual([q2]);
      expect(await run(admin, syncLinks.id, { to: ref("order", draft), kind: "quote_to_order", from: [] })).toEqual({ inserted: 0, removed: 1 });
      expect(await linksOf(draft)).toEqual([]);
      // The removal is in the row audit (rule 16).
      expect(await sql`select 1 from kernel.audit_log where entity = 'kernel.document_links' and action = 'delete' and process_id = ${syncLinks.id} and company_id = ${companyA}`).not.toHaveLength(0);

      const saved = await create("order", { kind: "quote_to_order", from: [ref("quote", q1)] }, "saved");
      expect(await run(admin, syncLinks.id, { to: ref("order", saved), kind: "quote_to_order", from: [] })).toEqual({ inserted: 0, removed: 0 });
      expect(await linksOf(saved)).toHaveLength(1);
    });

    it("never removes a marked row, even of a Borrador", async () => {
      const quote = await create("quote");
      const draft = await create("order", { kind: "quote_to_order", from: [ref("quote", quote)] }, "draft");
      await run(admin, voidLinks.id, ref("quote", quote));
      expect(await run(admin, syncLinks.id, { to: ref("order", draft), kind: "quote_to_order", from: [] })).toEqual({ inserted: 0, removed: 0 });
      expect(await linksOf(draft)).toHaveLength(1);
    });

    it("may link from another module's document into one the process's module owns", async () => {
      const note = (await run<{ id: string }>(admin, createNote.id, { number: "N-1" })).id;
      const invoice = await create("invoice");
      expect(await run(admin, syncLinks.id, { to: ref("invoice", invoice), kind: "note_to_invoice", from: [{ entity: "lother.note", id: note }] })).toEqual({ inserted: 1, removed: 0 });
    });

    it("works in a dry run and leaves no link and no seq", async () => {
      const quote = await create("quote");
      const order = await create("order");
      const top = Number((await maxSeq(companyA)) ?? 0);
      const out = await runProcess({ sql, registry }, admin, syncLinks.id, { to: ref("order", order), kind: "quote_to_order", from: [ref("quote", quote)] }, { dryRun: true });
      expect(out).toEqual({ inserted: 1, removed: 0 });
      expect(await linksOf(order)).toEqual([]);
      await run(admin, syncLinks.id, { to: ref("order", order), kind: "quote_to_order", from: [ref("quote", quote)] });
      expect((await linksOf(order)).map((r) => Number(r.seq))).toEqual([top + 1]);
    });
  });

  describe("baseline grant", () => {
    it("every role gets the trail: a new role from seed_role_defaults, an existing one (no recommendation consult either) from 0124's own grant statement", async () => {
      const trailRows = (roleId: string) => sql`select 1 from kernel.process_permissions where company_id = ${companyA} and role_id = ${roleId} and process_id = 'kernel.document_link.trail'`;
      const mk = async (name: string) => (await sql<{ id: string }[]>`insert into kernel.roles(company_id, name, is_system) values (${companyA}, ${name}, false) returning id`)[0]!.id;
      const fresh = await mk("Baseline nuevo");
      await sql`select kernel.seed_role_defaults(${companyA}::uuid, ${fresh}::uuid)`;
      expect(await trailRows(fresh)).toHaveLength(1);
      const existing = await mk("Baseline previo");
      expect(await sql`select 1 from kernel.process_permissions where role_id = ${existing}`).toHaveLength(0);
      const migration = readFileSync(join(__dirname, "../../../../../supabase/migrations/0124_kernel_document_links.sql"), "utf8");
      const grant = migration.slice(migration.indexOf("insert into kernel.process_permissions (company_id, role_id, process_id)\nselect r.company_id"));
      expect(grant).toContain("'kernel.document_link.trail'");
      await sql.unsafe(grant.replace("from kernel.roles r\nwhere ", "from kernel.roles r\nwhere r.company_id = $1 and "), [companyA]);
      expect(await trailRows(existing)).toHaveLength(1);
      await sql`delete from kernel.process_permissions where role_id = any(${[fresh, existing]}::uuid[])`;
      await sql`delete from kernel.roles where id = any(${[fresh, existing]}::uuid[])`;
    });
  });

  describe("markVoided", () => {
    it("keeps every link of the document, upstream and downstream, marked with the chain and the reason; a second call marks nothing", async () => {
      const quote = await create("quote");
      const order = await create("order", { kind: "quote_to_order", from: [ref("quote", quote)] });
      const delivery = await create("delivery", { kind: "order_to_delivery", from: [ref("order", order)] });
      const chain = randomUUID();
      expect(await run(admin, voidLinks.id, { ...ref("order", order), reason: "Pedido cancelado" }, chain)).toEqual({ marked: 2 });
      const rows = await linksOf(order);
      expect(rows).toHaveLength(2);
      for (const row of rows) expect(row).toMatchObject({ voided_chain_id: chain, void_reason: "Pedido cancelado", voided_at: expect.any(Date) });
      expect(await run(admin, voidLinks.id, ref("order", order))).toEqual({ marked: 0 });
      for (const row of rows) expect(row.voided_ends).toEqual([`lprobe.order:${order}`]);
      // Still in the trail, marked: the voided document is flagged, its live neighbours are not.
      expect((await trail(admin, ref("order", order))).nodes.map((n) => [n.id, n.voided])).toEqual([[quote, false], [delivery, false]]);
      expect((await trail(admin, ref("quote", quote))).nodes.map((n) => [n.id, n.voided])).toEqual([[order, true], [delivery, false]]);
      expect((await trail(admin, ref("delivery", delivery))).nodes.map((n) => [n.id, n.voided])).toEqual([[order, true], [quote, false]]);
      // The quote is voided later: its link keeps the first mark's chain and reason, gains the quote as a voided end; both ends are flagged.
      const later = randomUUID();
      expect(await run(admin, voidLinks.id, { ...ref("quote", quote), reason: "Cotización anulada" }, later)).toEqual({ marked: 1 });
      const [both] = await linksOf(quote);
      expect(both).toMatchObject({ voided_chain_id: chain, void_reason: "Pedido cancelado" });
      expect([...both!.voided_ends].sort()).toEqual([`lprobe.order:${order}`, `lprobe.quote:${quote}`].sort());
      expect((await trail(admin, ref("order", order))).nodes.map((n) => [n.id, n.voided])).toEqual([[quote, true], [delivery, false]]);
      expect((await trail(admin, ref("quote", quote))).nodes.map((n) => [n.id, n.voided])).toEqual([[order, true], [delivery, false]]);
      expect(await run(admin, voidLinks.id, ref("quote", quote))).toEqual({ marked: 0 });
    });
  });

  describe("refusals", () => {
    let quote: string;
    let order: string;
    beforeAll(async () => {
      quote = await create("quote");
      order = await create("order");
    });
    const input = () => ({ to: ref("order", order), kind: "quote_to_order", from: [ref("quote", quote)] });
    const rawSync = (tx: Tx, processId: string, to = ref("order", order), from = [ref("quote", quote)], kind = "quote_to_order") =>
      tx`select * from kernel.document_link_sync(${processId}, ${to.entity}, ${to.id}::uuid, ${kind}, ${tx.json(from as never)}::jsonb)`;

    it("from a consult or a delete process (forbidden)", async () => {
      await expect(run(admin, peekLinks.id, input())).rejects.toMatchObject({ code: "forbidden" });
      await expect(run(admin, removeLinks.id, input())).rejects.toMatchObject({ code: "forbidden" });
    });

    it("a delete process may only unlink: sync with from [] works on a Borrador, a non-empty from and markVoided are refused (forbidden; SQL 42501)", async () => {
      const q = await create("quote");
      const draft = await create("order", { kind: "quote_to_order", from: [ref("quote", q)] }, "draft");
      const saved = await create("order", { kind: "quote_to_order", from: [ref("quote", q)] }, "saved");
      await expect(run(admin, removeLinks.id, { to: ref("order", draft), kind: "quote_to_order", from: [ref("quote", q)] })).rejects.toMatchObject({ code: "forbidden" });
      await expect(run(admin, removeVoid.id, ref("order", draft))).rejects.toMatchObject({ code: "forbidden" });
      await expect(asUser(admin, removeLinks.id, (tx) => rawSync(tx, removeLinks.id, ref("order", draft)))).rejects.toMatchObject({ code: "42501" });
      await expect(asUser(admin, removeVoid.id, (tx) => tx`select kernel.document_link_mark_voided(${removeVoid.id}, 'lprobe.order', ${draft}::uuid, null)`)).rejects.toMatchObject({ code: "42501" });
      expect(await linksOf(draft)).toHaveLength(1);
      // Unlink a Borrador: its links go, in the delete process's own audit entry; a non-Borrador keeps its links.
      expect(await run(admin, removeLinks.id, { to: ref("order", draft), kind: "quote_to_order", from: [] })).toEqual({ inserted: 0, removed: 1 });
      expect(await linksOf(draft)).toEqual([]);
      expect(await sql`select 1 from kernel.audit_log where entity = 'kernel.document_links' and action = 'delete' and process_id = ${removeLinks.id} and company_id = ${companyA}`).not.toHaveLength(0);
      expect(await run(admin, removeLinks.id, { to: ref("order", saved), kind: "quote_to_order", from: [] })).toEqual({ inserted: 0, removed: 0 });
      expect(await linksOf(saved)).toHaveLength(1);
      // A delete process of another module's document is still refused (ownership).
      const note = (await run<{ id: string }>(admin, createNote.id, { number: "N-3" })).id;
      await expect(run(admin, removeLinks.id, { to: { entity: "lother.note", id: note }, kind: "quote_to_note", from: [] })).rejects.toMatchObject({ code: "forbidden" });
    });

    it("into a document the process's module does not own (forbidden; in SQL too)", async () => {
      const note = (await run<{ id: string }>(admin, createNote.id, { number: "N-2" })).id;
      await expect(run(admin, crossLinks.id, { to: note, from: quote })).rejects.toMatchObject({ code: "forbidden" });
      await expect(asUser(admin, syncLinks.id, (tx) => rawSync(tx, syncLinks.id, { entity: "lother.note", id: note }))).rejects.toMatchObject({ code: "42501" });
      await expect(asUser(admin, voidLinks.id, (tx) => tx`select kernel.document_link_mark_voided(${voidLinks.id}, 'lother.note', ${note}::uuid, null)`)).rejects.toMatchObject({ code: "42501" });
    });

    it("outside a run, under another process's name, or naming a consult (42501)", async () => {
      await expect(asUser(admin, null, (tx) => rawSync(tx, syncLinks.id))).rejects.toMatchObject({ code: "42501" });
      await expect(asUser(admin, voidLinks.id, (tx) => rawSync(tx, syncLinks.id))).rejects.toMatchObject({ code: "42501" });
      await expect(asUser(admin, peekLinks.id, (tx) => rawSync(tx, peekLinks.id))).rejects.toMatchObject({ code: "42501" });
      await expect(asUser(admin, null, (tx) => tx`select kernel.document_link_mark_voided(${voidLinks.id}, 'lprobe.order', ${order}::uuid, null)`)).rejects.toMatchObject({ code: "42501" });
      await expect(asUser(admin, syncLinks.id, (tx) => tx`select kernel.document_link_writer(${syncLinks.id}, 'lprobe.order')`)).rejects.toMatchObject({ code: "42501" });
      expect(await linksOf(order)).toEqual([]);
    });

    it("a missing to or from row, a from of another company, an invalid kind (invalid_input)", async () => {
      await expect(run(admin, syncLinks.id, { ...input(), to: ref("order", randomUUID()) })).rejects.toMatchObject({ code: "invalid_input" });
      await expect(run(admin, syncLinks.id, { ...input(), from: [ref("quote", randomUUID())] })).rejects.toMatchObject({ code: "invalid_input" });
      const quoteInB = await create("quote", undefined, "saved", adminInB);
      await expect(run(admin, syncLinks.id, { ...input(), from: [ref("quote", quoteInB)] })).rejects.toMatchObject({ code: "invalid_input" });
      await expect(run(admin, syncLinks.id, { ...input(), kind: "quote-order" })).rejects.toMatchObject({ code: "invalid_input" });
      await expect(asUser(admin, syncLinks.id, (tx) => rawSync(tx, syncLinks.id, ref("order", order), [ref("quote", quote)], "Quote"))).rejects.toMatchObject({ code: "22023" });
      expect(await linksOf(order)).toEqual([]);
    });

    it("authenticated cannot insert, update or delete the table", async () => {
      await run(admin, syncLinks.id, input());
      await expect(asUser(admin, syncLinks.id, (tx) => tx`insert into kernel.document_links (company_id, from_entity, from_id, to_entity, to_id, kind, chain_id) values (${companyA}, 'lprobe.quote', ${quote}, 'lprobe.order', ${randomUUID()}, 'quote_to_order', ${randomUUID()})`)).rejects.toMatchObject({ code: "42501" });
      await expect(asUser(admin, syncLinks.id, (tx) => tx`update kernel.document_links set kind = 'x_to_y' where to_id = ${order}`)).rejects.toMatchObject({ code: "42501" });
      await expect(asUser(admin, syncLinks.id, (tx) => tx`delete from kernel.document_links where to_id = ${order}`)).rejects.toMatchObject({ code: "42501" });
      // No raw row either, not even inside the trail's run: the links are read through the step function only.
      await expect(asUser(admin, null, (tx) => tx`select id from kernel.document_links where to_id = ${order}`)).rejects.toMatchObject({ code: "42501" });
      await expect(asUser(admin, TRAIL, (tx) => tx`select id from kernel.document_links where to_id = ${order}`)).rejects.toMatchObject({ code: "42501" });
      // The step and the SQL trail answer only inside a run of the trail.
      await expect(asUser(admin, null, (tx) => tx`select * from kernel.document_link_step('up', ${["lprobe.order"]}::text[], ${[order]}::uuid[])`)).rejects.toMatchObject({ code: "42501" });
      await expect(asUser(admin, syncLinks.id, (tx) => tx`select * from kernel.document_trail('lprobe.order', ${order}::uuid)`)).rejects.toMatchObject({ code: "42501" });
      expect(await asUser(admin, TRAIL, (tx) => tx`select * from kernel.document_link_step('up', ${["lprobe.order"]}::text[], ${[order]}::uuid[])`)).toHaveLength(1);
      expect(await linksOf(order)).toHaveLength(1);
    });

    it("company B sees none of company A's links and cannot walk to them", async () => {
      expect(await asUser(adminInB, TRAIL, (tx) => tx`select * from kernel.document_link_step('up', ${["lprobe.order"]}::text[], ${[order]}::uuid[])`)).toEqual([]);
      await expect(trail(adminInB, ref("order", order))).rejects.toMatchObject({ code: "not_found" });
      const sqlTrail = await asUser(adminInB, TRAIL, (tx) => tx`select * from kernel.document_trail('lprobe.order', ${order}::uuid)`);
      expect(sqlTrail).toEqual([]);
      // The same document id in another company is never linked to A's (the existence check is per company).
      await expect(run(adminInB, syncLinks.id, { to: ref("order", order), kind: "quote_to_order", from: [] })).rejects.toMatchObject({ code: "invalid_input" });
    });
  });

  describe("trail", () => {
    /** quote → order → delivery → invoice → receipt. */
    async function sale() {
      const quote = await create("quote");
      const order = await create("order", { kind: "quote_to_order", from: [ref("quote", quote)] });
      const delivery = await create("delivery", { kind: "order_to_delivery", from: [ref("order", order)] });
      const invoice = await create("invoice", { kind: "delivery_to_invoice", from: [ref("delivery", delivery)] });
      const receipt = await create("receipt", { kind: "invoice_to_receipt", from: [ref("invoice", invoice)] });
      return { quote, order, delivery, invoice, receipt };
    }

    it("walks up and down from a middle node, upstream first, at the right depths", async () => {
      const s = await sale();
      const out = await trail(admin, ref("delivery", s.delivery));
      expect(out.nodes.map((n) => [n.direction, n.depth, n.kind, n.entity, n.id, n.voided])).toEqual([
        ["up", 1, "order_to_delivery", "lprobe.order", s.order, false],
        ["up", 2, "quote_to_order", "lprobe.quote", s.quote, false],
        ["down", 1, "delivery_to_invoice", "lprobe.invoice", s.invoice, false],
        ["down", 2, "invoice_to_receipt", "lprobe.receipt", s.receipt, false],
      ]);
      expect(out).toMatchObject({ hidden: 0, truncated: false });
      expect((await trail(admin, { ...ref("delivery", s.delivery), direction: "up" })).nodes.map((n) => n.id)).toEqual([s.order, s.quote]);
      expect((await trail(admin, { ...ref("delivery", s.delivery), direction: "down" })).nodes.map((n) => n.id)).toEqual([s.invoice, s.receipt]);
    });

    it("the default depth 6 cuts a chain of 9; depth over 12 and cap over 500 are refused", async () => {
      const chain = [await create("quote")];
      for (let i = 1; i < 10; i++) chain.push(await create("quote", { kind: "quote_to_quote", from: [ref("quote", chain[i - 1]!)] }));
      const out = await trail(admin, { ...ref("quote", chain[0]!), direction: "down" });
      expect(out.nodes.map((n) => n.depth)).toEqual([1, 2, 3, 4, 5, 6]);
      expect(out.nodes.map((n) => n.id)).toEqual(chain.slice(1, 7));
      expect(out.truncated).toBe(true);
      const all = await trail(admin, { ...ref("quote", chain[0]!), direction: "down", depth: 9 });
      expect(all.nodes).toHaveLength(9);
      expect(all.truncated).toBe(false);
      await expect(trail(admin, { ...ref("quote", chain[0]!), depth: 13 })).rejects.toMatchObject({ code: "invalid_input" });
      await expect(trail(admin, { ...ref("quote", chain[0]!), cap: 501 })).rejects.toMatchObject({ code: "invalid_input" });
      await expect(asUser(admin, null, (tx) => tx`select * from kernel.document_trail('lprobe.quote', ${chain[0]!}::uuid, 'down', 13, 100)`)).rejects.toMatchObject({ code: "22023" });
      await expect(asUser(admin, null, (tx) => tx`select * from kernel.document_trail('lprobe.quote', ${chain[0]!}::uuid, 'down', 6, 501)`)).rejects.toMatchObject({ code: "22023" });
    });

    it("a cap of 3 on a fan-out of 10 returns the first 3 and truncated", async () => {
      const quote = await create("quote");
      const orders: string[] = [];
      for (let i = 0; i < 10; i++) orders.push(await create("order", { kind: "quote_to_order", from: [ref("quote", quote)] }));
      const out = await trail(admin, { ...ref("quote", quote), cap: 3 });
      expect(out.nodes.map((n) => n.id)).toEqual(orders.slice(0, 3));
      expect(out.truncated).toBe(true);
      expect((await trail(admin, { ...ref("quote", quote), cap: 10 })).truncated).toBe(false);
    });

    it("a cycle terminates and returns each node once", async () => {
      const a = await create("quote");
      const b = await create("order", { kind: "quote_to_order", from: [ref("quote", a)] });
      await sql`insert into kernel.document_links (company_id, from_entity, from_id, to_entity, to_id, kind, chain_id)
                values (${companyA}, 'lprobe.order', ${b}, 'lprobe.quote', ${a}, 'order_to_quote', ${randomUUID()})`;
      const out = await trail(admin, { ...ref("quote", a), depth: 12 });
      expect(out.nodes.map((n) => n.id)).toEqual([b]);
      expect(out.truncated).toBe(false);
    });

    describe("masking", () => {
      let s: Awaited<ReturnType<typeof sale>>;
      beforeAll(async () => {
        s = await sale();
      });
      const expectMasked = (out: TrailResult, hiddenId: string) => {
        expect(out.nodes.map((n) => [n.direction, n.depth, n.entity, n.id])).toEqual([
          ["up", 1, "lprobe.order", s.order],
          ["up", 2, "lprobe.quote", s.quote],
          ["down", 2, "lprobe.receipt", s.receipt],
        ]);
        expect(out.hidden).toBe(1);
        expect(JSON.stringify(out)).not.toContain(hiddenId);
        expect(JSON.stringify(out)).not.toContain("lprobe.invoice");
        // The receipt is reached through the hidden invoice: the edge's kind would name it, so it is not given.
        expect(out.nodes.find((n) => n.id === s.receipt)!.kind).toBeNull();
      };

      it("a viewer without the invoice's consult gets it counted, never named; the documents on either side are still returned", async () => {
        const out = await trail(noInvoices, ref("delivery", s.delivery));
        expectMasked(out, s.invoice);
        // The SQL function answers the same to the same viewer.
        const rows = await asUser(noInvoices, TRAIL, (tx) => tx<{ entity: string | null; id: string | null; kind: string | null; visible: boolean }[]>`select * from kernel.document_trail('lprobe.delivery', ${s.delivery}::uuid)`);
        expect(JSON.stringify(rows)).not.toContain(s.invoice);
        expect(JSON.stringify(rows)).not.toContain("lprobe.invoice");
        expect(rows.filter((r) => !r.visible)).toEqual([expect.objectContaining({ entity: null, id: null, kind: null })]);
        // Opening the invoice itself is not found.
        await expect(trail(noInvoices, ref("invoice", s.invoice))).rejects.toMatchObject({ code: "not_found" });
      });

      it("a viewer with the consult whose RLS hides the row (a record rule) gets the same", async () => {
        // Only the field-hidden role may read this invoice: the rule hides it from the ruled role.
        await sql`insert into kernel.record_access (company_id, entity, record_id, grantee_role_id, can_read) values (${companyA}, 'lprobe.invoice', ${s.invoice}, ${fieldHiddenRole}, true)`;
        expectMasked(await trail(ruled, ref("delivery", s.delivery)), s.invoice);
      });

      it("a field-hidden role is unaffected: links carry no field", async () => {
        const out = await trail(fieldHidden, ref("delivery", s.delivery));
        expect(out.nodes.map((n) => n.id)).toEqual([s.order, s.quote, s.invoice, s.receipt]);
        expect(out.hidden).toBe(0);
      });

      it("the assistant's run of the trail answers the same masked result", async () => {
        const out = await trail({ ...noInvoices, origin: "agent" }, ref("delivery", s.delivery));
        expectMasked(out, s.invoice);
      });

      it("a voided hidden invoice does not flag the visible receipt reached through it", async () => {
        await run(admin, voidLinks.id, { ...ref("invoice", s.invoice), reason: "Factura anulada" });
        const out = await trail(noInvoices, ref("delivery", s.delivery));
        expectMasked(out, s.invoice);
        expect(out.nodes.find((n) => n.id === s.receipt)!.voided).toBe(false);
        const rows = await asUser(noInvoices, TRAIL, (tx) => tx<{ id: string | null; voided: boolean | null; visible: boolean }[]>`select * from kernel.document_trail('lprobe.delivery', ${s.delivery}::uuid)`);
        expect(rows.find((r) => r.id === s.receipt)!.voided).toBeNull();
        expect(rows.filter((r) => !r.visible).map((r) => r.voided)).toEqual([null]);
        // The admin, who sees the invoice, sees it flagged (the voided document) and the receipt live.
        const all = await trail(admin, ref("delivery", s.delivery));
        expect(all.nodes.filter((n) => n.direction === "down").map((n) => [n.id, n.voided])).toEqual([[s.invoice, true], [s.receipt, false]]);
      });

      it("prefers a visible edge when a document is reached at one level from a hidden and a visible parent", async () => {
        const delivery = await create("delivery");
        const invoice = await create("invoice", { kind: "delivery_to_invoice", from: [ref("delivery", delivery)] });
        const order = await create("order", { kind: "delivery_to_order", from: [ref("delivery", delivery)] });
        // Level 2: the receipt comes from the hidden invoice (earlier link) and from the visible order (later link).
        const receipt = await create("receipt", { kind: "invoice_to_receipt", from: [ref("invoice", invoice)] });
        await run(admin, syncLinks.id, { to: ref("receipt", receipt), kind: "order_to_receipt", from: [ref("order", order)] });
        const out = await trail(noInvoices, { ...ref("delivery", delivery), direction: "down" });
        expect(out.nodes.find((n) => n.id === receipt)).toMatchObject({ depth: 2, kind: "order_to_receipt" });
        expect(out.hidden).toBe(1);
      });
    });

    it("a document of a module the company has disabled is walked through, counted and never named", async () => {
      const note = (await run<{ id: string }>(admin, createNote.id, { number: "N-9" })).id;
      const invoice = await create("invoice");
      await run(admin, syncLinks.id, { to: ref("invoice", invoice), kind: "note_to_invoice", from: [{ entity: "lother.note", id: note }] });
      expect((await trail(admin, ref("invoice", invoice))).nodes.map((n) => n.id)).toEqual([note]);
      await sql`insert into kernel.company_modules (company_id, module_id, enabled) values (${companyA}, 'lother', false)`;
      try {
        const out = await trail(admin, ref("invoice", invoice));
        expect(out.nodes).toEqual([]);
        expect(out.hidden).toBe(1);
        expect(JSON.stringify(out)).not.toContain(note);
      } finally {
        await sql`delete from kernel.company_modules where company_id = ${companyA} and module_id = 'lother'`;
      }
    });
  });

  describe("the consult processes SQL names", () => {
    it("are the ones consultProcessesOf names, for every maestro and documento of kernel.entity_tables", async () => {
      const entities = await sql<{ entity: string; module_id: string; sql_ids: string[] }[]>`
        select et.entity, et.module_id, kernel.entity_consult_processes(et.entity) as sql_ids from kernel.entity_tables et order by et.entity`;
      const processes = new Map((await sql<{ process_id: string; module_id: string; kind: string }[]>`select process_id, module_id, kind from kernel.registered_processes`).map((p) => [p.process_id, p]));
      // A registry view of the same catalogue: what consultProcessesOf reads is each process's kind and module.
      const catalogue = {
        process(id: string) {
          const p = processes.get(id);
          if (!p) throw new Error(`unknown process ${id}`);
          return { id, kind: p.kind, module: p.module_id };
        },
      } as unknown as Registry;
      expect(entities.length).toBeGreaterThan(5);
      for (const e of entities) {
        const ts = consultProcessesOf(catalogue, { id: e.entity, module: e.module_id } as ResolvedEntityDef).sort();
        expect([...e.sql_ids].sort(), e.entity).toEqual(ts);
      }
    });
  });
});
