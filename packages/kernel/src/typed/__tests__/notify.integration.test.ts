import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { MailIdempotencyError, SmtpMailer, type Mailer, type MailMessage } from "@erp/infra";
import { seedTenant, testDb } from "../../db/test-db";
import { buildConsumerContext, consumers } from "../../events/consumers";
import { MemoryFileStore, setFileStore } from "../../files/store";
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
import { pdfText } from "../../templates/__tests__/pdf-text";
import { mailBodyHash, setMailer } from "../notify";

// State e-mails and Notificar (entity types spec 2026-11-02 §7; Phase 2A.5 Task 12, migration 0049):
//  - every status a maestro or documento enters is an outbox event `<entity>.status_changed` (from, to, number, actorId), written by the
//    lifecycle runner in the action's transaction;
//  - the kernel's consumer of that event reads kernel.state_recipients for (entity, new status); with a list it renders the record's PDF
//    (the default record template, Task 11) WITH THE RIGHTS OF THE USER WHOSE ACTION CHANGED THE STATUS (field visibility, record access),
//    sends one mail with the PDF attached and logs it in kernel.mail_log, once per event id (a redelivery sends nothing more; a failed
//    send is logged `failed` and retried by the outbox, never duplicated); without a list there is no mail and no log row;
//  - kernel.record.notify (Notificar) sends the record's PDF, rendered as the caller, to the addresses they give, validated, once its
//    log row is committed;
//  - fix round 1: the recipients go in Bcc (no header lists them), a delivery claims its event before rendering (a parallel delivery
//    sends nothing), the render is the event's (a retry sends the same bytes; Resend's 409 for the key is sent only for the same body),
//    the stored list is re-validated and capped, and a subject is one line;
//  - fix round 2: the claim is a lease row (kernel.mail_claims) committed in its own short transaction, so no connection is held
//    while rendering and sending (more parallel deliveries than the pool has connections finish) and an expired lease is taken over.
// The mail goes to the Docker SMTP sink of the local stack (Mailpit, supabase/config.toml [local_smtp]: SMTP on 54325, API on 55324;
// TEST_SMTP_HOST / TEST_SMTP_PORT / TEST_MAILPIT_URL point elsewhere, as the compose stack of CI does). The fixture module `nt`
// (schema nt_fixture) is created here, never in a migration.

const SMTP_HOST = process.env.TEST_SMTP_HOST ?? "127.0.0.1";
const SMTP_PORT = Number(process.env.TEST_SMTP_PORT ?? "54325");
const MAILPIT = (process.env.TEST_MAILPIT_URL ?? "http://127.0.0.1:55324").replace(/\/+$/, "");

const SCHEMA = "nt_fixture";
const field = (entity: string, name: string, type: EntityDef["fields"][number]["type"]) => ({ name, type, label: `field.${entity}.${name}` });
const trailer = (entity: string) => [field(entity, "extra", "json"), field(entity, "extra_free", "json"), field(entity, "created_at", "datetime"), field(entity, "updated_at", "datetime")];

const orderEntity: EntityDef = {
  id: "nt.order", module: "nt", schema: SCHEMA, table: "orders", label: "entity.nt.order", entityType: "documento",
  typed: { numbering: "on_save", lines: { entity: "nt.order_line", parentField: "order_id" } },
  displayField: "name", defaultSort: { field: "name", dir: "asc" },
  fields: [field("nt.order", "number", "text"), field("nt.order", "name", "text"), field("nt.order", "secret", "text"), field("nt.order", "status", "text"), ...trailer("nt.order")],
};
const lineEntity: EntityDef = {
  id: "nt.order_line", module: "nt", schema: SCHEMA, table: "order_lines", label: "entity.nt.order_line", entityType: "lines",
  displayField: "description", defaultSort: { field: "description", dir: "asc" },
  fields: [field("nt.order_line", "order_id", "uuid"), field("nt.order_line", "description", "text"), field("nt.order_line", "amount", "money")],
};

const createOrder = defineProcess({
  id: "nt.order.create", module: "nt", kind: "create", description: "Crea un pedido de prueba en Borrador",
  input: z.object({ name: z.string(), secret: z.string().default(""), requiresApproval: z.boolean().default(true) }),
  output: z.object({ id: z.string() }),
  handler: async (ctx, input) => {
    const [row] = await ctx.tx<{ id: string }[]>`
      insert into nt_fixture.orders (company_id, name, secret, requires_approval, posts) values (${ctx.companyId}, ${input.name}, ${input.secret}, ${input.requiresApproval}, false) returning id`;
    await ctx.tx`insert into nt_fixture.order_lines (company_id, order_id, description, amount) values (${ctx.companyId}, ${row!.id}, 'Café tostado', 125000)`;
    return { id: row!.id };
  },
});
const consultOrder = defineProcess({
  id: "nt.order.consult", module: "nt", kind: "consult", description: "Consulta pedidos de prueba",
  input: z.object({}), output: z.object({}), handler: async () => ({}),
});

const ntModule = defineModule({
  id: "nt", version: "0.0.1", dependsOn: [],
  entities: [orderEntity, lineEntity],
  processes: [createOrder, consultOrder],
  features: [{ id: "nt.main", label: "feature.nt.main", processes: ["nt.order.create", "nt.order.consult"], entities: ["nt.order", "nt.order_line"] }],
  events: { emits: [], consumes: {} },
  navigation: [],
  typedHooks: {
    "nt.order": {
      async number(ctx) {
        const [row] = await ctx.tx<{ n: number }[]>`select count(*)::int + 1 as n from nt_fixture.orders where number is not null`;
        return `PD-${row!.n}`;
      },
    },
  },
});

const TABLES_SQL = `
  drop schema if exists ${SCHEMA} cascade;
  create schema ${SCHEMA};
  drop schema if exists nt cascade;
  create schema nt;
  create function nt.attachments_changed(text, uuid, uuid) returns void language sql as $f$ select $f$;
  grant usage on schema ${SCHEMA} to authenticated, service_role;
  create table ${SCHEMA}.orders (
    id uuid primary key default kernel.uuid_v7(), seq bigint not null, company_id uuid not null references kernel.companies (id),
    number text, name text, secret text,
    extra jsonb not null default '{}'::jsonb, extra_free jsonb not null default '[]'::jsonb,
    created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
    created_by uuid default kernel.current_user_id(), updated_by uuid);
  select kernel.typed_columns('${SCHEMA}', 'orders', 'documento', 'nt.order');
  create table ${SCHEMA}.order_lines (
    id uuid primary key default kernel.uuid_v7(), seq bigint not null, company_id uuid not null references kernel.companies (id),
    order_id uuid not null references ${SCHEMA}.orders (id), description text, amount numeric(18,4),
    created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
    created_by uuid default kernel.current_user_id(), updated_by uuid);
`;

const CATALOGUE: Record<string, string> = {
  "common.print.page_number": "Página {n} de {total}",
  "common.notify.subject": "{tipo} {numero} · {estado}",
  "common.notify.state_body": "{tipo} {numero} pasó a {estado}. Adjuntamos el documento.",
  "entity.nt.order": "Pedido de prueba",
  "grid.values.record_status.approved": "Aprobado",
  "grid.values.record_status.saved": "Grabado",
  "grid.values.record_status.pending": "Pendiente de Aprobación",
  "field.nt.order.name": "Nombre",
  "field.nt.order.secret": "Clave",
};

interface MailpitMessage {
  ID: string;
  Subject: string;
  To: { Address: string }[];
  Attachments: number;
}
interface MailpitDetail {
  ID: string;
  Subject: string;
  Text: string;
  To: { Address: string }[];
  Bcc: { Address: string }[] | null;
  Attachments: { PartID: string; FileName: string; ContentType: string; Size: number }[];
}

/** The messages Mailpit holds for `address` (To, Cc or Bcc: the envelope's recipients). */
async function inbox(address: string): Promise<MailpitMessage[]> {
  const response = await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`addressed:"${address}"`)}`);
  if (!response.ok) throw new Error(`Mailpit answered ${response.status}`);
  return ((await response.json()) as { messages: MailpitMessage[] }).messages;
}
async function detail(id: string): Promise<MailpitDetail> {
  return (await (await fetch(`${MAILPIT}/api/v1/message/${id}`)).json()) as MailpitDetail;
}
/**
 * The header block the sender wrote, from the raw message: Mailpit prepends its own trace lines on receipt (Return-Path, Received
 * "for <rcpt>", and a Bcc line it keeps from the envelope), so the block starts at the sender's first header, From.
 */
async function sentHeaders(id: string): Promise<string> {
  const raw = await (await fetch(`${MAILPIT}/api/v1/message/${id}/raw`)).text();
  const head = raw.split(/\r?\n\r?\n/, 1)[0]!;
  return head.slice(head.search(/^From:/m));
}
/** The sender every test mail comes from; with the recipients in Bcc it is also the visible To. */
const FROM = "erp@cafedelnorte.test";
async function part(id: string, partId: string): Promise<Uint8Array> {
  return new Uint8Array(await (await fetch(`${MAILPIT}/api/v1/message/${id}/part/${partId}`)).arrayBuffer());
}

describe("state e-mails and Notificar (Task 12)", () => {
  let sql: ReturnType<typeof testDb>;
  let seed: Awaited<ReturnType<typeof seedTenant>>;
  let registry: Registry;
  let companyId: string;
  let admin: Caller;
  /** A member whose role sees `secret` hidden. */
  let member: Caller;
  const sink = new SmtpMailer({ host: SMTP_HOST, port: SMTP_PORT, from: FROM });
  /** Records every message it is asked to send, then passes it to `next` (the sink, unless a test says otherwise). */
  const capture = (sent: MailMessage[], next: Mailer["send"] = (m) => sink.send(m)): Mailer => ({ transport: "smtp", send: async (m) => (sent.push(m), next(m)) });
  /** The headers of a received mail say nothing of the recipients: To is the sender, there is no Cc or Bcc line. */
  const expectNoRecipientHeaders = async (id: string, to: string[]) => {
    const head = await sentHeaders(id);
    expect(head).toMatch(new RegExp(`^To: ${FROM}$`, "m"));
    expect(head).not.toMatch(/^(Cc|Bcc):/im);
    for (const address of to) expect(head.toLowerCase()).not.toContain(address.toLowerCase());
  };

  const tag = randomUUID().slice(0, 8);
  const address = (name: string) => `${name}-${tag}@notify.test`;

  const stepUp = async (caller: Caller): Promise<Caller> => {
    const stepUpToken = randomUUID();
    await sql`insert into kernel.step_up_verifications(user_id, company_id, token) values (${caller.claims.sub}, ${companyId}, ${stepUpToken})`;
    return { ...caller, stepUpToken };
  };
  const run = <T = Record<string, unknown>>(caller: Caller, processId: string, input: unknown): Promise<T> => runProcess({ sql, registry }, caller, processId, input);
  const refusal = async (promise: Promise<unknown>) => (await promise.then(() => null, (e: unknown) => e)) as ProcessError | null;
  const recipients = async (status: string, emails: string[]) => run(await stepUp(admin), "kernel.state_recipients.update", { entity: "nt.order", status, emails });
  /** A pending order of the member, ready for Aprobar. */
  const pendingOrder = async (name: string, secret = "") => {
    const { id } = await run<{ id: string }>(member, "nt.order.create", { name, secret });
    await run(member, "nt.order.save", { id });
    await run(member, "nt.order.submit", { id });
    return id;
  };
  const events = async (id: string) =>
    sql<{ id: string; event: string; payload: Record<string, unknown>; created_at: Date; chain_id: string; company_id: string }[]>`
      select id, event, payload, created_at, chain_id, company_id from kernel.outbox where company_id = ${companyId} and payload->>'id' = ${id} and event = 'nt.order.status_changed' order by created_at, id`;
  /** Delivers one outbox row to the kernel's consumer, as the dispatch workflow does (a step per consumer). */
  const deliver = async (row: Awaited<ReturnType<typeof events>>[number]) => {
    const consumer = consumers.for(row.event).find((c) => c.moduleId === "kernel");
    expect(consumer).toBeDefined();
    await consumer!.fn(buildConsumerContext(sql, { id: row.id, event: row.event, createdAt: row.created_at, companyId: row.company_id, chainId: row.chain_id }, registry), row.payload);
  };
  const mailLog = async (recordId: string) =>
    sql<{ id: string; event_id: string | null; recipients: string[]; status: string; template_version: number | null; provider_id: string | null; created_by: string | null; subject: string | null; error: string | null }[]>`
      select id, event_id, recipients, status, template_version, provider_id, created_by, subject, error from kernel.mail_log where record_id = ${recordId} order by seq`;

  beforeAll(async () => {
    sql = testDb();
    setFileStore(new MemoryFileStore());
    setMailer(sink);
    registerCatalogue((locale, key) => (locale === "es-419" ? CATALOGUE[key] : undefined));
    await sql.unsafe(TABLES_SQL);
    for (const table of ["orders", "order_lines"]) {
      await sql.unsafe(`select kernel.enable_company_rls('${SCHEMA}', '${table}')`);
      await sql.unsafe(`select kernel.enable_row_audit('${SCHEMA}', '${table}')`);
      await sql.unsafe(`create trigger assign_seq before insert on ${SCHEMA}.${table} for each row execute function core.assign_seq('nt.${table}')`);
      await sql.unsafe(`create trigger touch_row before update on ${SCHEMA}.${table} for each row execute function core.touch_row()`);
      await sql.unsafe(`grant select, insert, update, delete on ${SCHEMA}.${table} to authenticated`);
      await sql.unsafe(`grant all on ${SCHEMA}.${table} to service_role`);
    }
    await sql`select kernel.typed_lines(${SCHEMA}, 'order_lines', 'nt.order', 'order_id')`;
    for (const entity of [orderEntity, lineEntity]) {
      await sql.unsafe(maskedViewSql(defineEntity(entity)));
      await sql.unsafe(`grant select on ${SCHEMA}.v_${entity.table} to authenticated, service_role`);
    }

    registry = new Registry();
    loadModules(registry, [kernelModule, ntModule]);
    seed = await seedTenant(sql, { companies: 1, entitlements: ["module:nt"], users: [{ name: "member", companies: [0], role: "member" }, { name: "other", companies: [0], role: "member" }] });
    companyId = seed.companies[0]!.id;
    const memberRole = seed.companies[0]!.memberRoleId;
    for (const id of ["nt.order.create", "nt.order.consult", "nt.order.save", "nt.order.submit", "nt.order.approve", "kernel.record.notify"]) {
      await sql`insert into kernel.process_permissions(company_id, role_id, process_id) values (${companyId}, ${memberRole}, ${id})`;
    }
    await sql`insert into kernel.field_permissions(company_id, role_id, entity, field, mode) values (${companyId}, ${memberRole}, 'nt.order', 'secret', 'hidden')`;
    admin = { claims: seed.claimsFor(seed.users.both, companyId), origin: "ui" };
    member = { claims: seed.claimsFor(seed.users.member!, companyId), origin: "ui" };
    await syncRegistry(sql, registry);
  });
  afterAll(async () => {
    registerCatalogue(undefined);
    setFileStore(undefined);
    setMailer(undefined);
    await sql`delete from kernel.state_recipients where company_id = ${companyId}`;
    await sql`delete from kernel.entity_tables where module_id = 'nt'`;
    await sql`delete from kernel.entity_fields where module_id = 'nt'`;
    await sql`delete from kernel.record_access_tables where table_schema = ${SCHEMA}`;
    await sql.unsafe(`drop schema if exists ${SCHEMA} cascade`);
    await sql.unsafe(`drop schema if exists nt cascade`);
    await seed.cleanup();
    await sql.end();
  });

  it("the lifecycle writes <entity>.status_changed for every status entered, with from, to, the number and the actor", async () => {
    const id = await pendingOrder("Eventos");
    await run(admin, "nt.order.approve", { id });
    const rows = await events(id);
    expect(rows.map((r) => [r.payload.from, r.payload.to])).toEqual([["draft", "saved"], ["saved", "pending"], ["pending", "approved"]]);
    expect(rows[0]!.payload).toMatchObject({ entity: "nt.order", id, actorId: seed.users.member, number: expect.stringMatching(/^PD-\d+$/) });
    expect(rows[2]!.payload.actorId).toBe(seed.users.both);
  });

  it("a refused action writes no status_changed event (it rolls back with the action)", async () => {
    const id = await pendingOrder("Rechazo sin motivo");
    const before = (await events(id)).length;
    expect(await refusal(run(admin, "nt.order.reject", { id, reason: " " }))).toMatchObject({ code: "invalid_input" });
    expect(await events(id)).toHaveLength(before);
  });

  it("reaching approved with a recipient list sends one mail with the PDF to the SMTP sink, rendered as the actor, and logs it", async () => {
    const to = [address("aprobado-a"), address("aprobado-b")];
    await recipients("approved", to);
    const id = await pendingOrder("Pedido aprobado", "CLAVE-SECRETA-123");
    // The member approves: the PDF is what the member could print (secret hidden), not the admin's nor the service role's view.
    await run(member, "nt.order.approve", { id });
    for (const row of await events(id)) await deliver(row);

    const received = await inbox(to[0]!);
    expect(received).toHaveLength(1);
    const message = await detail(received[0]!.ID);
    // I1: every recipient receives it in Bcc; none of them sees the others' addresses.
    expect(message.To.map((t) => t.Address)).toEqual([FROM]);
    expect((message.Bcc ?? []).map((t) => t.Address).sort()).toEqual([...to].sort());
    expect(await inbox(to[1]!)).toHaveLength(1);
    await expectNoRecipientHeaders(message.ID, to);
    const [number] = (await sql<{ number: string }[]>`select number from nt_fixture.orders where id = ${id}`).map((r) => r.number);
    expect(message.Subject).toBe(`Pedido de prueba ${number} · Aprobado`);
    expect(message.Text).toContain(`Pedido de prueba ${number} pasó a Aprobado`);
    expect(message.Attachments).toHaveLength(1);
    expect(message.Attachments[0]).toMatchObject({ ContentType: "application/pdf", FileName: expect.stringMatching(/\.pdf$/) });
    const text = pdfText(await part(message.ID, message.Attachments[0]!.PartID));
    expect(text).toContain("Pedido aprobado");
    expect(text).not.toContain("CLAVE-SECRETA-123");

    const log = await mailLog(id);
    expect(log).toHaveLength(1);
    const approvedEvent = (await events(id)).find((r) => r.payload.to === "approved")!;
    expect(log[0]).toMatchObject({ event_id: approvedEvent.id, status: "sent", template_version: 0, created_by: seed.users.member, error: null });
    expect([...log[0]!.recipients].sort()).toEqual([...to].sort());
    expect(log[0]!.provider_id).toBeTruthy();
  });

  it("a redelivered event sends nothing extra", async () => {
    const to = [address("redelivery")];
    await recipients("approved", to);
    const id = await pendingOrder("Pedido dos veces");
    await run(admin, "nt.order.approve", { id });
    const approved = (await events(id)).find((r) => r.payload.to === "approved")!;
    await deliver(approved);
    await deliver(approved);
    expect(await inbox(to[0]!)).toHaveLength(1);
    expect(await mailLog(id)).toHaveLength(1);
  });

  it("a failed send is logged failed and retried by the outbox, then sent once", async () => {
    const to = [address("falla")];
    await recipients("approved", to);
    const id = await pendingOrder("Pedido con falla");
    await run(admin, "nt.order.approve", { id });
    const approved = (await events(id)).find((r) => r.payload.to === "approved")!;

    const broken: Mailer = { transport: "smtp", send: async () => Promise.reject(new Error("Mailer: SMTP server answered \"451 try later\"")) };
    setMailer(broken);
    // The consumer throws, so the dispatch step retries the event (a plain error, not a refusal that dead-letters).
    await expect(deliver(approved)).rejects.toThrow(/451 try later/);
    expect(await mailLog(id)).toMatchObject([{ event_id: approved.id, status: "failed", error: expect.stringContaining("451") }]);
    expect(await inbox(to[0]!)).toHaveLength(0);

    setMailer(sink);
    await deliver(approved);
    const log = await mailLog(id);
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ status: "sent", error: null });
    expect(await inbox(to[0]!)).toHaveLength(1);
  });

  it("I4: two deliveries of the same event in parallel send exactly one mail", async () => {
    const to = [address("paralelo")];
    await recipients("approved", to);
    const id = await pendingOrder("Pedido en paralelo");
    await run(admin, "nt.order.approve", { id });
    const approved = (await events(id)).find((r) => r.payload.to === "approved")!;
    const sent: MailMessage[] = [];
    // A slow provider: the second delivery starts while the first is still sending.
    setMailer(capture(sent, async (m) => (await new Promise((r) => setTimeout(r, 400)), sink.send(m))));
    try {
      const outcomes = await Promise.allSettled([deliver(approved), deliver(approved), deliver(approved)]);
      expect(outcomes.some((o) => o.status === "fulfilled")).toBe(true);
      // One that found the event claimed throws for a later retry (never a second send); the retry finds it sent.
      for (const o of outcomes) if (o.status === "rejected") expect(String(o.reason)).toMatch(/being sent by another delivery/);
      await deliver(approved);
    } finally {
      setMailer(sink);
    }
    expect(sent).toHaveLength(1);
    expect(await inbox(to[0]!)).toHaveLength(1);
    expect(await mailLog(id)).toMatchObject([{ status: "sent" }]);
  });

  it("N1: more parallel deliveries than the pool has connections (8 events against max 5, each twice) finish, one mail per event", async () => {
    const to = [address("pool")];
    await recipients("approved", to);
    const rows: Awaited<ReturnType<typeof events>>[number][] = [];
    for (let i = 0; i < 8; i++) {
      const id = await pendingOrder(`Pedido del pool ${i}`);
      await run(admin, "nt.order.approve", { id });
      rows.push((await events(id)).find((r) => r.payload.to === "approved")!);
    }
    const sent: MailMessage[] = [];
    // A slow provider: every delivery is mid-send at once.
    setMailer(capture(sent, async (m) => (await new Promise((r) => setTimeout(r, 300)), sink.send(m))));
    try {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const bounded = new Promise<"hung">((r) => (timer = setTimeout(() => r("hung"), 20_000)));
      const all = Promise.allSettled(rows.flatMap((row) => [deliver(row), deliver(row)]));
      const outcome = await Promise.race([all, bounded]);
      clearTimeout(timer);
      expect(outcome).not.toBe("hung");
      for (const o of outcome as PromiseSettledResult<void>[]) if (o.status === "rejected") expect(String(o.reason)).toMatch(/being sent by another delivery/);
      // The deferred deliveries, retried, find their event sent.
      for (const row of rows) await deliver(row);
    } finally {
      setMailer(sink);
    }
    expect(sent).toHaveLength(8);
    expect(await inbox(to[0]!)).toHaveLength(8);
    const logged = await sql<{ status: string }[]>`select status from kernel.mail_log where event_id = any(${rows.map((r) => r.id)}::uuid[])`;
    expect(logged.map((r) => r.status)).toEqual(Array(8).fill("sent"));
    // Released: nothing of the claims is left.
    expect(await sql`select 1 from kernel.mail_claims where event_id = any(${rows.map((r) => r.id)}::uuid[])`).toHaveLength(0);
  });

  it("N2: a live lease of another delivery defers this one; once it expires the event is taken over and sent", async () => {
    const to = [address("lease")];
    await recipients("approved", to);
    const id = await pendingOrder("Pedido con lease");
    await run(admin, "nt.order.approve", { id });
    const approved = (await events(id)).find((r) => r.payload.to === "approved")!;
    // A delivery that died mid-send left its lease.
    await sql`insert into kernel.mail_claims (event_id, company_id, lease_until, claimed_by) values (${approved.id}, ${companyId}, now() + interval '5 minutes', 'dead-worker')`;
    await expect(deliver(approved)).rejects.toThrow(/being sent by another delivery/);
    expect(await inbox(to[0]!)).toHaveLength(0);
    await sql`update kernel.mail_claims set lease_until = now() - interval '1 second' where event_id = ${approved.id}`;
    await deliver(approved);
    expect(await inbox(to[0]!)).toHaveLength(1);
    expect(await mailLog(id)).toMatchObject([{ status: "sent" }]);
  });

  it("I3: a retry after a send that reached the provider but timed out sends the identical body", async () => {
    const to = [address("identico")];
    await recipients("approved", to);
    const id = await pendingOrder("Pedido idéntico");
    await run(admin, "nt.order.approve", { id });
    const approved = (await events(id)).find((r) => r.payload.to === "approved")!;
    const sent: MailMessage[] = [];
    setMailer(capture(sent, async () => Promise.reject(new Error("Mailer: SMTP connection timed out"))));
    await expect(deliver(approved)).rejects.toThrow(/timed out/);
    // A second later (the print time is the event's, not the clock's).
    await new Promise((r) => setTimeout(r, 1100));
    setMailer(capture(sent));
    try {
      await deliver(approved);
    } finally {
      setMailer(sink);
    }
    expect(sent).toHaveLength(2);
    expect(sent[1]!.attachments![0]!.filename).toBe(sent[0]!.attachments![0]!.filename);
    expect(Buffer.from(sent[1]!.attachments![0]!.content).equals(Buffer.from(sent[0]!.attachments![0]!.content))).toBe(true);
    expect(mailBodyHash(sent[1]!)).toBe(mailBodyHash(sent[0]!));
    expect(sent[1]!.idempotencyKey).toBe(approved.id);
    const [row] = await sql<{ body_hash: string; status: string }[]>`select body_hash, status from kernel.mail_log where event_id = ${approved.id}`;
    expect(row).toEqual({ body_hash: mailBodyHash(sent[0]!), status: "sent" });
  });

  it("I3: Resend's 409 for the event's key: the same body is sent; another body is sent with a mismatch note, never retried", async () => {
    const repeat = new MailIdempotencyError("invalid_idempotent_request", "Mailer: Resend answered 409 invalid_idempotent_request");
    const timeout = async () => Promise.reject(new Error("Mailer: Resend request timed out"));
    await recipients("approved", [address("conflicto")]);

    // The same body: the earlier request was this mail, delivered.
    const same = await pendingOrder("Pedido 409 igual");
    await run(admin, "nt.order.approve", { id: same });
    const sameEvent = (await events(same)).find((r) => r.payload.to === "approved")!;
    setMailer(capture([], timeout));
    await expect(deliver(sameEvent)).rejects.toThrow(/timed out/);
    setMailer(capture([], async () => Promise.reject(repeat)));
    await deliver(sameEvent);
    expect(await mailLog(same)).toMatchObject([{ status: "sent", error: expect.stringContaining("provider_idempotent_repeat") }]);

    // Another body (the copy changed between the attempts): the provider will never send it under this key; failed, not retried.
    const other = await pendingOrder("Pedido 409 distinto");
    await run(admin, "nt.order.approve", { id: other });
    const otherEvent = (await events(other)).find((r) => r.payload.to === "approved")!;
    setMailer(capture([], timeout));
    await expect(deliver(otherEvent)).rejects.toThrow(/timed out/);
    registerCatalogue((locale, key) => (locale === "es-419" ? { ...CATALOGUE, "common.notify.state_body": "Otro texto para {numero}." }[key] : undefined));
    setMailer(capture([], async () => Promise.reject(repeat)));
    try {
      await deliver(otherEvent);
    } finally {
      registerCatalogue((locale, key) => (locale === "es-419" ? CATALOGUE[key] : undefined));
      setMailer(sink);
    }
    // n4: Resend only answers so when it accepted an earlier request with the key: a mail (the earlier render) went out. Logged sent,
    // with the note saying the body it holds is not the one rendered now; not retried.
    expect(await mailLog(other)).toMatchObject([{ status: "sent", error: expect.stringContaining("provider_idempotent_mismatch") }]);
  });

  it("m6: the stored list is re-validated, de-duplicated and capped at 50; what was left out is noted on the log row", async () => {
    const valid = Array.from({ length: 53 }, (_, i) => address(`lista${i}`));
    // Written around the process (as an older row or a direct edit could leave it): invalid entries, a repeat, over the limit.
    await sql`
      insert into kernel.state_recipients (company_id, entity, status, emails) values (${companyId}, 'nt.order', 'approved', ${["no-es-correo", valid[0]!.toUpperCase(), ...valid]})
      on conflict (company_id, entity, status) do update set emails = excluded.emails`;
    const id = await pendingOrder("Pedido lista larga");
    await run(admin, "nt.order.approve", { id });
    const sent: MailMessage[] = [];
    const approved = (await events(id)).find((r) => r.payload.to === "approved")!;
    // n3: the first attempt fails; the note survives the retry that sends.
    setMailer(capture([], async () => Promise.reject(new Error("Mailer: SMTP server answered \"451 try later\""))));
    await expect(deliver(approved)).rejects.toThrow(/451/);
    setMailer(capture(sent));
    try {
      await deliver(approved);
    } finally {
      setMailer(sink);
    }
    expect(sent).toHaveLength(1);
    expect(sent[0]!.bcc).toEqual(valid.slice(0, 50));
    expect(sent[0]!.to).toBeUndefined();
    const [log] = await mailLog(id);
    expect(log).toMatchObject({ status: "sent", recipients: valid.slice(0, 50) });
    expect(log!.error).toContain("invalid_recipients: 1");
    expect(log!.error).toContain("recipients_truncated: 3");
  });

  it("a status without a recipient list sends no mail and writes no mail_log row", async () => {
    await recipients("approved", []);
    const id = await pendingOrder("Pedido sin lista");
    await run(admin, "nt.order.approve", { id });
    for (const row of await events(id)) await deliver(row);
    expect(await mailLog(id)).toHaveLength(0);
  });

  it("an actor who can no longer read the record gets no mail sent in their name: logged failed, not retried", async () => {
    const to = [address("sin-acceso")];
    await recipients("approved", to);
    const id = await pendingOrder("Pedido restringido");
    await run(member, "nt.order.approve", { id });
    // After the approval only `other` may read the record (record-level access, Task 9): the member's rights no longer show it.
    await run(await stepUp(admin), "kernel.record_access.set", { entity: "nt.order", recordId: id, grants: [{ userId: seed.users.other!, rights: ["read", "modify", "void"] }] });
    const approved = (await events(id)).find((r) => r.payload.to === "approved")!;
    await deliver(approved);
    expect(await inbox(to[0]!)).toHaveLength(0);
    expect(await mailLog(id)).toMatchObject([{ event_id: approved.id, status: "failed", error: expect.stringContaining("not_found") }]);
  });

  describe("kernel.record.notify (Notificar)", () => {
    it("refuses an invalid address and sends nothing", async () => {
      const { id } = await run<{ id: string }>(member, "nt.order.create", { name: "Notificar inválido" });
      const error = await refusal(run(member, "kernel.record.notify", { entity: "nt.order", recordId: id, to: [address("ok"), "no-es-correo"] }));
      expect(error).toMatchObject({ code: "invalid_input" });
      expect(JSON.stringify(error!.details)).toContain("no-es-correo");
      expect(await mailLog(id)).toHaveLength(0);
    });

    it("refuses more than 50 recipients and an empty list", async () => {
      const { id } = await run<{ id: string }>(member, "nt.order.create", { name: "Notificar muchos" });
      const many = Array.from({ length: 51 }, (_, i) => address(`m${i}`));
      expect(await refusal(run(member, "kernel.record.notify", { entity: "nt.order", recordId: id, to: many }))).toMatchObject({ code: "invalid_input" });
      expect(await refusal(run(member, "kernel.record.notify", { entity: "nt.order", recordId: id, to: [] }))).toMatchObject({ code: "invalid_input" });
    });

    it("sends the PDF rendered as the caller with the subject and message given, and logs the run", async () => {
      const { id } = await run<{ id: string }>(member, "nt.order.create", { name: "Pedido notificado", secret: "OCULTO-987" });
      const to = [address("notificar")];
      const out = await run<{ mailLogId: string; status: string }>(member, "kernel.record.notify", { entity: "nt.order", recordId: id, to: [` ${to[0]!.toUpperCase()} `], subject: "Su pedido", message: "Hola, adjunto el pedido." });
      expect(out.status).toBe("sent");
      const received = await inbox(to[0]!);
      expect(received).toHaveLength(1);
      const message = await detail(received[0]!.ID);
      expect(message.Subject).toBe("Su pedido");
      expect(message.Text).toContain("Hola, adjunto el pedido.");
      expect((message.Bcc ?? []).map((t) => t.Address)).toEqual(to);
      await expectNoRecipientHeaders(message.ID, to);
      const text = pdfText(await part(message.ID, message.Attachments[0]!.PartID));
      expect(text).toContain("Pedido notificado");
      expect(text).not.toContain("OCULTO-987");
      expect(await mailLog(id)).toMatchObject([{ id: out.mailLogId, event_id: null, recipients: to, status: "sent", created_by: seed.users.member, subject: "Su pedido" }]);
      const [audit] = await sql`select actor_user_id, origin from kernel.audit_log where company_id = ${companyId} and process_id = 'kernel.record.notify' and action = 'insert' order by occurred_at desc limit 1`;
      expect(audit).toMatchObject({ actor_user_id: seed.users.member, origin: "ui" });

      // The control: the company admin, who sees every field (D12), sends the same record with the value printed.
      const adminTo = address("notificar-admin");
      await run(admin, "kernel.record.notify", { entity: "nt.order", recordId: id, to: [adminTo] });
      const adminMessage = await detail((await inbox(adminTo))[0]!.ID);
      expect(pdfText(await part(adminMessage.ID, adminMessage.Attachments[0]!.PartID))).toContain("OCULTO-987");
    });

    it("defaults the subject to «{tipo} {numero} · {estado}»", async () => {
      const id = await pendingOrder("Pedido por defecto");
      const to = [address("defecto")];
      await run(member, "kernel.record.notify", { entity: "nt.order", recordId: id, to });
      const [number] = (await sql<{ number: string }[]>`select number from nt_fixture.orders where id = ${id}`).map((r) => r.number);
      const received = await inbox(to[0]!);
      expect(received.map((m) => m.Subject)).toEqual([`Pedido de prueba ${number} · Pendiente de Aprobación`]);
    });

    it("a record the caller cannot read is refused as one that does not exist, and nothing is sent", async () => {
      const { id } = await run<{ id: string }>(admin, "nt.order.create", { name: "Pedido ajeno" });
      await run(await stepUp(admin), "kernel.record_access.set", { entity: "nt.order", recordId: id, grants: [{ userId: seed.users.other!, rights: ["read"] }] });
      const to = [address("ajeno")];
      const hidden = await refusal(run(member, "kernel.record.notify", { entity: "nt.order", recordId: id, to }));
      const missing = await refusal(run(member, "kernel.record.notify", { entity: "nt.order", recordId: randomUUID(), to }));
      expect(hidden).toMatchObject({ code: "not_found" });
      expect(missing).toMatchObject({ code: "not_found" });
      expect(hidden!.message.replace(id, "X")).toBe(missing!.message.replace(/[0-9a-f-]{36}/, "X"));
      expect(await inbox(to[0]!)).toHaveLength(0);
      expect(await mailLog(id)).toHaveLength(0);
    });

    it("m1: a subject is one line: the line breaks of the one given become spaces, so no header can be added through it", async () => {
      const { id } = await run<{ id: string }>(member, "nt.order.create", { name: "Pedido asunto" });
      const to = [address("asunto")];
      const injected = address("inyectado");
      await run(member, "kernel.record.notify", { entity: "nt.order", recordId: id, to, subject: `Café del Norte · Aprobado\r\nBcc: ${injected}` });
      const received = await inbox(to[0]!);
      expect(received.map((m) => m.Subject)).toEqual([`Café del Norte · Aprobado Bcc: ${injected}`]);
      expect(await inbox(injected)).toHaveLength(0);
      expect(await mailLog(id)).toMatchObject([{ subject: `Café del Norte · Aprobado Bcc: ${injected}` }]);
    });

    it("n7: a subject over 300 characters is refused with the limit it states", async () => {
      const { id } = await run<{ id: string }>(member, "nt.order.create", { name: "Pedido asunto largo" });
      const error = await refusal(run(member, "kernel.record.notify", { entity: "nt.order", recordId: id, to: [address("largo")], subject: "a".repeat(301) }));
      expect(error).toMatchObject({ code: "invalid_input" });
      expect(JSON.stringify(error!.details)).toContain("Máximo 300 caracteres");
      expect(await mailLog(id)).toHaveLength(0);
    });

    it("m3: the mail is sent only once its log row is committed; a failed send leaves the row failed", async () => {
      const { id } = await run<{ id: string }>(member, "nt.order.create", { name: "Pedido después del commit" });
      const seen: { status: string }[][] = [];
      setMailer({
        transport: "smtp",
        send: async () => {
          // Another connection: what is committed when the mail goes out.
          seen.push([...(await sql<{ status: string }[]>`select status from kernel.mail_log where record_id = ${id}`)]);
          throw new Error("Mailer: SMTP server answered \"554 rejected\"");
        },
      });
      let out: { mailLogId: string; status: string };
      try {
        out = await run<{ mailLogId: string; status: string }>(member, "kernel.record.notify", { entity: "nt.order", recordId: id, to: [address("commit")] });
      } finally {
        setMailer(sink);
      }
      expect(seen).toEqual([[{ status: "queued" }]]);
      expect(out.status).toBe("failed");
      expect(await mailLog(id)).toMatchObject([{ id: out.mailLogId, status: "failed", error: expect.stringContaining("554") }]);
    });

    it("minor 1: a replayed confirmation (same idempotency key) answers the real outcome and sends nothing again", async () => {
      const { id } = await run<{ id: string }>(member, "nt.order.create", { name: "Pedido repetido" });
      let sends = 0;
      setMailer({ transport: "smtp", send: async () => { sends++; throw new Error("Mailer: SMTP server answered \"554 rejected\""); } });
      const key = `notify-replay-${id}`;
      let first: { mailLogId: string; status: string };
      let again: { mailLogId: string; status: string };
      try {
        first = (await runProcess({ sql, registry }, member, "kernel.record.notify", { entity: "nt.order", recordId: id, to: [address("repetido")] }, { idempotencyKey: key })) as { mailLogId: string; status: string };
        again = (await runProcess({ sql, registry }, member, "kernel.record.notify", { entity: "nt.order", recordId: id, to: [address("repetido")] }, { idempotencyKey: key })) as { mailLogId: string; status: string };
      } finally {
        setMailer(sink);
      }
      expect(sends).toBe(1);
      expect(first.status).toBe("failed");
      expect(again).toEqual({ mailLogId: first.mailLogId, status: "failed" });
    });

    it("is a write: the assistant gets a confirmation card for it, never a direct run", () => {
      const def = registry.process("kernel.record.notify");
      expect(def.kind).not.toBe("consult");
    });
  });

  it("mail_log: only the outcome changes (status, provider id, error); the event id is unique", async () => {
    const [row] = await sql<{ id: string; event_id: string }[]>`select id, event_id from kernel.mail_log where company_id = ${companyId} and event_id is not null limit 1`;
    await sql`update kernel.mail_log set error = 'x', status = 'failed' where id = ${row!.id}`;
    await expect(sql`update kernel.mail_log set recipients = '{a@b.co}' where id = ${row!.id}`).rejects.toThrow(/mail_log_immutable/);
    await expect(sql`update kernel.mail_log set event_id = gen_random_uuid() where id = ${row!.id}`).rejects.toThrow(/mail_log_immutable/);
    await expect(sql`update kernel.mail_log set body_hash = ${"0".repeat(64)} where id = ${row!.id}`).rejects.toThrow(/mail_log_immutable/);
    await expect(sql`insert into kernel.mail_log (company_id, entity, record_id, event_id) values (${companyId}, 'nt.order', gen_random_uuid(), ${row!.event_id})`).rejects.toThrow(/duplicate key/);
  });
});
