import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProcessContext } from "../../process/context";
import { ProcessError } from "../../process/errors";
import type { Registry } from "../../registry";
import type { PostingProvider, PostingRule } from "../provider";
import type { RuleTemplate } from "../template";

// Inline strict posting (entity types spec §5.2, D8): a contabiliza documento posts its event's rules NOW, in the caller's transaction;
// any refusal throws (the surrounding runProcess rolls everything back) and nothing is recorded as a posting failure.

vi.mock("../../events/outbox", () => ({ enqueueEvent: vi.fn(async () => "0192b4c0-0000-7000-8000-0000000000e1") }));
// The company's module states (the dispatcher's gate): accounting is enabled unless a test says otherwise.
const states: { acct: boolean; bought: boolean } = { acct: true, bought: true };
vi.mock("../../admin/modules-state", () => ({
  moduleStates: vi.fn(async () => [{
    id: "acct", dependsOn: [], needs: [], purchased: states.bought, enabled: states.acct && states.bought,
    gate: !states.bought && states.acct ? "not_purchased" : states.acct ? "enabled" : "switched_off",
  }]),
}));
const { emitAndPostStrict, dismissParkedEvents, inlinePostingProcesses } = await import("../inline");
const { enqueueEvent } = await import("../../events/outbox");

const allocated: RuleTemplate = {
  date: "$.date", description: "Costo {{number}}",
  lines: [
    { role: "inventory", side: "debit", forEach: "$.lines[*]", amount: "$.cost" },
    { role: "payable", side: "credit", amount: "$.amount" },
  ],
};
const reversal: RuleTemplate = { date: "$.date", description: "Anulación", lines: [], reverseOf: { event: "x.allocated", sourceId: "$.id" } };
const rule = (id: string, template: RuleTemplate, priority = 100): PostingRule => ({ id, event: "x.allocated", journalId: "j1", template, priority });

const calls: string[] = [];
function provider(over: Partial<PostingProvider> & { rules?: PostingRule[]; startsOn?: Date | null } = {}): PostingProvider {
  return {
    rulesFor: async () => over.rules ?? [rule("r1", allocated)],
    resolveAccount: async (_c, role) => (role === "missing" ? null : { accountId: `a-${role}`, code: `code-${role}` }),
    ledgerStartsOn: async () => (over.startsOn === undefined ? new Date("2026-01-01T00:00:00Z") : over.startsOn),
    composeSettings: async () => ({ tolerance: 0, companyCurrency: "COP" }),
    countSkipped: async () => undefined,
    post: async () => { throw new Error("the async path must not be used inline"); },
    reverse: async () => { throw new Error("the async path must not be used inline"); },
    recordFailure: async () => { calls.push("recordFailure"); },
    effectsFor: async () => [],
    postInline: over.postInline ?? (async (_c, draft, r) => { calls.push(`post:${r.id}:${draft.sourceEventId}:${draft.lines.length}`); return { entryId: "entry-1" }; }),
    reverseInline: over.reverseInline ?? (async () => { calls.push("reverse"); return { entryId: "rev-1" }; }),
  };
}
/** Every SQL statement the context ran (the tagged-template mock records its text). */
const sqlRan: string[] = [];
const tx = Object.assign(async (strings: TemplateStringsArray) => { sqlRan.push(strings.join("?")); return []; }, {});
const ctxWith = (p: PostingProvider | null): ProcessContext =>
  ({ tx: tx as never, companyId: "c1", chainId: "chain1", registry: { modules: () => [p ? { id: "acct", postingProvider: p } : { id: "none" }] } }) as unknown as ProcessContext;
const payload = { date: "2026-03-15", number: "CD-1", amount: 100, half: 50, lines: [{ cost: 40 }, { cost: 60 }], id: "s1" };

beforeEach(() => { calls.length = 0; sqlRan.length = 0; states.acct = true; states.bought = true; vi.mocked(enqueueEvent).mockClear(); });
const marked = () => sqlRan.some((q) => q.includes("kernel.mark_event_handled"));

describe("emitAndPostStrict", () => {
  it("emits the event and posts its applicable rule inside the caller's transaction, keyed by the event's id", async () => {
    const out = await emitAndPostStrict(ctxWith(provider()), "x.allocated", payload);
    expect(enqueueEvent).toHaveBeenCalledWith(expect.anything(), { companyId: "c1", event: "x.allocated", payload, chainId: "chain1" });
    expect(out).toEqual({ posted: true, eventId: "0192b4c0-0000-7000-8000-0000000000e1", entryIds: ["entry-1"] });
    // The event is marked as handled by the posting module, so its asynchronous consumer never composes it again.
    expect(marked()).toBe(true);
    expect(calls).toEqual(["post:r1:0192b4c0-0000-7000-8000-0000000000e1:3"]);
  });

  it("throws when the provider's post refuses, and records no failure", async () => {
    const refuse = provider({ postInline: async () => { throw new ProcessError("invalid_input", "closed_period: El período está cerrado"); } });
    await expect(emitAndPostStrict(ctxWith(refuse), "x.allocated", payload)).rejects.toThrow(/closed_period/);
    expect(calls).not.toContain("recordFailure");
    expect(marked()).toBe(false);
  });

  it("throws when the rule does not compose (unbalanced) or a role has no account", async () => {
    const bad: RuleTemplate = { ...allocated, lines: [{ role: "inventory", side: "debit", amount: "$.amount" }, { role: "payable", side: "credit", amount: "$.half" }] };
    await expect(emitAndPostStrict(ctxWith(provider({ rules: [rule("r1", bad)] })), "x.allocated", payload)).rejects.toThrow(/unbalanced/);
    const unmapped: RuleTemplate = { ...allocated, lines: [{ role: "missing", side: "debit", amount: "$.amount" }, { role: "payable", side: "credit", amount: "$.amount" }] };
    await expect(emitAndPostStrict(ctxWith(provider({ rules: [rule("r1", unmapped)] })), "x.allocated", payload)).rejects.toThrow(/missing_account_mapping/);
  });

  it("throws no_rule when a rule is required and none applies; a `when` that does not hold is not a rule", async () => {
    const other: RuleTemplate = { ...allocated, when: [{ path: "$.kind", equals: "adjustment" }] };
    await expect(emitAndPostStrict(ctxWith(provider({ rules: [rule("r1", other)] })), "x.allocated", payload, { requireRule: true })).rejects.toThrow(/no_rule/);
    await expect(emitAndPostStrict(ctxWith(provider({ rules: [] })), "x.allocated", payload, { requireRule: true })).rejects.toThrow(/no_rule/);
    expect(await emitAndPostStrict(ctxWith(provider({ rules: [rule("r1", other)] })), "x.allocated", payload)).toMatchObject({ posted: true, entryIds: [] });
  });

  it("an event before the start of the ledger posts nothing, is counted as skipped and marked handled (the consumer would not post it either)", async () => {
    const p = { ...provider({ startsOn: new Date("2027-01-01T00:00:00Z") }), countSkipped: async () => { calls.push("countSkipped"); } } as PostingProvider;
    expect(await emitAndPostStrict(ctxWith(p), "x.allocated", payload)).toMatchObject({ posted: false, reason: "before_ledger_start" });
    expect(calls).toEqual(["countSkipped"]);
    expect(marked()).toBe(true);
  });

  it("a payload without a date is dated today in the company's time zone, not UTC (final review M-5)", async () => {
    // The company's today (its time zone) is the day before the ledger starts: nothing posts. In UTC (the clock) it would post.
    const tz = Object.assign(async (strings: TemplateStringsArray) => {
      const q = strings.join("?");
      sqlRan.push(q);
      return q.includes("kernel.companies") ? [{ today: "2026-05-31" }] : [];
    }, {});
    const ctx = { ...ctxWith(provider({ startsOn: new Date("2026-06-01T00:00:00Z") })), tx: tz } as unknown as ProcessContext;
    const undated: Record<string, unknown> = { ...payload };
    delete undated.date;
    expect(await emitAndPostStrict(ctx, "x.allocated", undated)).toMatchObject({ posted: false, reason: "before_ledger_start" });
    expect(sqlRan.some((q) => q.includes("timezone"))).toBe(true);
  });

  it("a ledger that was never started is refused: ledger_not_started", async () => {
    await expect(emitAndPostStrict(ctxWith(provider({ startsOn: null })), "x.allocated", payload)).rejects.toThrow(/ledger_not_started/);
    expect(calls).toEqual([]);
  });

  it("a company without the accounting module enabled: the event is emitted and parked (not marked), nothing is posted", async () => {
    states.acct = false;
    const out = await emitAndPostStrict(ctxWith(provider()), "x.allocated", payload, { requireRule: true });
    expect(out).toEqual({ posted: false, reason: "accounting_disabled", eventId: "0192b4c0-0000-7000-8000-0000000000e1" });
    expect(enqueueEvent).toHaveBeenCalledTimes(1);
    expect(calls).toEqual([]);
    expect(marked()).toBe(false);
  });

  it("a posting module the company never bought parks the event as not_entitled (visible), unlike a switched-off one (Task 50.9)", async () => {
    states.bought = false;
    const out = await emitAndPostStrict(ctxWith(provider()), "x.allocated", payload, { requireRule: true });
    expect(out).toEqual({ posted: false, reason: "not_entitled", eventId: "0192b4c0-0000-7000-8000-0000000000e1" });
    expect(enqueueEvent).toHaveBeenCalledTimes(1);
    expect(calls).toEqual([]);
    expect(marked()).toBe(false);
  });

  it("a reversal rule reverses inline; a reversal the ledger refuses throws", async () => {
    const out = await emitAndPostStrict(ctxWith(provider({ rules: [rule("r2", reversal)] })), "x.voided", payload);
    expect(out).toMatchObject({ posted: true, entryIds: ["rev-1"] });
    // A source with no entry at all (the engine's exact lookup finds none) reverses nothing and is not an error.
    const none = provider({ rules: [rule("r2", reversal)], reverseInline: async () => null });
    expect(await emitAndPostStrict(ctxWith(none), "x.voided", payload)).toMatchObject({ posted: true, entryIds: [] });
    const refused = provider({ rules: [rule("r2", reversal)], reverseInline: async () => { throw new ProcessError("invalid_input", "closed_period: cerrado"); } });
    await expect(emitAndPostStrict(ctxWith(refused), "x.voided", payload)).rejects.toThrow(/closed_period/);
  });

  it("the inline reversal names the void's own event, so the provider records the source voided under it (Task 33 fix round 1, C1)", async () => {
    const seen: unknown[] = [];
    const p = provider({ rules: [rule("r2", reversal)], reverseInline: async (_c, ref, date, name, voidEventId) => { seen.push({ ref, date, name, voidEventId }); return null; } });
    await emitAndPostStrict(ctxWith(p), "x.voided", payload);
    expect(seen).toEqual([{ ref: { event: "x.allocated", sourceId: "s1" }, date: "2026-03-15", name: "x.voided", voidEventId: "0192b4c0-0000-7000-8000-0000000000e1" }]);
  });

  it("an enabled posting module whose provider cannot post inline is refused (no_posting_provider)", async () => {
    const noInline = { ...provider(), postInline: undefined, reverseInline: undefined } as PostingProvider;
    await expect(emitAndPostStrict(ctxWith(noInline), "x.allocated", payload)).rejects.toThrow(/no_posting_provider/);
  });

  it("no module with a posting provider is loaded: the company has no accounting, the event parks", async () => {
    expect(await emitAndPostStrict(ctxWith(null), "x.allocated", payload)).toMatchObject({ posted: false, reason: "accounting_disabled" });
  });
});

describe("dismissParkedEvents", () => {
  it("marks the company's undelivered events that match as handled by the posting module, and says how many", async () => {
    const counted = Object.assign(async (strings: TemplateStringsArray) => { sqlRan.push(strings.join("?")); return [{ n: 2 }]; }, { json: (v: unknown) => v });
    const ctx = { ...ctxWith(provider()), tx: counted } as unknown as ProcessContext;
    expect(await dismissParkedEvents(ctx, "x.allocated", { landedCostId: "s1" })).toBe(2);
    expect(sqlRan.some((q) => q.includes("kernel.dismiss_events"))).toBe(true);
  });

  it("does nothing when no module posts", async () => {
    expect(await dismissParkedEvents(ctxWith(null), "x.allocated", { landedCostId: "s1" })).toBe(0);
  });
});

// Plan 2B Task 33 (R33-2, R33-3): the posting mode is the provider's answer. Asynchronous keeps the deterministic preconditions (a started
// ledger, a rule that applies when one is required) and defers everything else to the consumer: no inline post, the event is not marked handled.
describe("emitAndPostStrict in asynchronous mode", () => {
  const asyncProvider = (over: Parameters<typeof provider>[0] = {}) => ({ ...provider(over), postingMode: async () => "asynchronous" as const });

  it("a provider without postingMode posts inline as before (inline_strict is the default)", async () => {
    const p = provider();
    expect("postingMode" in p).toBe(false);
    expect(await emitAndPostStrict(ctxWith(p), "x.allocated", payload, { requireRule: true })).toMatchObject({ posted: true, entryIds: ["entry-1"] });
    expect(marked()).toBe(true);
    const explicit = { ...provider(), postingMode: async () => "inline_strict" as const };
    calls.length = 0;
    expect(await emitAndPostStrict(ctxWith(explicit), "x.allocated", payload)).toMatchObject({ posted: true, entryIds: ["entry-1"] });
    expect(calls).toEqual(["post:r1:0192b4c0-0000-7000-8000-0000000000e1:3"]);
  });

  it("queues the event: no inline post, not marked handled, reason queued", async () => {
    const out = await emitAndPostStrict(ctxWith(asyncProvider()), "x.allocated", payload, { requireRule: true });
    expect(out).toEqual({ posted: false, eventId: "0192b4c0-0000-7000-8000-0000000000e1", reason: "queued" });
    expect(enqueueEvent).toHaveBeenCalledTimes(1);
    expect(calls).toEqual([]);
    expect(marked()).toBe(false);
  });

  it("defers what the ledger would refuse (an unmapped role, an unbalanced rule, a refusing post) to the consumer", async () => {
    const unmapped: RuleTemplate = { ...allocated, lines: [{ role: "missing", side: "debit", amount: "$.amount" }, { role: "payable", side: "credit", amount: "$.amount" }] };
    expect(await emitAndPostStrict(ctxWith(asyncProvider({ rules: [rule("r1", unmapped)] })), "x.allocated", payload, { requireRule: true })).toMatchObject({ posted: false, reason: "queued" });
    const refusing = asyncProvider({ postInline: async () => { throw new ProcessError("invalid_input", "closed_period: cerrado"); } });
    expect(await emitAndPostStrict(ctxWith(refusing), "x.allocated", payload)).toMatchObject({ posted: false, reason: "queued" });
    expect(calls).not.toContain("recordFailure");
    expect(marked()).toBe(false);
  });

  it("an event dated before the ledger start is queued too: the consumer counts it as skipped", async () => {
    const p = { ...asyncProvider({ startsOn: new Date("2027-01-01T00:00:00Z") }), countSkipped: async () => { calls.push("countSkipped"); } } as PostingProvider;
    expect(await emitAndPostStrict(ctxWith(p), "x.allocated", payload)).toMatchObject({ posted: false, reason: "queued" });
    expect(calls).toEqual([]);
    expect(marked()).toBe(false);
  });

  it("still refuses a ledger that was never started (ledger_not_started)", async () => {
    await expect(emitAndPostStrict(ctxWith(asyncProvider({ startsOn: null })), "x.allocated", payload)).rejects.toThrow(/ledger_not_started/);
    expect(calls).toEqual([]);
  });

  it("still refuses no_rule when a rule is required and none applies (evaluated with the rule's when, nothing composed)", async () => {
    const other: RuleTemplate = { ...allocated, when: [{ path: "$.kind", equals: "adjustment" }] };
    await expect(emitAndPostStrict(ctxWith(asyncProvider({ rules: [rule("r1", other)] })), "x.allocated", payload, { requireRule: true })).rejects.toThrow(/no_rule/);
    await expect(emitAndPostStrict(ctxWith(asyncProvider({ rules: [] })), "x.allocated", payload, { requireRule: true })).rejects.toThrow(/no_rule/);
    // Without requireRule an event no rule is for is queued (the consumer posts nothing).
    expect(await emitAndPostStrict(ctxWith(asyncProvider({ rules: [] })), "x.allocated", payload)).toMatchObject({ posted: false, reason: "queued" });
    expect(calls).toEqual([]);
  });

  it("a reversal rule is queued as well: the consumer reverses through the source lock", async () => {
    expect(await emitAndPostStrict(ctxWith(asyncProvider({ rules: [rule("r2", reversal)] })), "x.voided", payload, { requireRule: true })).toMatchObject({ posted: false, reason: "queued" });
    expect(calls).toEqual([]);
  });

  it("the parked gates behave the same in both modes", async () => {
    for (const p of [provider(), asyncProvider()]) {
      states.acct = false;
      states.bought = true;
      expect(await emitAndPostStrict(ctxWith(p), "x.allocated", payload, { requireRule: true })).toMatchObject({ posted: false, reason: "accounting_disabled" });
      states.acct = true;
      states.bought = false;
      expect(await emitAndPostStrict(ctxWith(p), "x.allocated", payload, { requireRule: true })).toMatchObject({ posted: false, reason: "not_entitled" });
    }
    expect(calls).toEqual([]);
    expect(marked()).toBe(false);
  });

  it("asks the provider for the mode with the company and the event", async () => {
    const seen: { companyId: string; event: string }[] = [];
    const p = { ...provider(), postingMode: async (c: { companyId: string; event: { name: string } }) => { seen.push({ companyId: c.companyId, event: c.event.name }); return "asynchronous" as const; } } as PostingProvider;
    await emitAndPostStrict(ctxWith(p), "x.allocated", payload);
    expect(seen).toEqual([{ companyId: "c1", event: "x.allocated" }]);
  });
});

// R33-4: the documentos whose post goes through emitAndPostStrict, derived from the registry: a process (of a module that is not the posting
// module) that emits an event some module's postingRules post, minus the posting provider's reasoned list of consumer-posted processes.
describe("inlinePostingProcesses", () => {
  const proc = (id: string, emits: string[]) => ({ id, module: id.split(".")[0]!, emits });
  const fake = (asyncByDesign?: ReadonlyMap<string, string>) => {
    const p = { ...provider(), ...(asyncByDesign ? { asyncByDesign } : {}) } as PostingProvider;
    const modules = [
      { id: "acct", postingProvider: p, postingRules: [{ event: "acct.closed", name: "Cierre", journalCode: "CI", template: allocated }] },
      { id: "doc", postingRules: [{ event: "doc.issued", name: "Emitida", journalCode: "VE", template: allocated }, { event: "doc.voided", name: "Anulada", journalCode: "VE", template: reversal }] },
      { id: "inv", postingRules: [{ event: "inv.moved", name: "Movimiento", journalCode: "IN", template: allocated }] },
      { id: "crm" },
    ];
    const processes = [
      proc("doc.issue", ["doc.issued"]), proc("doc.void", ["doc.voided", "doc.status"]), proc("doc.create", ["doc.created"]), proc("doc.consult", []),
      proc("acct.close", ["acct.closed"]), proc("inv.move", ["inv.moved"]), proc("crm.lead.create", ["crm.lead.created"]), { id: "doc.noemits", module: "doc" },
    ];
    return { modules: () => modules, processes: () => processes } as unknown as Registry;
  };

  it("lists, sorted, the processes that emit a posted event; the posting module's own and the consumer-posted ones are out", () => {
    expect(inlinePostingProcesses(fake(new Map([["inv.move", "posted by the consumer"]])))).toEqual(["doc.issue", "doc.void"]);
  });

  it("without the provider's exclusion list every emitter is listed", () => {
    expect(inlinePostingProcesses(fake())).toEqual(["doc.issue", "doc.void", "inv.move"]);
  });

  it("no posting module loaded: nothing is posted inline", () => {
    const registry = { modules: () => [{ id: "doc", postingRules: [{ event: "doc.issued" }] }], processes: () => [proc("doc.issue", ["doc.issued"])] } as unknown as Registry;
    expect(inlinePostingProcesses(registry)).toEqual([]);
  });
});
