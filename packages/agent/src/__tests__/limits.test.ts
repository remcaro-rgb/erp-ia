import { describe, expect, it } from "vitest";
import { costUsd, DEFAULT_PRICE, MODEL_PRICES, overBudget } from "../runtime/limits";
import { stepUsage } from "../runtime/usage";

// Usage limits and metering (rule 27, design §7.4, §20): what a call costs, when a company is over its monthly token
// allowance, and how a model step's usage becomes a usage row. checkTokenBudget against the database is in
// turn.integration.test.ts.

describe("cost of a call", () => {
  it("prices Opus 5.5 at USD 4 / 20 per million input / output tokens, cache reads at USD 0.20", () => {
    expect(MODEL_PRICES["anthropic/claude-opus-5.5"]).toEqual({ input: 4, output: 20, cachedInput: 0.2 });
    // The design's turn: 6k input of which 5k cached, 600 output.
    expect(costUsd("anthropic/claude-opus-5.5", { inputTokens: 6000, outputTokens: 600, cachedTokens: 5000 })).toBeCloseTo(0.001 * 4 + 0.005 * 0.2 + 0.0006 * 20, 6);
  });

  it("an unknown model costs the most expensive known rate; a test double costs nothing", () => {
    expect(DEFAULT_PRICE).toEqual(MODEL_PRICES["anthropic/claude-opus-5.5"]);
    expect(costUsd("acme/unknown", { inputTokens: 1_000_000, outputTokens: 0 })).toBe(4);
    expect(costUsd("mock/model", { inputTokens: 1_000_000, outputTokens: 1_000_000 })).toBe(0);
  });

  it("never counts more cached tokens than input tokens", () => {
    expect(costUsd("anthropic/claude-opus-5.5", { inputTokens: 10, outputTokens: 0, cachedTokens: 50 })).toBeCloseTo(10 * 0.2 / 1e6, 9);
  });
});

describe("overBudget", () => {
  it("is over once the month's tokens reach the limit; no limit means no cap", () => {
    expect(overBudget(11, 10)).toBe(true);
    expect(overBudget(10, 10)).toBe(true);
    expect(overBudget(9, 10)).toBe(false);
    expect(overBudget(1_000_000_000, null)).toBe(false);
  });
});

describe("stepUsage", () => {
  it("reads input, output and cache-read tokens from a model step, missing counts as zero", () => {
    expect(
      stepUsage({
        usage: { inputTokens: 120, outputTokens: 30, inputTokenDetails: { noCacheTokens: 20, cacheReadTokens: 100, cacheWriteTokens: undefined }, outputTokenDetails: { textTokens: 30, reasoningTokens: undefined }, totalTokens: 150 },
        model: { provider: "gateway", modelId: "anthropic/claude-opus-5.5" },
      } as never),
    ).toEqual({ model: "anthropic/claude-opus-5.5", inputTokens: 120, outputTokens: 30, cachedTokens: 100 });
    expect(stepUsage({ usage: { inputTokens: undefined, outputTokens: undefined, inputTokenDetails: {}, outputTokenDetails: {} }, model: { provider: "x", modelId: "x/y" } } as never)).toEqual({
      model: "x/y",
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
    });
  });
});
