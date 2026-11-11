import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
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
import type { TypedHooks } from "../runner";

// Automatic posting (spec 2026-11-02 §5.2, D8, D9; owner 2026-11-02): a documento with Contabiliza posts on Grabar when it needs no
// approval and on Aprobar when it does, in the action's own transaction. When it cannot post, the whole action rolls back: the row
// keeps its previous state and data, no number is consumed, no snapshot and no outbox row exist (Review Focus 1). The fixture module
// `ap` (schema ap_fixture) is created here, never in a migration; its period flag stands in for an accounting period.

const SCHEMA = "ap_fixture";
const field = (entity: string, name: string, type: EntityDef["fields"][number]["type"]) => ({ name, type, label: `field.${entity}.${name}` });
const docFields = (entity: string) => [
  field(entity, "number", "text"), field(entity, "name", "text"), field(entity, "amount", "money"), field(entity, "status", "text"),
  field(entity, "extra", "json"), field(entity, "extra_free", "json"), field(entity, "created_at", "datetime"), field(entity, "updated_at", "datetime"),
];
const documento = (name: string, numbering: "on_save" | "on_post" | "none"): EntityDef => ({
  id: `ap.${name}`,
  module: "ap",
  schema: SCHEMA,
  table: name,
  label: `entity.ap.${name}`,
  entityType: "documento",
  typed: { numbering },
  displayField: "name",
  defaultSort: { field: "name", dir: "asc" },
  fields: docFields(`ap.${name}`),
});
// An invoice numbers at Grabar; an entry (comprobante) numbers at posting (D9); `bare` posts but its module gives it no post hook.
const invEntity = documento("inv", "on_save");
const entEntity = documento("ent", "on_post");
const bareEntity = documento("bare", "none");

const hookCalls: { entity: string; hook: string; mode?: string; status: string }[] = [];

/** Takes the next number of the company's counter: a consumed number shows as a counter that moved. */
async function nextNumber(tx: Parameters<NonNullable<TypedHooks["number"]>>[0]["tx"], companyId: string, prefix: string): Promise<string> {
  const [row] = await tx<{ n: number }[]>`update ap_fixture.counters set n = n + 1 where company_id = ${companyId} returning n`;
  return `${prefix}-${row!.n}`;
}

/** The fixture's posting: writes a posting row first, then refuses when the period is closed, so a refusal must also undo that write. */
const postHook = (entity: string): NonNullable<TypedHooks["post"]> => async (ctx, record) => {
  hookCalls.push({ entity, hook: "post", status: String(record.status) });
  await ctx.tx`insert into ap_fixture.postings (company_id, record_id, number) values (${ctx.companyId}, ${record.id}, ${(record.number as string | null) ?? null})`;
  const [period] = await ctx.tx<{ closed: boolean }[]>`select closed from ap_fixture.periods where company_id = ${ctx.companyId}`;
  if (period?.closed) {
    // The accounting convention (entry-validate assertValid): invalid_input whose message leads with the refusal code.
    throw new ProcessError("invalid_input", "closed_period: El período está cerrado", { details: ["El período está cerrado"] });
  }
};
const hooksFor = (entity: string, prefix: string): TypedHooks => ({
  async validate(_ctx, record, mode) {
    hookCalls.push({ entity, hook: "validate", mode, status: String(record.status) });
  },
  async number(ctx, record) {
    hookCalls.push({ entity, hook: "number", status: String(record.status) });
    return nextNumber(ctx.tx, ctx.companyId, prefix);
  },
  post: postHook(entity),
});

const create = (entity: EntityDef) => defineProcess({
  id: `${entity.id}.create`,
  module: "ap",
  kind: "create",
  description: "Crea un documento de prueba en Borrador",
  input: z.object({ name: z.string(), posts: z.boolean().optional(), requiresApproval: z.boolean().optional() }),
  output: z.object({ id: z.string() }),
  handler: async (ctx, input) => {
    const [row] = await ctx.tx.unsafe<{ id: string }[]>(
      `insert into ${SCHEMA}.${entity.table} (company_id, name, posts, requires_approval) values ($1, $2, $3, $4) returning id`,
      [ctx.companyId, input.name, input.posts ?? null, input.requiresApproval ?? null],
    );
    return { id: row!.id };
  },
});

const apModule = defineModule({
  id: "ap",
  version: "0.0.1",
  dependsOn: [],
  entities: [invEntity, entEntity, bareEntity],
  processes: [create(invEntity), create(entEntity), create(bareEntity)],
  features: [{ id: "ap.main", label: "feature.ap.main", processes: ["ap.inv.create", "ap.ent.create", "ap.bare.create"], entities: ["ap.inv", "ap.ent", "ap.bare"] }],
  events: { emits: [], consumes: {} },
  navigation: [],
  typedHooks: { "ap.inv": hooksFor("ap.inv", "FV"), "ap.ent": hooksFor("ap.ent", "CE"), "ap.bare": {} },
});

const docTable = (name: string) => `
  create table ${SCHEMA}.${name} (
    id uuid primary key default kernel.uuid_v7(), seq bigint not null, company_id uuid not null references kernel.companies (id),
    number text, name text, amount numeric(18,4) not null default 0,
    extra jsonb not null default '{}'::jsonb, extra_free jsonb not null default '[]'::jsonb,
    created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
    created_by uuid default kernel.current_user_id(), updated_by uuid);
  select kernel.typed_columns('${SCHEMA}', '${name}', 'documento', 'ap.${name}');`;
const TABLES_SQL = `
  drop schema if exists ${SCHEMA} cascade;
  create schema ${SCHEMA};
  grant usage on schema ${SCHEMA} to authenticated, service_role;
  ${docTable("inv")}
  ${docTable("ent")}
  ${docTable("bare")}
  create table ${SCHEMA}.counters (company_id uuid primary key references kernel.companies (id), n int not null default 0);
  create table ${SCHEMA}.periods (company_id uuid primary key references kernel.companies (id), closed boolean not null default false);
  create table ${SCHEMA}.postings (
    id uuid primary key default kernel.uuid_v7(), company_id uuid not null references kernel.companies (id), record_id uuid not null, number text);
`;

describe("automatic posting (D8)", () => {
  let sql: ReturnType<typeof testDb>;
  let seed: Awaited<ReturnType<typeof seedTenant>>;
  let registry: Registry;
  let companyId: string;
  let admin: Caller;

  const run = <T = Record<string, unknown>>(processId: string, input: unknown): Promise<T> => runProcess({ sql, registry }, admin, processId, input);
  const refusal = async (promise: Promise<unknown>) => (await promise.then(() => null, (e: unknown) => e)) as ProcessError | null;
  const row = async (table: string, id: string) => (await sql.unsafe(`select * from ${SCHEMA}.${table} where id = $1`, [id]))[0];
  const snapshots = async (id: string) =>
    (await sql<{ status: string }[]>`select status from kernel.record_snapshots where company_id = ${companyId} and record_id = ${id} order by seq`).map((s) => s.status);
  /** The record's outbox rows other than the status notices (Task 12), which `changes` reads. */
  const outbox = async (id: string) =>
    sql<{ event: string; payload: Record<string, unknown>; chain_id: string | null }[]>`
      select event, payload, chain_id from kernel.outbox where company_id = ${companyId} and payload->>'id' = ${id} and event not like '%.status_changed' order by created_at`;
  /** The statuses the record entered (`<entity>.status_changed`, Task 12) as [from, to], in lifecycle order (one run writes several at one instant). */
  const ORDER = ["draft", "saved", "pending", "rejected", "approved", "posted", "voided"];
  const changes = async (id: string) =>
    (await sql<{ from: string; to: string }[]>`
      select payload->>'from' as from, payload->>'to' as to from kernel.outbox where company_id = ${companyId} and payload->>'id' = ${id} and event like '%.status_changed'`)
      .map((r) => [r.from, r.to])
      .sort((a, b) => ORDER.indexOf(a[1]!) - ORDER.indexOf(b[1]!));
  const postings = async (id: string) => sql<{ number: string | null }[]>`select number from ap_fixture.postings where record_id = ${id}`;
  const counter = async () => (await sql<{ n: number }[]>`select n from ap_fixture.counters where company_id = ${companyId}`)[0]!.n;
  const setClosed = (closed: boolean) => sql`update ap_fixture.periods set closed = ${closed} where company_id = ${companyId}`;
  const newDoc = async (entity: string, input: Record<string, unknown> = {}) => (await run<{ id: string }>(`${entity}.create`, { name: "Factura", posts: true, ...input })).id;

  beforeAll(async () => {
    sql = testDb();
    await sql.unsafe(TABLES_SQL);
    for (const table of ["inv", "ent", "bare"]) {
      await sql.unsafe(`select kernel.enable_company_rls('${SCHEMA}', '${table}')`);
      await sql.unsafe(`select kernel.enable_row_audit('${SCHEMA}', '${table}')`);
      await sql.unsafe(`create trigger assign_seq before insert on ${SCHEMA}.${table} for each row execute function core.assign_seq('ap.${table}')`);
      await sql.unsafe(`create trigger touch_row before update on ${SCHEMA}.${table} for each row execute function core.touch_row()`);
      await sql.unsafe(`grant select, insert, update, delete on ${SCHEMA}.${table} to authenticated`);
      await sql.unsafe(`grant all on ${SCHEMA}.${table} to service_role`);
    }
    for (const table of ["counters", "periods", "postings"]) {
      await sql.unsafe(`select kernel.enable_company_rls('${SCHEMA}', '${table}')`);
      await sql.unsafe(`grant select, insert, update on ${SCHEMA}.${table} to authenticated`);
      await sql.unsafe(`grant all on ${SCHEMA}.${table} to service_role`);
    }

    registry = new Registry();
    loadModules(registry, [kernelModule, defineModule(apModule)]);
    seed = await seedTenant(sql, { companies: 1, entitlements: ["module:ap"] });
    companyId = seed.companies[0]!.id;
    admin = { claims: seed.claimsFor(seed.users.both, companyId), origin: "ui" };
    await sql`insert into ap_fixture.counters (company_id) values (${companyId})`;
    await sql`insert into ap_fixture.periods (company_id) values (${companyId})`;
  });
  beforeEach(async () => {
    hookCalls.length = 0;
    await setClosed(false);
  });
  afterAll(async () => {
    await sql.unsafe(`drop schema if exists ${SCHEMA} cascade`);
    await seed.cleanup();
    await sql.end();
  });

  it("Grabar posts a documento with Contabiliza and no approval: saved, ready_to_post, post hook, posted, in one run", async () => {
    const id = await newDoc("ap.inv");
    const result = await run<{ id: string; status: string; number?: string }>("ap.inv.save", { id, data: { name: "Factura 1", amount: 1200 } });
    expect(result).toMatchObject({ id, status: "posted" });
    expect(result.number).toMatch(/^FV-\d+$/);
    expect(await row("inv", id)).toMatchObject({ status: "posted", number: result.number, name: "Factura 1", amount: "1200.0000" });
    expect(hookCalls.map((c) => [c.hook, c.mode ?? null, c.status])).toEqual([
      ["validate", "save", "saved"],
      ["number", null, "saved"],
      ["validate", "post", "saved"],
      ["post", null, "saved"],
    ]);
    expect(await snapshots(id)).toEqual(["saved", "posted"]);
    const events = await outbox(id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ event: "ap.inv.ready_to_post", payload: { entity: "ap.inv", id, status: "saved", number: result.number } });
    expect(events[0]!.chain_id).not.toBeNull();
    expect(await changes(id)).toEqual([["draft", "saved"], ["saved", "posted"]]);
    expect(await postings(id)).toEqual([{ number: result.number }]);
  });

  it("without Contabiliza Grabar stays saved: no ready_to_post, no post hook", async () => {
    const id = await newDoc("ap.inv", { posts: false });
    expect(await run("ap.inv.save", { id })).toMatchObject({ status: "saved" });
    expect(hookCalls.some((c) => c.hook === "post" || c.mode === "post")).toBe(false);
    expect(await outbox(id)).toHaveLength(0);
    expect(await changes(id)).toEqual([["draft", "saved"]]);
    expect(await snapshots(id)).toEqual(["saved"]);
  });

  it("a posting refusal on Grabar rolls the whole action back: still draft with its data, no number, no snapshot, no outbox row", async () => {
    const id = await newDoc("ap.inv");
    const before = await row("inv", id);
    const consumed = await counter();
    await setClosed(true);
    const error = await refusal(run("ap.inv.save", { id, data: { name: "Editada", amount: 99 } }));
    expect(error).toBeInstanceOf(ProcessError);
    expect(error).toMatchObject({ code: "invalid_input", details: ["El período está cerrado"] });
    expect(error!.message).toMatch(/^closed_period:/);
    // The hooks ran up to the refusal: numbered, posted, refused.
    expect(hookCalls.map((c) => c.hook)).toEqual(["validate", "number", "validate", "post"]);

    const after = await row("inv", id);
    expect(after).toMatchObject({ status: "draft", number: null, name: "Factura", amount: "0.0000" });
    expect(after!.updated_at).toEqual(before!.updated_at);
    expect(await counter()).toBe(consumed);
    expect(await snapshots(id)).toEqual([]);
    expect(await outbox(id)).toHaveLength(0);
    expect(await changes(id)).toEqual([]);
    expect(await postings(id)).toHaveLength(0);
  });

  it("Aprobar posts a documento with Contabiliza and approval; a posting refusal leaves it pending; after reopening the period Aprobar posts", async () => {
    const id = await newDoc("ap.inv", { requiresApproval: true });
    const saved = await run<{ status: string; number?: string }>("ap.inv.save", { id });
    // With approval, Grabar does not post.
    expect(saved).toMatchObject({ status: "saved" });
    expect(await outbox(id)).toHaveLength(0);
    await run("ap.inv.submit", { id });
    expect(await snapshots(id)).toEqual(["saved", "pending"]);
    const pending = await row("inv", id);
    const consumed = await counter();

    hookCalls.length = 0;
    await setClosed(true);
    const error = await refusal(run("ap.inv.approve", { id }));
    expect(error).toMatchObject({ code: "invalid_input" });
    expect(error!.message).toMatch(/^closed_period:/);
    expect(hookCalls.map((c) => [c.hook, c.mode ?? null])).toEqual([["validate", "approve"], ["validate", "post"], ["post", null]]);
    const after = await row("inv", id);
    expect(after).toMatchObject({ status: "pending", number: saved.number });
    expect(after!.updated_at).toEqual(pending!.updated_at);
    expect(await counter()).toBe(consumed);
    expect(await snapshots(id)).toEqual(["saved", "pending"]);
    expect(await outbox(id)).toHaveLength(0);
    expect(await changes(id)).toEqual([["draft", "saved"], ["saved", "pending"]]);
    expect(await postings(id)).toHaveLength(0);

    await setClosed(false);
    hookCalls.length = 0;
    const approved = await run<{ status: string; number?: string }>("ap.inv.approve", { id });
    expect(approved).toMatchObject({ status: "posted" });
    expect(approved.number).toBeUndefined();
    expect(await row("inv", id)).toMatchObject({ status: "posted", number: saved.number });
    expect(hookCalls.map((c) => [c.hook, c.mode ?? null, c.status])).toEqual([["validate", "approve", "approved"], ["validate", "post", "approved"], ["post", null, "approved"]]);
    expect(await snapshots(id)).toEqual(["saved", "pending", "approved", "posted"]);
    const events = await outbox(id);
    expect(events.map((e) => e.event)).toEqual(["ap.inv.ready_to_post"]);
    expect(events[0]!.payload).toMatchObject({ status: "approved" });
    expect(await changes(id)).toEqual([["draft", "saved"], ["saved", "pending"], ["pending", "approved"], ["approved", "posted"]]);
    expect(await postings(id)).toEqual([{ number: saved.number }]);
  });

  it("an on_post documento (a comprobante) takes its number at posting, after validate(post) and before the post hook (D9)", async () => {
    const id = await newDoc("ap.ent", { name: "Comprobante" });
    const result = await run<{ status: string; number?: string }>("ap.ent.save", { id });
    expect(result.status).toBe("posted");
    expect(result.number).toMatch(/^CE-\d+$/);
    expect(hookCalls.map((c) => [c.hook, c.mode ?? null])).toEqual([["validate", "save"], ["validate", "post"], ["number", null], ["post", null]]);
    expect(await row("ent", id)).toMatchObject({ status: "posted", number: result.number });
    expect(await postings(id)).toEqual([{ number: result.number }]);
    expect(await snapshots(id)).toEqual(["saved", "posted"]);
  });

  it("an on_post documento refused at posting keeps no number and the counter does not move", async () => {
    const id = await newDoc("ap.ent", { name: "Comprobante" });
    const consumed = await counter();
    await setClosed(true);
    expect((await refusal(run("ap.ent.save", { id })))!.message).toMatch(/^closed_period:/);
    expect(await row("ent", id)).toMatchObject({ status: "draft", number: null });
    expect(await counter()).toBe(consumed);
    expect(await snapshots(id)).toEqual([]);
    expect(await outbox(id)).toHaveLength(0);
    expect(await changes(id)).toEqual([]);
  });

  it("an on_post documento with approval is not numbered at Grabar and is numbered when Aprobar posts it", async () => {
    const id = await newDoc("ap.ent", { name: "Comprobante", requiresApproval: true });
    expect(await run("ap.ent.save", { id })).toMatchObject({ id, status: "saved" });
    expect((await row("ent", id))!.number).toBeNull();
    await run("ap.ent.submit", { id });
    const approved = await run<{ status: string; number?: string }>("ap.ent.approve", { id });
    expect(approved.status).toBe("posted");
    expect(approved.number).toMatch(/^CE-\d+$/);
    expect(await row("ent", id)).toMatchObject({ status: "posted", number: approved.number });
  });

  it("a documento with Contabiliza whose module registers no post hook fails closed: the action rolls back", async () => {
    const id = await newDoc("ap.bare");
    expect(await refusal(run("ap.bare.save", { id, data: { name: "Otra" } }))).toMatchObject({ code: "handler_failed" });
    expect(await row("bare", id)).toMatchObject({ status: "draft", name: "Factura" });
    expect(await snapshots(id)).toEqual([]);
    expect(await outbox(id)).toHaveLength(0);
    expect(await changes(id)).toEqual([]);
  });
});
