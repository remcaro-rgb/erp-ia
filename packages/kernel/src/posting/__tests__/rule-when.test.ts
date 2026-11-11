import { describe, expect, it } from "vitest";
import { postingConsumer } from "../engine";
import { ruleApplies } from "../compose";
import { RuleTemplate } from "../template";
import type { ConsumerContext } from "../../registry/types";
import type { PostingProvider, PostingRule } from "../provider";
import { invoiceEvent, invoiceTemplate } from "./fixtures";

// A rule's `when` (plan 2B Task 7): the rule applies to an event only when every condition holds on the payload; a rule that does not
// apply is neither posted nor counted as a failure (a receipt reaches the adjustment rule and nothing happens).

const base = { description: "x", lines: [{ role: "cash", side: "debit" as const, amount: "$.a" }] };

describe("rule template when", () => {
  it("accepts equals, in and notEquals conditions and refuses an empty, double or wildcard one", () => {
    const ok = (when: unknown) => RuleTemplate.safeParse({ ...base, when }).success;
    expect(ok([{ path: "$.kind", equals: "adjustment" }])).toBe(true);
    expect(ok([{ path: "$.kind", in: ["adjustment", "count"] }, { path: "$.value", notEquals: 0 }])).toBe(true);
    expect(ok([{ path: "$.kind" }])).toBe(false);
    expect(ok([{ path: "$.kind", equals: "a", in: ["a"] }])).toBe(false);
    expect(ok([{ path: "$.lines[*].kind", equals: "a" }])).toBe(false);
    expect(ok([{ path: "kind", equals: "a" }])).toBe(false);
    expect(ok([{ path: "$.a..b", equals: "a" }])).toBe(false);
    expect(ok([{ path: "$$.a", equals: "a" }])).toBe(false);
  });
});

describe("ruleApplies", () => {
  const when = (conditions: object[]) => ({ ...base, when: conditions }) as unknown as RuleTemplate;
  it("a template without when always applies", () => {
    expect(ruleApplies(base as RuleTemplate, { kind: "receipt" })).toBe(true);
  });
  it("equals, in and notEquals compare the payload value without coercion; every condition must hold", () => {
    const payload = { kind: "adjustment", value: -35000, nested: { flag: true } };
    expect(ruleApplies(when([{ path: "$.kind", equals: "adjustment" }]), payload)).toBe(true);
    expect(ruleApplies(when([{ path: "$.kind", equals: "receipt" }]), payload)).toBe(false);
    expect(ruleApplies(when([{ path: "$.kind", in: ["receipt", "adjustment"] }]), payload)).toBe(true);
    expect(ruleApplies(when([{ path: "$.value", notEquals: 0 }]), payload)).toBe(true);
    expect(ruleApplies(when([{ path: "$.value", notEquals: -35000 }]), payload)).toBe(false);
    expect(ruleApplies(when([{ path: "$.value", equals: "-35000" }]), payload)).toBe(false);
    expect(ruleApplies(when([{ path: "$.nested.flag", equals: true }]), payload)).toBe(true);
    expect(ruleApplies(when([{ path: "$.kind", equals: "adjustment" }, { path: "$.value", equals: 1 }]), payload)).toBe(false);
  });
  it("a missing value equals nothing: equals and in fail, notEquals holds", () => {
    expect(ruleApplies(when([{ path: "$.gone", equals: "x" }]), {})).toBe(false);
    expect(ruleApplies(when([{ path: "$.gone", in: ["x"] }]), {})).toBe(false);
    expect(ruleApplies(when([{ path: "$.gone", notEquals: "x" }]), {})).toBe(true);
  });
});

describe("posting engine and when", () => {
  const ctx = (): ConsumerContext => ({ sql: undefined as never, companyId: "c1", chainId: "chain-1", runProcess: async () => ({}), event: { id: invoiceEvent.id, name: invoiceEvent.event, createdAt: invoiceEvent.createdAt } });
  const run = async (payload: unknown, templates: RuleTemplate[]) => {
    const posted: string[] = [];
    const failures: string[] = [];
    const provider = {
      rulesFor: async () => templates.map((template, i): PostingRule => ({ id: `r${i}`, event: invoiceEvent.event, journalId: "j", template, priority: i })),
      resolveAccount: async (_c: unknown, role: string) => ({ accountId: role, code: role }),
      ledgerStartsOn: async () => new Date("2026-01-01"),
      composeSettings: async () => ({ tolerance: 1, companyCurrency: "COP" }),
      countSkipped: async () => undefined,
      post: async (_c: unknown, _e: unknown, r: PostingRule) => (posted.push(r.id), { entryId: r.id }),
      reverse: async () => null,
      recordFailure: async (_c: unknown, f: { code: string }) => void failures.push(f.code),
      effectsFor: async () => [],
    } as unknown as PostingProvider;
    await postingConsumer(provider)(ctx(), payload);
    return { posted, failures };
  };
  it("skips a rule whose condition fails without a failure, and posts the one whose condition holds", async () => {
    const guarded = { ...invoiceTemplate, when: [{ path: "$.number", equals: "FE-2" }] } as unknown as RuleTemplate;
    const matching = { ...invoiceTemplate, when: [{ path: "$.number", equals: "FE-1" }] } as unknown as RuleTemplate;
    expect(await run(invoiceEvent.payload, [guarded])).toEqual({ posted: [], failures: [] });
    expect(await run(invoiceEvent.payload, [guarded, matching])).toEqual({ posted: ["r1"], failures: [] });
  });

  it("a stored rule with a malformed when is recorded as an invalid_template failure and the next rule still runs", async () => {
    const broken = { ...invoiceTemplate, when: [{ path: "$.a..b", equals: 1 }] } as unknown as RuleTemplate;
    const nullCondition = { ...invoiceTemplate, when: [null] } as unknown as RuleTemplate;
    const fine = { ...invoiceTemplate } as RuleTemplate;
    expect(await run(invoiceEvent.payload, [broken, nullCondition, fine])).toEqual({ posted: ["r2"], failures: ["invalid_template", "invalid_template"] });
  });
});
