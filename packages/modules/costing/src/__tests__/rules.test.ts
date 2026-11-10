import { describe, expect, it } from "vitest";
import { composeEntry, RuleTemplate } from "@erp/kernel";
import { costing, COSTING_POSTING_RULES, FIFO_PHASE_3, OFFSET_ROLES } from "../index";

// The default rules the costing manifest ships for landed costs (plan 2B Task 9): exactly one allocation rule applies to an event, it
// composes balanced, and the void rule is a reversal. The real engine over the demo chart is landed-cost.integration.test.ts.

const payload = (offsetRole: string) => ({
  landedCostId: "0192b4c0-0000-7000-8000-00000000f010", number: "CD-1", date: "2026-03-15", movementId: "0192b4c0-0000-7000-8000-00000000f003", movementNumber: "EN-9",
  basis: "value", offsetRole, partyId: "0192b4c0-0000-7000-8000-00000000c001", amount: 1000.01, reference: "FLETE-1",
  lines: [
    { lineId: "l1", movementLineId: "m1", productId: "p1", categoryId: null, warehouseId: "w1", amount: 200, cost: 200, cogsAdjustment: 0 },
    { lineId: "l2", movementLineId: "m2", productId: "p2", categoryId: null, warehouseId: "w1", amount: 800.01, cost: 800.01, cogsAdjustment: 0 },
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

  it("ships cogs-posted (moved from accounting's defaults, Task 50.14): Dr cogs / Cr inventory on the movement, and the manifest carries it once", () => {
    const cogs = COSTING_POSTING_RULES.filter((r) => r.event === "costing.cogs.posted");
    expect(cogs.map((r) => r.name)).toEqual(["Costo de ventas"]);
    expect(cogs[0]!.template).toMatchObject({ source: { entity: "inventory.movement", id: "$.movementId" }, reverseOf: null });
    expect(costing.postingRules).toBe(COSTING_POSTING_RULES);
    expect(COSTING_POSTING_RULES).toHaveLength(OFFSET_ROLES.length + 5);
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

  // Task 45 (R45-3): the share of units already sold goes to cost of sales (Dr cogs per line, on the cost center the request names) in the
  // same entry; a line with no sold units posts no cogs line (the engine drops a zero line), so nothing sold composes exactly as before.
  it("with units already sold each composes Dr inventory (stock part) and Dr cogs (sold part, cost center) per line / Cr the role", () => {
    const cc = "0192b4c0-0000-7000-8000-0000000cc045";
    const late = {
      ...payload("payable"), amount: 10000.01, costCenterId: cc,
      lines: [
        { lineId: "l1", movementLineId: "m1", productId: "p1", categoryId: null, warehouseId: "w1", amount: 10000, cost: 5000, cogsAdjustment: 5000, costCenterId: cc },
        { lineId: "l2", movementLineId: "m2", productId: "p2", categoryId: null, warehouseId: "w1", amount: 0.01, cost: 0.01, cogsAdjustment: 0, costCenterId: cc },
      ],
    };
    const rule = allocation.find((r) => ruleApplies(r.template as never, late))!;
    const composed = composeEntry(rule.template as never, { id: "e1", event: rule.event, payload: late, createdAt: new Date("2026-03-15T00:00:00Z"), chainId: "c1" }, { tolerance: 0, companyCurrency: "COP" });
    expect(composed.ok).toBe(true);
    if (!composed.ok) return;
    expect(composed.entry.roundingLine).toBeUndefined();
    expect(composed.entry.lines.map((l) => [l.role, l.side, l.amountCompany, l.costCenterId ?? null])).toEqual([
      ["inventory", "debit", 5000, null], ["inventory", "debit", 0.01, null], ["cogs", "debit", 5000, cc], ["payable", "credit", 10000.01, null],
    ]);
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
