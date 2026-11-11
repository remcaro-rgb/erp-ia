import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runProcess, type Chart, type Kpi } from "@erp/kernel";
import { supportHarness, type SupportHarness } from "./helpers";

// The support module's Inicio page (kernel.home.kpis with module: support): the indicators and charts over the tickets the caller
// may see, through support.v_tickets (a reporter their own, an agent every ticket of the company).

describe("support Inicio page", () => {
  let h: SupportHarness;
  type Page = { kpis: Kpi[]; charts: Chart[]; catalog: { id: string; kind: string }[] };
  const page = async (caller: SupportHarness["agent"]) => (await runProcess(h.deps, caller, "kernel.home.kpis", { module: "support" })) as Page;
  const kpi = async (caller: SupportHarness["agent"], id: string) => (await page(caller)).kpis.find((k) => k.id === id);
  const chart = async (caller: SupportHarness["agent"], id: string) => (await page(caller)).charts.find((c) => c.id === id)!;
  const points = (c: Chart) => Object.fromEntries(c.series[0]!.points.map((p) => [p.label, p.value]));
  const age = (title: string, days: number, closedAfterDays?: number) =>
    h.sql.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      await tx`update support.tickets set created_at = now() - ${days}::int * interval '1 day',
               updated_at = now() - ${days - (closedAfterDays ?? 0)}::int * interval '1 day' where company_id = ${h.companyId} and title = ${title}`;
    });

  beforeAll(async () => {
    h = await supportHarness();
    for (const roleId of Object.values(h.roles)) {
      const companyId = roleId === h.roles.agentOther ? h.otherCompanyId : h.companyId;
      await h.sql`insert into kernel.process_permissions(company_id, role_id, process_id) values (${companyId}, ${roleId}, 'kernel.home.kpis')`;
    }
    const create = (caller: SupportHarness["reporterA"], title: string) =>
      runProcess(h.deps, caller, "support.ticket.create", { kind: "bug", title, body: "Descripción del problema." }) as Promise<{ id: string }>;
    await create(h.reporterA, "Nuevo");
    await create(h.reporterA, "Viejo");
    await create(h.reporterA, "Urgente");
    await create(h.reporterB, "Ajeno");
    const closed = await create(h.reporterA, "Resuelto");
    await h.sql`update support.tickets set priority = 'high' where company_id = ${h.companyId} and title = 'Urgente'`;
    await runProcess(h.deps, h.agent, "support.ticket.close", { id: closed.id });
    await age("Viejo", 10);
    await age("Resuelto", 5, 3);
  });
  afterAll(async () => {
    await h.cleanup();
  });

  it("an agent's page has the support indicators and charts, and nothing of another module", async () => {
    const { kpis, charts, catalog } = await page(h.agent);
    expect(kpis.map((k) => k.id)).toEqual(["support.tickets", "support.urgent", "support.stale", "support.resolved_30d"]);
    expect(charts.map((c) => c.id)).toEqual(["support.tickets_by_status", "support.tickets_by_priority", "support.tickets_inflow"]);
    expect(catalog.map((c) => `${c.kind}:${c.id}`)).toHaveLength(7);
  });

  it("urgent: the open tickets of high priority, against all open", async () => {
    expect(await kpi(h.agent, "support.urgent")).toMatchObject({ value: 1, tone: "warn", detail: { params: { open: 4 } } });
  });

  it("stale: the tickets still open after more than 7 days", async () => {
    expect(await kpi(h.agent, "support.stale")).toMatchObject({ value: 1, tone: "warn" });
  });

  it("resolved in 30 days: the closed ones and the days they took on average", async () => {
    expect(await kpi(h.agent, "support.resolved_30d")).toMatchObject({ value: 1, detail: { key: "home.kpi.support_resolved.detail", params: { days: 3 } } });
  });

  it("tickets by status and by priority (open ones)", async () => {
    expect(points(await chart(h.agent, "support.tickets_by_status"))).toEqual({
      "home.chart.point.ticket_open": 4,
      "home.chart.point.ticket_answered": 0,
      "home.chart.point.ticket_closed": 1,
    });
    expect(points(await chart(h.agent, "support.tickets_by_priority"))).toEqual({
      "home.chart.point.priority_high": 1,
      "home.chart.point.priority_normal": 3,
      "home.chart.point.priority_low": 0,
    });
  });

  it("tickets received per week: the last 8 weeks, this week's included", async () => {
    const inflow = await chart(h.agent, "support.tickets_inflow");
    expect(inflow.kind).toBe("line");
    expect(inflow.series[0]!.points).toHaveLength(8);
    expect(inflow.series[0]!.points.reduce((sum, p) => sum + p.value, 0)).toBe(5);
  });

  it("a reporter sees the numbers of their own tickets only", async () => {
    expect(points(await chart(h.reporterB, "support.tickets_by_status"))).toMatchObject({ "home.chart.point.ticket_open": 1, "home.chart.point.ticket_closed": 0 });
    expect((await kpi(h.reporterB, "support.stale"))!.value).toBe(0);
    expect((await kpi(h.reporterA, "support.urgent"))!.value).toBe(1);
  });

  it("every key the page's cards and charts name exists in both catalogues", async () => {
    const { kpis, charts } = await page(h.agent);
    const keys = [
      ...kpis.flatMap((k) => [k.label, ...(k.detail ? [k.detail.key] : [])]),
      ...charts.flatMap((c) => [c.label, ...c.series.flatMap((s) => [s.label, ...(c.i18n ? s.points.map((p) => p.label) : [])])]),
    ];
    for (const locale of ["es-419", "en"] as const) {
      const tree = JSON.parse(readFileSync(join(import.meta.dirname, "../../../../i18n/messages", `${locale}.json`), "utf8")) as Record<string, unknown>;
      const missing = keys.filter((key) => typeof key.split(".").reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], tree) !== "string");
      expect(missing, locale).toEqual([]);
    }
  });
});
