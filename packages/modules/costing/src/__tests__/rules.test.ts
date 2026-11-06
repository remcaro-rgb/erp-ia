import { describe, expect, it } from "vitest";
import { composeEntry, RuleTemplate } from "@erp/kernel";
import { COSTING_POSTING_RULES, FIFO_PHASE_3, OFFSET_ROLES } from "../index";

// The default rules the costing manifest ships for landed costs (plan 2B Task 9): exactly one allocation rule applies to an event, it
// composes balanced, and the void rule is a reversal. The real engine over the demo chart is landed-cost.integration.test.ts.

const payload = (offsetRole: string) => ({
  landedCostId: "0192b4c0-0000-7000-8000-00000000f010", number: "CD-1", date: "2026-03-15", movementId: "0192b4c0-0000-7000-8000-00000000f003", movementNumber: "EN-9",
  basis: "value", offsetRole, partyId: "0192b4c0-0000-7000-8000-00000000c001", amount: 1000.01, reference: "FLETE-1",
  lines: [
    { lineId: "l1", movementLineId: "m1", productId: "p1", categoryId: null, warehouseId: "w1", amount: 200, cost: 200 },
    { lineId: "l2", movementLineId: "m2", productId: "p2", categoryId: null, warehouseId: "w1", amount: 800.01, cost: 800.01 },
  ],
});
/** Whether the rule's `when` conditions (equals only, in these rules) hold on the payload. */
const ruleApplies = (template: { when?: { path: string; equals?: unknown }[] }, p: Record<string, unknown>): boolean =>
  (template.when ?? []).every((c) => p[c.path.replace("$.", "")] === c.equals);
const allocation = COSTING_POSTING_RULES.filter((r) => r.event === "costing.landed_cost.allocated");

describe("landed cost posting rules", () => {
  it("every shipped template is valid", () => {
    for (const rule of COSTING_POSTING_RULES) expect(RuleTemplate.safeParse(rule.template).success, rule.name).toBe(true);
  });

  it("one allocation rule per offset role, and only the named one applies", () => {
    expect(allocation).toHaveLength(OFFSET_ROLES.length);
    for (const role of OFFSET_ROLES) expect(allocation.filter((r) => ruleApplies(r.template as never, payload(role)))).toHaveLength(1);
  });

  it("each composes Dr inventory per line / Cr the named role, balanced to the cent, with the supplier on the credit", () => {
    for (const role of OFFSET_ROLES) {
      const rule = allocation.find((r) => ruleApplies(r.template as never, payload(role)))!;
      const composed = composeEntry(rule.template as never, { id: "e1", event: rule.event, payload: payload(role), createdAt: new Date("2026-03-15T00:00:00Z"), chainId: "c1" }, { tolerance: 0, companyCurrency: "COP" });
      expect(composed.ok).toBe(true);
      if (!composed.ok) continue;
      expect(composed.entry.roundingLine).toBeUndefined();
      expect(composed.entry.source).toEqual({ entity: "costing.landed_cost", id: "0192b4c0-0000-7000-8000-00000000f010" });
      expect(composed.entry.lines.map((l) => [l.role, l.side, l.amountCompany])).toEqual([["inventory", "debit", 200], ["inventory", "debit", 800.01], [role, "credit", 1000.01]]);
      expect(composed.entry.lines[2]!.partyId).toBe("0192b4c0-0000-7000-8000-00000000c001");
    }
  });

  it("the void rule reverses the allocation by its landed cost id", () => {
    const rule = COSTING_POSTING_RULES.find((r) => r.event === "costing.landed_cost.voided")!;
    expect(rule.template.reverseOf).toEqual({ event: "costing.landed_cost.allocated", sourceId: "$.landedCostId" });
  });
});

describe("cost of sales rules of the entregas (Task 14)", () => {
  const cc = "0192b4c0-0000-7000-8000-0000000cc001";
  const movementId = "0192b4c0-0000-7000-8000-00000000a001";
  const returned = { movementId, cogsId: movementId, number: "MOV-9", date: "2026-03-20", costCenterId: cc, lines: [{ cost: 110, costCenterId: cc }, { cost: 55.5, costCenterId: cc }] };

  it("a sale return posts Dr inventory / Cr cogs per line at the original cost, the cost center on the cogs line, sourced on the movement", () => {
    const rule = COSTING_POSTING_RULES.find((r) => r.event === "costing.cogs.returned")!;
    expect(rule.journalCode).toBe("NC");
    const composed = composeEntry(rule.template as never, { id: "e1", event: rule.event, payload: returned, createdAt: new Date("2026-03-20T00:00:00Z"), chainId: "c1" }, { tolerance: 0, companyCurrency: "COP" });
    expect(composed.ok).toBe(true);
    if (!composed.ok) return;
    expect(composed.entry.source).toEqual({ entity: "inventory.movement", id: movementId });
    expect(composed.entry.lines.map((l) => [l.role, l.side, l.amountCompany, l.costCenterId ?? null])).toEqual([
      ["inventory", "debit", 110, null], ["inventory", "debit", 55.5, null], ["cogs", "credit", 110, cc], ["cogs", "credit", 55.5, cc],
    ]);
  });

  it("a voided sale issue (sale return) reverses the entry of its cost of sales, found by the movement", () => {
    expect(COSTING_POSTING_RULES.find((r) => r.event === "costing.cogs.voided")!.template.reverseOf).toEqual({ event: "costing.cogs.posted", sourceId: "$.movementId" });
    expect(COSTING_POSTING_RULES.find((r) => r.event === "costing.cogs.return_voided")!.template.reverseOf).toEqual({ event: "costing.cogs.returned", sourceId: "$.movementId" });
  });
});

describe("fifo", () => {
  it("is refused with the phase 3 text", () => {
    expect(FIFO_PHASE_3).toContain("disponible en la fase 3");
  });
});
