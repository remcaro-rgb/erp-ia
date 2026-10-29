import { afterAll, beforeAll, describe, expect, it, vi, type MockInstance } from "vitest";
import { z } from "zod";
import { withClaims } from "../../db/client";
import { seedTenant, testDb } from "../../db/test-db";
import { defineModule } from "../../module/define";
import { defineEntity } from "../../registry";
import { maskedViewSql } from "../../security/masked-views";
import { kernelModule } from "../../module/kernel-module";
import { loadModules } from "../../module/loader";
import type { Caller } from "../../process/context";
import { defineProcess } from "../../process/define";
import { runProcess } from "../../process/run";
import { Registry } from "../../registry";
import type { HomeKpiProvider } from "../../registry/types";

// The home screen's server side (design §19a, §7.5, Task 20), migration 0022_kernel_recommendations:
//  * kernel.home.kpis returns the KPIs of the registered providers whose feature the company is entitled to, computed
//    as the caller (RLS), and only to a caller allowed the provider's consult process;
//  * kernel.recommendation.list / .decide: a recommendation is visible to the holders of its audience role and to the
//    user it targets; it changes only through .decide; an accepted suggested action comes back to open in the assistant;
//  * kernel.home.recent lists the records the caller last touched, titled through the entity's masked view.

const consultOf = (id: string) =>
  defineProcess({ id, module: "probe", kind: "consult", description: "Consulta de prueba", input: z.object({}), output: z.object({}), handler: async () => ({}) });
/** The grid's own consult of the probe entity, and a report consult a KPI provider can be gated on. */
const consult = consultOf("probe.thing.consult");
const reportConsult = consultOf("probe.report.consult");
const createOf = (id: string, module: string) =>
  defineProcess({ id, module, kind: "create", description: "Alta de prueba", input: z.object({}), output: z.object({}), handler: async () => ({}) });
const createThing = createOf("probe.thing.create", "probe");
const createOther = createOf("other.thing.create", "other");

const thing = defineEntity({
  id: "probe.thing",
  module: "probe",
  schema: "probe",
  table: "things",
  label: "entity.probe.thing",
  displayField: "name",
  defaultSort: { field: "name", dir: "asc" },
  fields: [{ name: "name", type: "text", label: "field.probe.name" }],
});

/** Counts the caller's own preference rows: what it returns depends on who runs it (RLS). */
const prefsCount: HomeKpiProvider = {
  id: "probe.prefs",
  feature: "probe.things",
  compute: async (ctx) => {
    const [row] = await ctx.tx<{ n: number }[]>`select count(*)::int as n from kernel.user_prefs`;
    return [{ id: "probe.prefs", label: "home.kpi.probe", value: row!.n, unit: "count" }];
  },
};
const gated: HomeKpiProvider = {
  id: "probe.gated",
  feature: "probe.things",
  consult: "probe.report.consult",
  compute: async () => [{ id: "probe.gated", label: "home.kpi.probe", value: 1, unit: "count" }],
};
const broken: HomeKpiProvider = {
  id: "probe.broken",
  feature: "probe.things",
  compute: async (ctx) => {
    await ctx.tx`select 1 / 0`;
    return [];
  },
};
const notEntitled: HomeKpiProvider = {
  id: "other.beta",
  feature: "other.beta",
  compute: async () => [{ id: "other.beta", label: "home.kpi.probe", value: 99, unit: "count" }],
};

const probeModule = defineModule({
  id: "probe",
  version: "0.0.1",
  dependsOn: [],
  entities: [thing],
  processes: [consult, reportConsult, createThing],
  features: [{ id: "probe.things", label: "feature.probe.things", processes: [consult.id, reportConsult.id, createThing.id], entities: ["probe.thing"] }],
  events: { emits: [], consumes: {} },
  navigation: [],
  homeKpis: [prefsCount, gated, broken],
});
const otherModule = defineModule({
  id: "other",
  version: "0.0.1",
  dependsOn: [],
  entities: [],
  processes: [createOther],
  features: [{ id: "other.beta", label: "feature.other.beta", processes: [createOther.id], entities: [] }],
  events: { emits: [], consumes: {} },
  navigation: [],
  homeKpis: [notEntitled],
});

type Rec = { id: string; status: string; title: string };

describe("home screen processes", () => {
  let sql: ReturnType<typeof testDb>;
  let seed: Awaited<ReturnType<typeof seedTenant>>;
  let registry: Registry;
  let companyA: string;
  let companyB: string;
  let admin: Caller;
  let adminInB: Caller;
  let cashier: Caller;
  let clerk: Caller;
  const run = <T = unknown>(caller: Caller, id: string, input: unknown = {}) => runProcess({ sql, registry }, caller, id, input) as Promise<T>;
  const grant = (companyId: string, roleId: string, processId: string) =>
    sql`insert into kernel.process_permissions(company_id, role_id, process_id) values (${companyId}, ${roleId}, ${processId}) on conflict do nothing`;

  const insertRec = async (companyId: string, title: string, to: { role?: string; user?: string }, actions: unknown = []) => {
    const [row] = await sql<{ id: string }[]>`
      insert into kernel.recommendations (company_id, audience_role_id, user_id, agent_profile, title, body, evidence, suggested_actions, confidence)
      values (${companyId}, ${to.role ?? null}, ${to.user ?? null}, 'seed', ${title}, ${`Cuerpo de ${title}`}, ${sql.json({ rows: 3 })}, ${sql.json(actions as never)}, 0.8)
      returning id`;
    return row!.id;
  };

  let recMember: string;
  let recAdmin: string;
  let recCashier: string;
  let recOtherCompany: string;
  let recNav: string;
  let recForbidden: string;
  let recUnentitled: string;
  let recUnknown: string;
  /** The broken provider's failure is logged (and expected): keep it out of the test output. */
  let logged: MockInstance;

  beforeAll(async () => {
    logged = vi.spyOn(console, "error").mockImplementation(() => {});
    sql = testDb();
    seed = await seedTenant(sql, {
      companies: 2,
      entitlements: ["module:probe"],
      users: [
        { name: "cashier", companies: [0], role: "member" },
        { name: "clerk", companies: [0], role: "member" },
      ],
    });
    companyA = seed.companies[0]!.id;
    companyB = seed.companies[1]!.id;
    registry = new Registry();
    loadModules(registry, [kernelModule, probeModule, otherModule]);
    admin = { claims: seed.claimsFor(seed.users.both, companyA), origin: "ui" };
    adminInB = { claims: seed.claimsFor(seed.users.both, companyB), origin: "ui" };
    cashier = { claims: seed.claimsFor(seed.users.cashier!, companyA), origin: "ui" };
    clerk = { claims: seed.claimsFor(seed.users.clerk!, companyA), origin: "ui" };

    for (const [company, roleId] of [
      [companyA, seed.companies[0]!.adminRoleId],
      [companyA, seed.companies[0]!.memberRoleId],
      [companyB, seed.companies[1]!.adminRoleId],
    ] as const) {
      for (const id of ["kernel.home.kpis", "kernel.home.recent", "kernel.recommendation.list", "kernel.recommendation.decide"]) await grant(company, roleId, id);
    }
    await grant(companyA, seed.companies[0]!.adminRoleId, "probe.report.consult");
    await grant(companyA, seed.companies[0]!.memberRoleId, "probe.thing.consult");
    // The member role may create things (what recMember suggests) and, but for the entitlement, the other module's too.
    await grant(companyA, seed.companies[0]!.memberRoleId, "probe.thing.create");
    await grant(companyA, seed.companies[0]!.memberRoleId, "other.thing.create");

    // The probe entity's table and masked read view (the processes read records through the view, rule 14).
    await sql`create schema if not exists probe`;
    await sql`create table probe.things (id uuid primary key default gen_random_uuid(), company_id uuid not null, name text)`;
    await sql`alter table probe.things enable row level security`;
    await sql`create policy company on probe.things for all to authenticated using (company_id = (select kernel.current_company_id()))`;
    await sql`grant usage on schema probe to authenticated`;
    await sql`grant select on probe.things to authenticated`;
    await sql.unsafe(maskedViewSql(registry.entity("probe.thing")));

    recMember = await insertRec(
      companyA,
      "Para el rol miembro",
      { role: seed.companies[0]!.memberRoleId },
      [{ label: "Crear el producto", processId: "probe.thing.create", input: { name: "Café molido" } }],
    );
    recAdmin = await insertRec(companyA, "Para el administrador", { role: seed.companies[0]!.adminRoleId });
    recCashier = await insertRec(companyA, "Para la cajera", { user: seed.users.cashier! });
    recOtherCompany = await insertRec(companyB, "De otra empresa", { role: seed.companies[1]!.adminRoleId });
    // Actions the audience may not take: a process its role cannot run, one of a module the company does not have, one nobody registered.
    const toMembers = { role: seed.companies[0]!.memberRoleId };
    recForbidden = await insertRec(companyA, "Acción sin permiso", toMembers, [{ label: "Ver el reporte", processId: "probe.report.consult", input: {} }]);
    recUnentitled = await insertRec(companyA, "Acción de otro módulo", toMembers, [{ label: "Crear en el otro", processId: "other.thing.create", input: {} }]);
    recUnknown = await insertRec(companyA, "Acción inexistente", toMembers, [{ label: "Hacer algo", processId: "probe.nothing.create", input: {} }]);
    recNav = await insertRec(companyA, "Ir al listado", { user: seed.users.clerk! }, [{ label: "Ver terceros", href: "/parties" }]);

    // Preferences: the cashier has two rows, the clerk none.
    for (const key of ["theme", "tabs"]) await run(cashier, "kernel.user_prefs.set", { key, value: key });
  });
  afterAll(async () => {
    logged.mockRestore();
    await sql`drop schema if exists probe cascade`;
    await sql`delete from kernel.user_prefs where company_id = any(${[companyA, companyB]}::uuid[])`;
    await sql`delete from kernel.process_permissions where company_id = any(${[companyA, companyB]}::uuid[])`;
    await seed.cleanup();
    await sql.end();
  });

  describe("kernel.home.kpis", () => {
    it("returns the KPIs of the providers whose feature is entitled, none of the others", async () => {
      const { kpis } = await run<{ kpis: { id: string }[] }>(admin, "kernel.home.kpis");
      const ids = kpis.map((k) => k.id);
      expect(ids).toContain("probe.prefs");
      expect(ids).toContain("kernel.ai_tokens");
      expect(ids).not.toContain("other.beta");
      // The modules' numbers first, the platform's own (AI usage) last.
      expect(ids.at(-1)).toBe("kernel.ai_tokens");
    });

    it("computes each KPI as the caller", async () => {
      const value = async (caller: Caller) => (await run<{ kpis: { id: string; value: number }[] }>(caller, "kernel.home.kpis")).kpis.find((k) => k.id === "probe.prefs")?.value;
      expect(await value(cashier)).toBe(2);
      expect(await value(clerk)).toBe(0);
    });

    it("leaves out a provider whose consult process the caller's roles may not run", async () => {
      const idsOf = async (caller: Caller) => (await run<{ kpis: { id: string }[] }>(caller, "kernel.home.kpis")).kpis.map((k) => k.id);
      expect(await idsOf(admin)).toContain("probe.gated");
      expect(await idsOf(cashier)).not.toContain("probe.gated");
    });

    it("a provider that fails does not take the other KPIs down", async () => {
      logged.mockClear();
      const { kpis } = await run<{ kpis: { id: string }[] }>(cashier, "kernel.home.kpis");
      expect(kpis.map((k) => k.id)).not.toContain("probe.broken");
      expect(kpis.map((k) => k.id)).toContain("probe.prefs");
      expect(logged).toHaveBeenCalledWith(expect.stringContaining("probe.broken"), expect.anything());
    });

    describe("series of the AI usage card", () => {
      type Card = { id: string; unit: string; series?: number[] };
      const card = async (caller: Caller) => (await run<{ kpis: Card[] }>(caller, "kernel.home.kpis")).kpis.find((k) => k.id === "kernel.ai_tokens")!;
      /** `tokens` input+output used `daysAgo` days ago (company-local day, at `time`) by `user` in `company`. */
      const usage = (company: string, user: string, daysAgo: number, time: string, input: number, output: number) =>
        sql`insert into kernel.llm_usage (company_id, user_id, task, provider, model, input_tokens, output_tokens, created_at)
            values (${company}, ${user}, 'chat', 'test', 'test', ${input}, ${output},
                    (((now() at time zone 'America/Bogota')::date - ${daysAgo}::int + ${time}::time) at time zone 'America/Bogota'))`;

      beforeAll(async () => {
        await usage(companyA, seed.users.cashier!, 2, "10:00", 100, 50);
        await usage(companyA, seed.users.cashier!, 2, "15:00", 10, 5);
        // 23:30 in Bogota is already the next day in UTC: it still belongs to the company's day.
        await usage(companyA, seed.users.clerk!, 1, "23:30", 400, 100);
        await usage(companyA, seed.users.cashier!, 13, "00:30", 7, 3);
        // Older than the window, and another company's: neither counts.
        await usage(companyA, seed.users.cashier!, 14, "12:00", 999, 1);
        await usage(companyB, seed.users.both, 2, "12:00", 5000, 5000);
      });

      const expected = (byDaysAgo: Record<number, number>) => Array.from({ length: 14 }, (_, i) => byDaysAgo[13 - i] ?? 0);

      it("is 14 daily token totals of the company for its admin, oldest first, by the company's own days", async () => {
        const kpi = await card(admin);
        expect(kpi.series).toHaveLength(14);
        expect(kpi.series).toEqual(expected({ 2: 165, 1: 500, 13: 10 }));
      });

      it("is the caller's own tokens for anyone else (the usage view shows them only their rows)", async () => {
        expect((await card(cashier)).series).toEqual(expected({ 2: 165, 13: 10 }));
        expect((await card(clerk)).series).toEqual(expected({ 1: 500 }));
      });

      it("stays in the other company for its admin", async () => {
        expect((await card(adminInB)).series).toEqual(expected({ 2: 10000 }));
      });
    });

    it("is refused to a role without the permission, like any consult", async () => {
      await sql`delete from kernel.process_permissions where company_id = ${companyA} and role_id = ${seed.companies[0]!.memberRoleId} and process_id = 'kernel.home.kpis'`;
      await expect(run(cashier, "kernel.home.kpis")).rejects.toMatchObject({ code: "forbidden" });
      await grant(companyA, seed.companies[0]!.memberRoleId, "kernel.home.kpis");
    });
  });

  describe("kernel.recommendation.list", () => {
    const titles = async (caller: Caller) => (await run<{ recommendations: Rec[] }>(caller, "kernel.recommendation.list")).recommendations.map((r) => r.title).sort();

    it("shows a recommendation to the holders of its audience role and to the user it targets, newest first", async () => {
      expect(await titles(cashier)).toEqual(["Acción de otro módulo", "Acción inexistente", "Acción sin permiso", "Para el rol miembro", "Para la cajera"]);
      expect(await titles(clerk)).toEqual(["Acción de otro módulo", "Acción inexistente", "Acción sin permiso", "Ir al listado", "Para el rol miembro"]);
      expect(await titles(admin)).toEqual(["Para el administrador"]);
      const { recommendations } = await run<{ recommendations: (Rec & { suggestedActions: unknown[] })[] }>(cashier, "kernel.recommendation.list");
      expect(recommendations.map((r) => r.title)).toContain("Para la cajera");
      const created = recommendations.map((r) => r.id);
      expect(created.indexOf(recNav)).toBe(-1);
      expect(recommendations.find((r) => r.id === recMember)!.suggestedActions).toEqual([
        { label: "Crear el producto", processId: "probe.thing.create", input: { name: "Café molido" } },
      ]);
    });

    it("never crosses companies: the same admin sees the other company's recommendation only there", async () => {
      expect(await titles(adminInB)).toEqual(["De otra empresa"]);
      expect(await titles(admin)).not.toContain("De otra empresa");
    });

    it("lists only recommendations that are still new", async () => {
      const id = await insertRec(companyA, "Ya descartada", { user: seed.users.cashier! });
      await sql`update kernel.recommendations set status = 'dismissed', decided_at = now() where id = ${id}`;
      expect(await titles(cashier)).not.toContain("Ya descartada");
    });
  });

  describe("kernel.recommendation.decide", () => {
    it("accepting a suggested action returns the process and input for the assistant to confirm, and records who decided", async () => {
      const result = await run<{ id: string; status: string; open?: { processId: string; input: unknown } }>(cashier, "kernel.recommendation.decide", { id: recMember, decision: "accepted" });
      expect(result).toEqual({ id: recMember, status: "accepted", open: { processId: "probe.thing.create", input: { name: "Café molido" } } });
      const [row] = await sql`select status, decided_by, decided_at from kernel.recommendations where id = ${recMember}`;
      expect(row).toMatchObject({ status: "accepted", decided_by: seed.users.cashier });
      expect(row!.decided_at).toBeInstanceOf(Date);
      const audits = await sql`select action, origin from kernel.audit_log where process_id = 'kernel.recommendation.decide' and row_id = ${recMember}`;
      expect(audits.length).toBeGreaterThan(0);
    });

    it("an accepted recommendation leaves the inbox for everyone with the role", async () => {
      const { recommendations } = await run<{ recommendations: Rec[] }>(clerk, "kernel.recommendation.list");
      expect(recommendations.map((r) => r.id)).not.toContain(recMember);
    });

    it("repeating the same decision is harmless, keeps the first decision's time and does not open the assistant again", async () => {
      const [before] = await sql`select decided_at from kernel.recommendations where id = ${recMember}`;
      const again = await run<{ status: string; open?: unknown }>(cashier, "kernel.recommendation.decide", { id: recMember, decision: "accepted" });
      expect(again).toEqual({ id: recMember, status: "accepted" });
      // Somebody else of the audience accepting later gets the same: the first to accept took the action.
      expect(await run(clerk, "kernel.recommendation.decide", { id: recMember, decision: "accepted" })).toEqual({ id: recMember, status: "accepted" });
      const [after] = await sql`select decided_at from kernel.recommendations where id = ${recMember}`;
      expect(after!.decided_at).toEqual(before!.decided_at);
    });

    it("a different decision after the first is refused", async () => {
      await expect(run(cashier, "kernel.recommendation.decide", { id: recMember, decision: "dismissed" })).rejects.toMatchObject({ code: "handler_failed" });
      const [row] = await sql`select status from kernel.recommendations where id = ${recMember}`;
      expect(row!.status).toBe("accepted");
    });

    it("dismissing returns no action; an action with a link returns the link", async () => {
      expect(await run(cashier, "kernel.recommendation.decide", { id: recCashier, decision: "dismissed" })).toEqual({ id: recCashier, status: "dismissed" });
      expect(await run(clerk, "kernel.recommendation.decide", { id: recNav, decision: "accepted" })).toEqual({ id: recNav, status: "accepted", href: "/parties" });
    });

    it("an accepted process action the caller may not run is refused and the recommendation is not consumed", async () => {
      const status = async (id: string) => (await sql`select status from kernel.recommendations where id = ${id}`)[0]!.status;
      // No role of the cashier may run probe.report.consult.
      await expect(run(cashier, "kernel.recommendation.decide", { id: recForbidden, decision: "accepted" })).rejects.toMatchObject({ code: "forbidden" });
      // The company has no entitlement to the other module.
      await expect(run(cashier, "kernel.recommendation.decide", { id: recUnentitled, decision: "accepted" })).rejects.toMatchObject({ code: "not_entitled" });
      // Nobody registered the process.
      await expect(run(cashier, "kernel.recommendation.decide", { id: recUnknown, decision: "accepted" })).rejects.toMatchObject({ code: "invalid_input" });
      for (const id of [recForbidden, recUnentitled, recUnknown]) expect(await status(id)).toBe("new");
      // Dismissing needs no permission to the action.
      expect(await run(cashier, "kernel.recommendation.decide", { id: recForbidden, decision: "dismissed" })).toEqual({ id: recForbidden, status: "dismissed" });
    });

    it("a recommendation the caller cannot see is not found; an action number out of range is invalid", async () => {
      await expect(run(cashier, "kernel.recommendation.decide", { id: recAdmin, decision: "dismissed" })).rejects.toMatchObject({ code: "not_found" });
      await expect(run(cashier, "kernel.recommendation.decide", { id: recOtherCompany, decision: "dismissed" })).rejects.toMatchObject({ code: "not_found" });
      await expect(run(admin, "kernel.recommendation.decide", { id: recAdmin, decision: "accepted", action: 3 })).rejects.toMatchObject({ code: "invalid_input" });
      const [row] = await sql`select status from kernel.recommendations where id = ${recAdmin}`;
      expect(row!.status).toBe("new");
    });

    it("a recommendation changes only through the process: a bare statement as the user changes nothing, inserts are refused", async () => {
      const changed = await withClaims(sql, cashier.claims, (tx) => tx`update kernel.recommendations set status = 'dismissed' where id = ${recAdmin} returning id`);
      expect(changed).toHaveLength(0);
      await expect(
        withClaims(sql, cashier.claims, (tx) => tx`insert into kernel.recommendations (company_id, agent_profile, title, body, user_id) values (${companyA}, 'x', 'x', 'x', ${seed.users.cashier!})`),
      ).rejects.toThrow();
    });

    it("the read view shows the same rows the list does and never another company's", async () => {
      const rows = await withClaims(sql, clerk.claims, (tx) => tx<{ id: string }[]>`select id from kernel.v_recommendations`);
      const ids = rows.map((r) => r.id);
      expect(ids).toContain(recNav);
      expect(ids).not.toContain(recOtherCompany);
      expect(ids).not.toContain(recAdmin);
    });
  });

  describe("kernel.home.recent", () => {
    let things: string[];
    const audit = (actor: string, entity: string, rowId: string, action: string, processId: string | null, at: string) =>
      sql`insert into kernel.audit_log (company_id, occurred_at, actor_user_id, origin, process_id, entity, row_id, action, chain_id)
          values (${companyA}, ${at}, ${actor}, 'ui', ${processId}, ${entity}, ${rowId}, ${action}, gen_random_uuid())`;

    beforeAll(async () => {
      const thing = async (company: string, name: string) => {
        const [row] = await sql<{ id: string }[]>`insert into probe.things (company_id, name) values (${company}, ${name}) returning id`;
        return row!.id;
      };
      // The third belongs to the other company: the cashier's view cannot see it.
      things = [await thing(companyA, "Café molido"), await thing(companyA, "Café en grano"), await thing(companyB, "De otra empresa")];
      const cashierId = seed.users.cashier!;
      // Row-change entries (<schema>.<table>) written inside a process: what the user touched.
      await audit(cashierId, "probe.things", things[0]!, "insert", "probe.thing.create", "2026-10-28T10:00:00Z");
      await audit(cashierId, "probe.things", things[1]!, "insert", "probe.thing.create", "2026-10-28T11:00:00Z");
      // The same record touched again later: listed once, with the later time.
      await audit(cashierId, "probe.things", things[0]!, "update", "probe.thing.update", "2026-10-28T12:00:00Z");
      // Not touches: a consult, a direct database edit (no process), an entity nobody registered.
      await audit(cashierId, "probe.things", things[1]!, "consult", "probe.thing.consult", "2026-10-28T13:00:00Z");
      await audit(cashierId, "probe.things", things[1]!, "update", null, "2026-10-28T13:30:00Z");
      await audit(cashierId, "probe.unknowns", things[1]!, "update", "probe.thing.update", "2026-10-28T13:45:00Z");
      // A record the cashier touched but cannot see now.
      await audit(cashierId, "probe.things", things[2]!, "update", "probe.thing.update", "2026-10-28T14:00:00Z");
      // Somebody else's touch.
      await audit(seed.users.clerk!, "probe.things", things[1]!, "update", "probe.thing.update", "2026-10-28T15:00:00Z");
    });

    it("lists the records the caller touched, newest first, once each, titled through the entity's masked view", async () => {
      const { records } = await run<{ records: { entity: string; id: string; title: string | null; action: string; at: string }[] }>(cashier, "kernel.home.recent");
      expect(records.map((r) => [r.id, r.title, r.action])).toEqual([
        [things[0], "Café molido", "update"],
        [things[1], "Café en grano", "insert"],
      ]);
      expect(records[0]).toMatchObject({ entity: "probe.thing" });
      expect(new Date(records[0]!.at).toISOString()).toBe("2026-10-28T12:00:00.000Z");
    });

    it("leaves out a record the caller can no longer see through the view", async () => {
      const { records } = await run<{ records: { id: string }[] }>(cashier, "kernel.home.recent");
      expect(records.map((r) => r.id)).not.toContain(things[2]);
    });

    it("leaves out records of an entity the caller's roles may not consult", async () => {
      await sql`delete from kernel.process_permissions where company_id = ${companyA} and role_id = ${seed.companies[0]!.memberRoleId} and process_id = 'probe.thing.consult'`;
      try {
        const { records } = await run<{ records: unknown[] }>(cashier, "kernel.home.recent");
        expect(records).toEqual([]);
      } finally {
        await grant(companyA, seed.companies[0]!.memberRoleId, "probe.thing.consult");
      }
    });

    it("honours the limit", async () => {
      const { records } = await run<{ records: unknown[] }>(cashier, "kernel.home.recent", { limit: 1 });
      expect(records).toHaveLength(1);
    });

    it("kernel.v_audit_log shows the caller's own rows only", async () => {
      const [mine] = await withClaims(sql, clerk.claims, (tx) => tx<{ n: number; others: number }[]>`
        select count(*)::int as n, count(*) filter (where id in (select id from kernel.audit_log where actor_user_id <> ${seed.users.clerk!}))::int as others
        from kernel.v_audit_log`);
      const [own] = await sql<{ n: number }[]>`select count(*)::int as n from kernel.audit_log where actor_user_id = ${seed.users.clerk!} and company_id = ${companyA}`;
      expect(mine!.n).toBe(own!.n);
      expect(mine!.others).toBe(0);
    });
  });
});
