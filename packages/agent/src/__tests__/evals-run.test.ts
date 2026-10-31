import { describe, expect, it } from "vitest";
import { convertArrayToReadableStream, MockLanguageModelV4 } from "ai/test";
import { buildReport, matchCall, runEvalCases, toolName, type EvalCase, type EvalResult } from "../index";

// The model-backed evaluation runner (rule 30, design §7.1): the matcher, the recorder that keeps a tool from ever
// running, and the pass rule (every core case and ≥ 90 % overall, owner 2026-10-30).

const expectQuery: EvalCase["expect"] = {
  process: "kernel.data.query",
  input: { entity: "accounting.ledger_line", filters: [{ field: "account_class", op: "eq", value: "5" }], groupBy: ["cost_center_code"] },
};

describe("matchCall", () => {
  it("subset match on input, tool by provider-safe name; a missing field or a wrong enum is a reason", () => {
    const tool = toolName("kernel.data.query");
    expect(tool).toBe("kernel__data__query");
    // Extra fields and extra array elements are fine; the expected ones must be there.
    expect(
      matchCall(expectQuery, {
        tool,
        input: { entity: "accounting.ledger_line", filters: [{ field: "date", op: "gte", value: "2026-10-01" }, { field: "account_class", op: "eq", value: "5", extra: 1 }], groupBy: ["cost_center_code", "date"], limit: 20 },
      }),
    ).toBeNull();
    expect(matchCall(expectQuery, { tool: "kernel__data__query", input: { entity: "accounting.ledger_line", filters: [] } })).toMatch(/filters/);
    expect(matchCall(expectQuery, { tool, input: { entity: "accounting.ledger_line", filters: [{ field: "account_class", op: "ne", value: "5" }], groupBy: ["cost_center_code"] } })).toMatch(/filters/);
    expect(matchCall(expectQuery, { tool, input: { entity: "core.party", filters: expectQuery.input!.filters, groupBy: ["cost_center_code"] } })).toMatch(/entity/);
    expect(matchCall(expectQuery, { tool: "accounting__report__aging", input: {} })).toMatch(/kernel__data__query/);
    expect(matchCall({ process: "accounting.report.aging" }, { tool: "accounting__report__aging", input: { anything: true } })).toBeNull();
  });
});

describe("runEvalCases", () => {
  const cases: EvalCase[] = [
    { id: "a", prompt: "consulta uno", tier: "core", expect: { process: "kernel.data.query", input: { entity: "core.party" } } },
    { id: "b", prompt: "consulta dos", tier: "extended", expect: { process: "kernel.data.query", input: { entity: "core.party" } } },
  ];
  const descriptor = { name: "kernel__data__query", description: "q", inputSchema: { type: "object" as const }, source: { type: "builtin" as const } };

  const modelCalling = (input: unknown) =>
    new MockLanguageModelV4({
      provider: "mock",
      modelId: "mock/x",
      doStream: async () => ({
        stream: convertArrayToReadableStream([
          { type: "stream-start" as const, warnings: [] },
          { type: "tool-call" as const, toolCallId: "c1", toolName: "kernel__data__query", input: JSON.stringify(input) },
          { type: "finish" as const, finishReason: { unified: "tool-calls" as const, raw: undefined }, usage: { inputTokens: { total: 5, noCache: 5, cacheRead: 0, cacheWrite: undefined }, outputTokens: { total: 2, text: 2, reasoning: undefined } } },
        ]),
      }),
    });

  it("runEvals never executes a tool: the recorder answers and no process runs", async () => {
    // The runner takes no deps and no connection: the only thing a tool call can reach is the recorder.
    const usage: number[] = [];
    const results = await runEvalCases({
      model: modelCalling({ entity: "core.party" }),
      system: "sistema",
      descriptors: [descriptor],
      cases,
      onUsage: async (_i, tokens) => void usage.push(tokens.inputTokens),
    });
    expect(results.map((r) => [r.id, r.pass, r.got?.tool])).toEqual([["a", true, "kernel__data__query"], ["b", true, "kernel__data__query"]]);
    expect(results[0]!.got).toEqual({ tool: "kernel__data__query", input: { entity: "core.party" } });
    expect(usage).toEqual([5, 5]);
  });

  it("a case the model answers with text fails with a reason, and the run goes on", async () => {
    const textModel = new MockLanguageModelV4({
      provider: "mock",
      modelId: "mock/x",
      doStream: async () => ({
        stream: convertArrayToReadableStream([
          { type: "stream-start" as const, warnings: [] },
          { type: "text-start" as const, id: "t" },
          { type: "text-delta" as const, id: "t", delta: "no sé" },
          { type: "text-end" as const, id: "t" },
          { type: "finish" as const, finishReason: { unified: "stop" as const, raw: "stop" }, usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: undefined }, outputTokens: { total: 1, text: 1, reasoning: undefined } } },
        ]),
      }),
    });
    const results = await runEvalCases({ model: textModel, system: "s", descriptors: [descriptor], cases, onUsage: async () => {} });
    expect(results.every((r) => !r.pass && r.got === null && r.why)).toBe(true);
  });
});

describe("buildReport", () => {
  const result = (id: string, tier: EvalResult["tier"], pass: boolean): EvalResult => ({ id, tier, pass, got: null });

  it("corePass is false when one core case fails even with passRate 0.95", () => {
    const results = [result("core-1", "core", false), ...Array.from({ length: 19 }, (_, i) => result(`ext-${i}`, "extended", true))];
    const report = buildReport("anthropic/claude-opus-5.5", results);
    expect(report.passRate).toBe(0.95);
    expect(report.corePass).toBe(false);
    expect(report.model).toBe("anthropic/claude-opus-5.5");
  });

  it("corePass holds when every core case passes", () => {
    expect(buildReport("m", [result("c", "core", true), result("e", "extended", false)])).toMatchObject({ corePass: true, passRate: 0.5 });
    expect(buildReport("m", [])).toMatchObject({ corePass: true, passRate: 0 });
  });
});
