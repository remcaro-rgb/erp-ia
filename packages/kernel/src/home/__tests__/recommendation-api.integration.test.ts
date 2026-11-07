import { randomUUID } from "node:crypto";
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

// The kernel recommendation API (design §22.28, plan 2B Task 38, migration 0123_kernel_recommendation_api): a registered create or update
// process raises a recommendation through ctx.recommendations for the holders of a process (or a role); one open row per subject and
// reason, a second raise merges; the viewer reads it through kernel.v_recommendations / kernel.recommendation.list with every param of a
// field they do not see masked and the subject only when they may consult it; it is dismissed through kernel.recommendation.decide
// (audited) and closed by the process that fixes its cause; closed and dismissed rows go 90 days later, at the company's next raise.

const doc = defineEntity({
  entityType: "maestro",
  id: "recprobe.doc",
  module: "recprobe",
  schema: "recprobe",
  table: "docs",
  label: "entity.recprobe.doc",
  displayField: "number",
  defaultSort: { field: "number", dir: "asc" },
  fields: [
    { name: "number", type: "text", label: "field.recprobe.number" },
    { name: "amount", type: "number", label: "field.recprobe.amount" },
  ],
});

const flagInput = z.object({
  id: z.uuid(),
  reason: z.string().default("late"),
  number: z.string().default("DOC-1"),
  amount: z.number().default(1500),
  /** A param naming a field the entity does not have (refused: a typo must not leak). */
  badField: z.boolean().default(false),
  toRole: z.uuid().optional(),
});
const flag = defineProcess({
  id: "recprobe.doc.flag",
  module: "recprobe",
  kind: "update",
  recordAccess: "none",
  description: "Marca un documento de prueba con una recomendación",
  input: flagInput,
  output: z.object({ id: z.string(), merged: z.boolean() }),
  handler: async (ctx, input) =>
    ctx.recommendations!.raise({
      ...(input.toRole ? { audienceRoleId: input.toRole } : { audienceProcess: "recprobe.doc.flag" }),
      subject: { entity: "recprobe.doc", id: input.id },
      reason: input.reason,
      titleKey: "recprobe.flag.title",
      bodyKey: "recprobe.flag.body",
      params: {
        number: { value: input.number, entity: "recprobe.doc", field: "number" },
        amount: { value: input.amount, entity: "recprobe.doc", field: input.badField ? "amout" : "amount" },
        note: { value: "sin campo" },
      },
    }),
});
const fix = defineProcess({
  id: "recprobe.doc.fix",
  module: "recprobe",
  kind: "update",
  recordAccess: "none",
  description: "Corrige un documento de prueba",
  input: z.object({ id: z.uuid(), reason: z.string().optional() }),
  output: z.object({ closed: z.number() }),
  handler: async (ctx, input) => ctx.recommendations!.close({ subject: { entity: "recprobe.doc", id: input.id }, ...(input.reason ? { reason: input.reason } : {}) }),
});
const consultDoc = defineProcess({
  id: "recprobe.doc.consult",
  module: "recprobe",
  kind: "consult",
  description: "Consulta un documento de prueba",
  input: z.object({}),
  output: z.object({}),
  handler: async () => ({}),
});
/** A consult that tries to raise: refused (a consult changes nothing). */
const peek = defineProcess({
  id: "recprobe.doc.peek",
  module: "recprobe",
  kind: "consult",
  description: "Consulta que intenta recomendar",
  input: z.object({ id: z.uuid() }),
  output: z.object({ id: z.string(), merged: z.boolean() }),
  handler: async (ctx, input) =>
    ctx.recommendations!.raise({ audienceProcess: "recprobe.doc.flag", subject: { entity: "recprobe.doc", id: input.id }, reason: "late", titleKey: "t", bodyKey: "b" }),
});

const probe = defineModule({
  id: "recprobe",
  version: "0.0.1",
  dependsOn: [],
  entities: [doc],
  processes: [flag, fix, consultDoc, peek],
  features: [{ id: "recprobe.docs", label: "feature.recprobe.docs", processes: [flag.id, fix.id, consultDoc.id, peek.id], entities: ["recprobe.doc"] }],
  events: { emits: [], consumes: {} },
  navigation: [],
});

interface ListOut {
  total: number;
  recommendations: { id: string; source: string; module: string | null; reason: string | null; titleKey: string | null; params: Record<string, unknown>; subject: { entity: string; id: string } | null; occurrences: number; title: string }[];
}

describe("kernel recommendation API (0123)", () => {
  let sql: ReturnType<typeof testDb>;
  let seed: Awaited<ReturnType<typeof seedTenant>>;
  let registry: Registry;
  let companyA: string;
  let companyB: string;
  let admin: Caller;
  let adminInB: Caller;
  /** Holds recprobe.doc.flag (the audience) and may consult the document. */
  let viewer: Caller;
  /** Holds recprobe.doc.flag, sees the amount masked and may not consult the document. */
  let masked: Caller;
  /** Holds neither the process nor the role. */
  let outsider: Caller;
  let roleViewer: string;
  const run = <T = unknown>(caller: Caller, id: string, input: unknown = {}) => runProcess({ sql, registry }, caller, id, input) as Promise<T>;
  const list = (caller: Caller, input: unknown = {}) => run<ListOut>(caller, "kernel.recommendation.list", input);
  const rows = (subject: string) =>
    sql<{ id: string; seq: string; status: string; occurrences: number; source: string; module: string; audience_process_id: string; reason: string; last_raised_at: Date; created_at: Date; closed_reason: string | null }[]>`
      select id, seq::text, status, occurrences, source, module, audience_process_id, reason, last_raised_at, created_at, closed_reason
      from kernel.recommendations r where subject_id = ${subject} order by r.seq`;
  const rollback = new Error("rollback");
  /** Runs `fn` as `caller` (authenticated, the claims set), optionally attributed to `processId` as runProcess does; rolled back. */
  async function asUser<T>(caller: Caller, processId: string | null, fn: (tx: Tx) => Promise<T>): Promise<T> {
    let out: T | undefined;
    await sql.begin(async (tx) => {
      await tx`select set_config('request.jwt.claims', ${JSON.stringify({ role: "authenticated", ...caller.claims })}, true), set_config('role', 'authenticated', true)`;
      if (processId) await tx`select set_config('erp.audit_process_id', ${processId}, true)`;
      out = await fn(tx as unknown as Tx);
      throw rollback;
    }).catch((e: unknown) => {
      if (e !== rollback) throw e;
    });
    return out as T;
  }

  beforeAll(async () => {
    sql = testDb();
    seed = await seedTenant(sql, {
      companies: 2,
      entitlements: ["module:recprobe"],
      users: [
        { name: "viewer", companies: [0], role: "member" },
        { name: "masked", companies: [0], role: "member" },
        { name: "outsider", companies: [0], role: "member" },
      ],
    });
    companyA = seed.companies[0]!.id;
    companyB = seed.companies[1]!.id;
    registry = new Registry();
    loadModules(registry, [kernelModule, probe]);
    await syncModuleManifest(sql, probe);

    const role = async (name: string) => (await sql<{ id: string }[]>`insert into kernel.roles(company_id, name, is_system) values (${companyA}, ${name}, false) returning id`)[0]!.id;
    const grant = (company: string, roleId: string, processId: string) =>
      sql`insert into kernel.process_permissions(company_id, role_id, process_id) values (${company}, ${roleId}, ${processId}) on conflict do nothing`;
    roleViewer = await role("Facturación");
    const roleMasked = await role("Facturación sin montos");
    const rolePlain = await role("Bodega");
    const callerWith = async (user: string, roleId: string): Promise<Caller> => {
      await seed.holdRoles(user, companyA, [roleId]);
      return { claims: { ...seed.claimsFor(user, companyA), role_ids: [roleId] } as JwtClaims, origin: "ui" };
    };
    viewer = await callerWith(seed.users.viewer!, roleViewer);
    masked = await callerWith(seed.users.masked!, roleMasked);
    outsider = await callerWith(seed.users.outsider!, rolePlain);
    admin = { claims: seed.claimsFor(seed.users.both, companyA), origin: "ui" };
    adminInB = { claims: seed.claimsFor(seed.users.both, companyB), origin: "ui" };

    for (const roleId of [roleViewer, roleMasked, rolePlain]) {
      for (const id of ["kernel.recommendation.list", "kernel.recommendation.decide"]) await grant(companyA, roleId, id);
    }
    for (const [company, roleId] of [[companyA, seed.companies[0]!.adminRoleId], [companyB, seed.companies[1]!.adminRoleId]] as const) {
      for (const id of ["kernel.recommendation.list", "kernel.recommendation.decide", flag.id, fix.id, consultDoc.id, peek.id]) await grant(company, roleId, id);
    }
    await grant(companyA, roleViewer, flag.id);
    await grant(companyA, roleViewer, consultDoc.id);
    await grant(companyA, roleMasked, flag.id);
    await sql`insert into kernel.field_permissions(company_id, role_id, entity, field, mode) values (${companyA}, ${roleMasked}, 'recprobe.doc', 'amount', 'masked')`;
  });
  afterAll(async () => {
    await sql`delete from kernel.recommendations where company_id = any(${[companyA, companyB]}::uuid[])`;
    await sql`delete from kernel.audit_log where company_id = any(${[companyA, companyB]}::uuid[]) and entity like 'kernel.recommendation%'`.catch(() => undefined);
    await sql`delete from kernel.process_permissions where company_id = any(${[companyA, companyB]}::uuid[])`;
    await seed.cleanup();
    await sql`delete from kernel.registered_processes where module_id = 'recprobe'`;
    await sql`delete from kernel.module_features where module_id = 'recprobe'`;
    await sql.end();
  });

  describe("raise", () => {
    it("opens one new process row for the audience process, with the raising module and a gap-free seq", async () => {
      const subject = randomUUID();
      const out = await run<{ id: string; merged: boolean }>(admin, flag.id, { id: subject });
      expect(out.merged).toBe(false);
      const [row] = await rows(subject);
      expect(row).toMatchObject({ id: out.id, status: "new", source: "process", module: "recprobe", audience_process_id: "recprobe.doc.flag", reason: "late", occurrences: 1 });
      const [prev] = await sql<{ max: string }[]>`select max(seq)::text as max from kernel.recommendations where company_id = ${companyA} and id <> ${out.id}`;
      expect(Number(row!.seq)).toBe(Number(prev!.max ?? 0) + 1);
    });

    it("the same subject and reason merges: one row, occurrences 2, same id and seq, last_raised_at moved, params refreshed", async () => {
      const subject = randomUUID();
      const first = await run<{ id: string }>(admin, flag.id, { id: subject, number: "DOC-1" });
      const [before] = await rows(subject);
      const second = await run<{ id: string; merged: boolean }>(admin, flag.id, { id: subject, number: "DOC-2" });
      expect(second).toEqual({ id: first.id, merged: true });
      const after = await rows(subject);
      expect(after).toHaveLength(1);
      expect(after[0]).toMatchObject({ id: first.id, seq: before!.seq, occurrences: 2 });
      expect(after[0]!.last_raised_at.getTime()).toBeGreaterThan(before!.last_raised_at.getTime());
      const [top] = await sql<{ max: string }[]>`select max(seq)::text as max from kernel.recommendations where company_id = ${companyA}`;
      expect(top!.max).toBe(before!.seq);
      const mine = (await list(viewer)).recommendations.find((r) => r.id === first.id)!;
      expect(mine.params.number).toBe("DOC-2");
      expect(mine.occurrences).toBe(2);
    });

    it("another reason of the same subject opens a second row", async () => {
      const subject = randomUUID();
      await run(admin, flag.id, { id: subject, reason: "late" });
      await run(admin, flag.id, { id: subject, reason: "missing_data" });
      expect((await rows(subject)).map((r) => r.reason)).toEqual(["late", "missing_data"]);
    });

    it("two concurrent raises of the same key leave one row with both occurrences", async () => {
      const subject = randomUUID();
      const outs = await Promise.all([run<{ id: string }>(admin, flag.id, { id: subject }), run<{ id: string }>(admin, flag.id, { id: subject })]);
      expect(outs[0]!.id).toBe(outs[1]!.id);
      expect((await rows(subject)).map((r) => r.occurrences)).toEqual([2]);
    });

    it("is refused from a consult process, outside a run, under another process's name, and with a param field the entity lacks", async () => {
      const subject = randomUUID();
      await expect(run(admin, peek.id, { id: subject })).rejects.toMatchObject({ code: "forbidden" });
      await expect(run(admin, flag.id, { id: subject, badField: true })).rejects.toMatchObject({ code: "invalid_input" });
      const raw = (tx: Tx, processId: string) =>
        tx`select * from kernel.recommendation_raise(${processId}, 'recprobe.doc.flag', null, 'recprobe.doc', ${subject}::uuid, 'late', 'k', 'b', '{}'::jsonb)`;
      // Plain SQL as the user, no process run.
      await expect(asUser(viewer, null, (tx) => raw(tx, "recprobe.doc.flag"))).rejects.toMatchObject({ code: "42501" });
      // A run of recprobe.doc.fix cannot raise as recprobe.doc.flag.
      await expect(asUser(viewer, "recprobe.doc.fix", (tx) => raw(tx, "recprobe.doc.flag"))).rejects.toMatchObject({ code: "42501" });
      // A consult may not raise even naming itself.
      await expect(asUser(viewer, "recprobe.doc.peek", (tx) => raw(tx, "recprobe.doc.peek"))).rejects.toMatchObject({ code: "42501" });
      // Users write no row directly: no insert, no delete grant.
      await expect(asUser(viewer, "recprobe.doc.flag", (tx) => tx`insert into kernel.recommendations (company_id, user_id, agent_profile, title, body) values (${companyA}, ${seed.users.viewer!}, 'x', 'x', 'x')`)).rejects.toMatchObject({ code: "42501" });
      await expect(asUser(viewer, "recprobe.doc.flag", (tx) => tx`delete from kernel.recommendations`)).rejects.toMatchObject({ code: "42501" });
      await expect(asUser(viewer, "recprobe.doc.flag", (tx) => tx`select kernel.recommendation_close('recprobe.doc.fix', 'recprobe.doc', ${subject}::uuid, null)`)).rejects.toMatchObject({ code: "42501" });
      expect(await rows(subject)).toEqual([]);
    });

    it("works inside a dry run and leaves nothing", async () => {
      const subject = randomUUID();
      const out = await runProcess({ sql, registry }, admin, flag.id, { id: subject }, { dryRun: true });
      expect(out).toMatchObject({ merged: false });
      expect(await rows(subject)).toEqual([]);
    });
  });

  describe("who sees what", () => {
    let subject: string;
    let id: string;
    beforeAll(async () => {
      subject = randomUUID();
      id = (await run<{ id: string }>(admin, flag.id, { id: subject, number: "FAC-77", amount: 98000 })).id;
    });

    it("the audience sees it in the list, the view and the table; a user without the process or the role sees nothing", async () => {
      expect((await list(viewer)).recommendations.map((r) => r.id)).toContain(id);
      expect((await list(outsider)).recommendations.map((r) => r.id)).not.toContain(id);
      const read = (caller: Caller, what: "view" | "table") =>
        asUser(caller, null, (tx) => (what === "view" ? tx`select id from kernel.v_recommendations where id = ${id}` : tx`select id from kernel.recommendations where id = ${id}`));
      expect(await read(viewer, "view")).toHaveLength(1);
      expect(await read(viewer, "table")).toHaveLength(1);
      expect(await read(outsider, "view")).toEqual([]);
      expect(await read(outsider, "table")).toEqual([]);
    });

    it("the total counts the caller's open rows, all of them, and the module filter narrows the list", async () => {
      const all = await list(viewer);
      const [open] = await asUser(viewer, null, (tx) => tx<{ n: number }[]>`select count(*)::int as n from kernel.v_recommendations where status = 'new'`);
      expect(all.total).toBe(open!.n);
      expect(all.total).toBeGreaterThan(0);
      const mine = await list(viewer, { module: "recprobe" });
      expect(mine.recommendations.every((r) => r.module === "recprobe")).toBe(true);
      expect((await list(viewer, { module: "nomodule" })).recommendations).toEqual([]);
      expect((await list(viewer, { module: "nomodule" })).total).toBe(0);
    });

    it("masks a param of a field the viewer does not see; the other viewer gets it", async () => {
      const shown = (await list(viewer)).recommendations.find((r) => r.id === id)!;
      expect(shown.params).toEqual({ number: "FAC-77", amount: 98000, note: "sin campo" });
      expect(shown).toMatchObject({ source: "process", module: "recprobe", reason: "late", titleKey: "recprobe.flag.title", subject: { entity: "recprobe.doc", id: subject } });
      const hidden = (await list(masked)).recommendations.find((r) => r.id === id)!;
      expect(hidden.params).toEqual({ number: "FAC-77", amount: null, note: "sin campo" });
      const [viewRow] = await asUser(masked, null, (tx) => tx<{ params: Record<string, { value: unknown }> }[]>`select params from kernel.v_recommendations where id = ${id}`);
      expect(viewRow!.params.amount!.value).toBeNull();
      expect(viewRow!.params.number!.value).toBe("FAC-77");
    });

    it("the subject is null for a viewer who may not consult it", async () => {
      expect((await list(masked)).recommendations.find((r) => r.id === id)!.subject).toBeNull();
    });

    it("the raw params and subject are not readable by users", async () => {
      for (const column of ["params", "subject_id", "subject_entity"]) {
        await expect(asUser(viewer, null, (tx) => tx.unsafe(`select ${column} from kernel.recommendations`)), column).rejects.toMatchObject({ code: "42501" });
      }
      // The safe reader answers nothing outside the audience.
      expect(await asUser(outsider, null, (tx) => tx`select * from kernel.recommendation_safe(${id}::uuid)`)).toEqual([]);
    });

    it("never crosses companies: the same subject id raised in another company is its own row", async () => {
      const other = (await run<{ id: string; merged: boolean }>(adminInB, flag.id, { id: subject })).id;
      expect(other).not.toBe(id);
      expect((await list(adminInB)).recommendations.map((r) => r.id)).not.toContain(id);
      expect((await list(admin)).recommendations.map((r) => r.id)).not.toContain(other);
      expect((await rows(subject)).map((r) => r.occurrences)).toEqual([1, 1]);
    });
  });

  describe("dismiss and close", () => {
    it("dismissing through kernel.recommendation.decide stamps the user, is audited, and the next raise opens a new row", async () => {
      const subject = randomUUID();
      const { id } = await run<{ id: string }>(admin, flag.id, { id: subject });
      await expect(run(outsider, "kernel.recommendation.decide", { id, decision: "dismissed" })).rejects.toMatchObject({ code: "not_found" });
      expect(await run(viewer, "kernel.recommendation.decide", { id, decision: "dismissed" })).toEqual({ id, status: "dismissed" });
      const [row] = await sql<{ status: string; decided_by: string }[]>`select status, decided_by from kernel.recommendations where id = ${id}`;
      expect(row).toEqual({ status: "dismissed", decided_by: seed.users.viewer });
      const audits = await sql<{ entity: string; action: string }[]>`
        select entity, action from kernel.audit_log where process_id = 'kernel.recommendation.decide' and row_id = ${id} order by occurred_at`;
      expect(audits.map((a) => a.entity)).toContain("kernel.recommendations");
      expect((await list(viewer)).recommendations.map((r) => r.id)).not.toContain(id);
      const again = await run<{ id: string; merged: boolean }>(admin, flag.id, { id: subject });
      expect(again.merged).toBe(false);
      expect(again.id).not.toBe(id);
    });

    it("close closes every open reason of the subject, or only the named one; the list drops them", async () => {
      const subject = randomUUID();
      const late = (await run<{ id: string }>(admin, flag.id, { id: subject, reason: "late" })).id;
      const missing = (await run<{ id: string }>(admin, flag.id, { id: subject, reason: "missing_data" })).id;
      expect(await run(admin, fix.id, { id: subject, reason: "late" })).toEqual({ closed: 1 });
      expect((await rows(subject)).map((r) => [r.reason, r.status, r.closed_reason])).toEqual([["late", "closed", "cause_fixed"], ["missing_data", "new", null]]);
      expect(await run(admin, fix.id, { id: subject })).toEqual({ closed: 1 });
      const ids = (await list(viewer)).recommendations.map((r) => r.id);
      expect(ids).not.toContain(late);
      expect(ids).not.toContain(missing);
      // A closed row is not dismissed later.
      await expect(run(viewer, "kernel.recommendation.decide", { id: late, decision: "dismissed" })).rejects.toMatchObject({ code: "handler_failed" });
    });
  });

  describe("retention", () => {
    it("a closed row older than 90 days goes at the company's next raise, not at another company's", async () => {
      const subject = randomUUID();
      const { id } = await run<{ id: string }>(admin, flag.id, { id: subject });
      await run(admin, fix.id, { id: subject });
      const fresh = randomUUID();
      const recent = (await run<{ id: string }>(admin, flag.id, { id: fresh })).id;
      await run(admin, fix.id, { id: fresh });
      await sql`update kernel.recommendations set closed_at = now() - interval '91 days' where id = ${id}`;
      await run(adminInB, flag.id, { id: randomUUID() });
      expect(await sql`select 1 from kernel.recommendations where id = ${id}`).toHaveLength(1);
      await run(admin, flag.id, { id: randomUUID() });
      expect(await sql`select 1 from kernel.recommendations where id = ${id}`).toHaveLength(0);
      expect(await sql`select 1 from kernel.recommendations where id = ${recent}`).toHaveLength(1);
      expect(await sql`select action from kernel.audit_log where entity = 'kernel.recommendations' and row_id = ${id} and action = 'delete'`).toHaveLength(1);
    });
  });

  describe("agent rows", () => {
    it("a row the service role writes for a role still lists and decides as before", async () => {
      const [row] = await sql<{ id: string }[]>`
        insert into kernel.recommendations (company_id, audience_role_id, agent_profile, title, body)
        values (${companyA}, ${roleViewer}, 'seed', 'Sugerencia de agente', 'Cuerpo') returning id`;
      const listed = (await list(viewer)).recommendations.find((r) => r.id === row!.id)!;
      expect(listed).toMatchObject({ source: "agent", title: "Sugerencia de agente", module: null, subject: null, params: {} });
      expect((await list(masked)).recommendations.map((r) => r.id)).not.toContain(row!.id);
      expect(await run(viewer, "kernel.recommendation.decide", { id: row!.id, decision: "accepted" })).toEqual({ id: row!.id, status: "accepted" });
    });
  });
});
