import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runProcess, type Kpi } from "@erp/kernel";
import { supportHarness, type SupportHarness } from "./helpers";

// The support module's card on the home screen (Task 20): tickets that are not closed, counted through support.v_tickets
// as the caller, so a plain reporter counts their own tickets and an agent all of them.

describe("support home KPI", () => {
  let h: SupportHarness;
  const kpi = async (caller: SupportHarness["agent"]) =>
    ((await runProcess(h.deps, caller, "kernel.home.kpis", {})) as { kpis: Kpi[] }).kpis.find((k) => k.id === "support.tickets");

  beforeAll(async () => {
    h = await supportHarness();
    for (const roleId of Object.values(h.roles)) {
      const companyId = roleId === h.roles.agentOther ? h.otherCompanyId : h.companyId;
      await h.sql`insert into kernel.process_permissions(company_id, role_id, process_id) values (${companyId}, ${roleId}, 'kernel.home.kpis')`;
    }
    const create = (caller: SupportHarness["reporterA"], title: string) =>
      runProcess(h.deps, caller, "support.ticket.create", { kind: "bug", title, body: "Descripción del problema." }) as Promise<{ id: string }>;
    await create(h.reporterA, "Primero");
    const second = await create(h.reporterA, "Segundo");
    await create(h.reporterB, "Tercero");
    await runProcess(h.deps, h.agent, "support.ticket.close", { id: second.id });
  });
  afterAll(async () => {
    await h.cleanup();
  });

  it("an agent counts every ticket of the company that is not closed", async () => {
    const card: Partial<Kpi> = { ...(await kpi(h.agent))! };
    delete card.series;
    expect(card).toEqual({
      id: "support.tickets",
      href: "/support",
      label: "home.kpi.support_tickets.label",
      value: 2,
      unit: "count",
      tone: "warn",
      detail: { key: "home.kpi.support_tickets.detail", params: { total: 3 } },
    });
  });

  it("a reporter counts their own tickets only", async () => {
    expect(await kpi(h.reporterB)).toMatchObject({ value: 1, detail: { params: { total: 1 } } });
    expect(await kpi(h.reporterA)).toMatchObject({ value: 1, detail: { params: { total: 2 } } });
  });

  it("shows no warning when nothing is open", async () => {
    await h.sql`update support.tickets set status = 'closed' where company_id = ${h.companyId}`;
    const card = await kpi(h.agent);
    expect(card).toMatchObject({ value: 0 });
    expect(card!.tone).toBeUndefined();
  });

  describe("trend", () => {
    const days = (byDaysAgo: Record<number, number>) => Array.from({ length: 14 }, (_, i) => byDaysAgo[13 - i] ?? 0);
    const createdAt = (title: string, daysAgo: number, time: string) =>
      h.sql.begin(async (tx) => {
        await tx`set local session_replication_role = replica`;
        await tx`update support.tickets set created_at = (((now() at time zone 'America/Bogota')::date - ${daysAgo}::int + ${time}::time) at time zone 'America/Bogota')
                 where company_id = ${h.companyId} and title = ${title}`;
      });

    beforeAll(async () => {
      await h.sql`update support.tickets set status = 'open' where company_id = ${h.companyId} and title <> 'Segundo'`;
      await createdAt("Primero", 4, "09:00");
      await createdAt("Segundo", 4, "17:00");
      await createdAt("Tercero", 1, "23:45");
    });

    it("is 14 daily counts of new tickets (closed ones included: it is the inflow), oldest first", async () => {
      const card = (await kpi(h.agent))!;
      expect(card.series).toHaveLength(14);
      expect(card.series).toEqual(days({ 4: 2, 1: 1 }));
    });

    it("a reporter's trend is their own tickets only", async () => {
      expect((await kpi(h.reporterA))!.series).toEqual(days({ 4: 2 }));
      expect((await kpi(h.reporterB))!.series).toEqual(days({ 1: 1 }));
    });
  });
});
