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
    expect(await kpi(h.agent)).toEqual({
      id: "support.tickets",
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
});
