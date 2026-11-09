import { describe, expect, it } from "vitest";
import { ProcessError } from "../../process/errors";
import type { ConsumerContext } from "../../registry/types";
import { postingConsumer } from "../engine";
import type { PostingFailure, PostingProvider } from "../provider";
import type { RuleTemplate } from "../template";

// Plan 2B Task 33, fix round 1 (review I2): a transient SQL failure inside the provider's post (a deadlock 40P01 or a serialization failure
// 40001, wrapped by runProcess as handler_failed) is not a ledger refusal: the consumer rethrows it so the dispatcher retries the delivery with
// backoff, and records no pending. A real refusal (a closed period) is still recorded as a pending.

const template: RuleTemplate = {
  date: "$.date", description: "Venta {{number}}",
  lines: [{ role: "receivable", side: "debit", amount: "$.amount" }, { role: "revenue", side: "credit", amount: "$.amount" }],
};
const failures: PostingFailure[] = [];
const provider = (post: PostingProvider["post"]): PostingProvider => ({
  rulesFor: async () => [{ id: "r1", event: "x.issued", journalId: "j1", template, priority: 100 }],
  resolveAccount: async (_c, role) => ({ accountId: `a-${role}`, code: `c-${role}` }),
  ledgerStartsOn: async () => new Date("2026-01-01T00:00:00Z"),
  composeSettings: async () => ({ tolerance: 0, companyCurrency: "COP" }),
  countSkipped: async () => undefined,
  post,
  reverse: async () => null,
  recordFailure: async (_c, f) => { failures.push(f); },
  effectsFor: async () => [],
});
const ctx = {
  sql: Object.assign(async () => [], {}), companyId: "c1", chainId: "ch1",
  event: { id: "0192b4c0-0000-7000-8000-0000000000e1", name: "x.issued", createdAt: new Date("2026-03-15T12:00:00Z") },
  runProcess: async () => undefined,
} as unknown as ConsumerContext;
const payload = { date: "2026-03-15", number: "F-1", amount: 100 };
const sqlError = (code: string) => Object.assign(new Error("deadlock detected"), { code });

describe("postingConsumer and transient SQL failures", () => {
  for (const code of ["40P01", "40001"]) {
    it(`rethrows a ${code} from the provider's post and records no pending`, async () => {
      failures.length = 0;
      const consume = postingConsumer(provider(async () => { throw new ProcessError("handler_failed", "process accounting.entry.post_from_event failed", { cause: sqlError(code) }); }));
      await expect(consume(ctx, payload)).rejects.toMatchObject({ code: "handler_failed" });
      expect(failures).toEqual([]);
    });
  }

  it("a raw transient SQL error is rethrown too (it is no ProcessError)", async () => {
    failures.length = 0;
    await expect(postingConsumer(provider(async () => { throw sqlError("40P01"); }))(ctx, payload)).rejects.toMatchObject({ code: "40P01" });
    expect(failures).toEqual([]);
  });

  it("a ledger refusal is still recorded as a pending of the retry queue", async () => {
    failures.length = 0;
    await postingConsumer(provider(async () => { throw new ProcessError("invalid_input", "closed_period: El período está cerrado"); }))(ctx, payload);
    expect(failures).toEqual([expect.objectContaining({ code: "closed_period", ruleId: "r1" })]);
  });
});

// Whole-branch review F-2.1: the provider's reversal learns the reversal rule, so a reversal the ledger refuses is a pending of that rule
// (accounting.posting.retry re-runs it) instead of a rule-less pending nothing can retry.
describe("postingConsumer and a reversal rule", () => {
  it("passes the rule's id to the provider's reverse", async () => {
    const seen: unknown[] = [];
    const reversal: RuleTemplate = { date: "$.date", description: "Anulación {{number}}", lines: [], reverseOf: { event: "x.issued", sourceId: "$.sourceId" } };
    const consume = postingConsumer({
      ...provider(async () => ({ entryId: null })),
      rulesFor: async () => [{ id: "r-void", event: "x.voided", journalId: "j1", template: reversal, priority: 100 }],
      reverse: async (_c, ref) => { seen.push(ref); return null; },
    });
    await consume(ctx, { ...payload, sourceId: "0192b4c0-0000-7000-8000-0000000000aa" });
    expect(seen).toEqual([{ event: "x.issued", sourceId: "0192b4c0-0000-7000-8000-0000000000aa", ruleId: "r-void" }]);
  });
});
