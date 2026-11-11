import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { inlinePostingProcesses } from "@erp/kernel";
import { ASYNC_BY_DESIGN } from "../index";
import { registry } from "./posting-mode-harness";

// Plan 2B Task 33 (R33-4): the contabiliza documentos are derived from the registry (inlinePostingProcesses), not listed by hand. Every one of
// them must have an asynchronous case in posting-mode.integration.test.ts (`asyncCase([...ids], …)`), so a new documento that posts through
// emitAndPostStrict cannot ship untested in the asynchronous mode. The posting provider's ASYNC_BY_DESIGN names, with a reason, the
// processes whose events the consumer posts already (they never post inline).

const source = readFileSync(new URL("./posting-mode.integration.test.ts", import.meta.url), "utf8");
const covered = new Set([...source.matchAll(/asyncCase\(\s*\[([^\]]*)\]/g)].flatMap((m) => [...m[1]!.matchAll(/"([^"]+)"/g)].map((s) => s[1]!)));

describe("asynchronous mode coverage", () => {
  const derived = inlinePostingProcesses(registry);

  it("derives the documentos that post inline from the registry", () => {
    expect(derived).toEqual([
      "costing.landed_cost.allocate", "costing.landed_cost.void",
      "invoicing.invoice.issue", "invoicing.invoice.void", "invoicing.note.issue", "invoicing.note.issue_annulment",
      "payments.advance.apply", "payments.advance.undo", "payments.payment.receive", "payments.payment.void",
      "sales.commission.accrue", "sales.commission.adjust_for_note", "sales.commission.reverse",
    ]);
  });

  it("every derived documento has an asynchronous case in posting-mode.integration.test.ts", () => {
    expect(derived.filter((id) => !covered.has(id))).toEqual([]);
    // And no case names a process that is not a documento of the set (a stale case).
    expect([...covered].filter((id) => !derived.includes(id))).toEqual([]);
  });

  it("every ASYNC_BY_DESIGN entry is a registered process that emits a posted event, with its reason", () => {
    const posted = new Set(registry.modules().flatMap((m) => (m.postingRules ?? []).map((r) => r.event)));
    for (const [id, reason] of ASYNC_BY_DESIGN) {
      expect(() => registry.process(id), id).not.toThrow();
      expect((registry.process(id).emits ?? []).some((e) => posted.has(e)), id).toBe(true);
      expect(reason.length, id).toBeGreaterThan(20);
    }
  });
});
