import { afterEach, describe, expect, it, vi } from "vitest";
import { actionKey, chainedStep, clearBarFlow, keepNotice, takeNotice, takeNoticeLink } from "./bar-flow";

// The action bar's flow across a navigation (Phase 2A.5 minors 2, 6, 7): an idempotency key per click, the lifecycle step left
// waiting by a step-up on the form's save, and a success notice that outlives the navigation that follows the action.

afterEach(() => {
  clearBarFlow();
  vi.useRealTimers();
});

describe("actionKey (minor 2)", () => {
  it("is a fresh key per click, shaped for the process idempotency table", () => {
    const a = actionKey("kernel.record.notify");
    const b = actionKey("kernel.record.notify");
    expect(a).not.toBe(b);
    expect(a).toMatch(/^bar:kernel\.record\.notify:[0-9a-f-]{36}$/);
  });
});

describe("keepNotice / takeNotice (minor 7)", () => {
  it("a notice kept for a record is taken once by the record's bar after the navigation", () => {
    keepNotice("core.party:1", "Listo");
    expect(takeNotice("core.party:1")).toBe("Listo");
    expect(takeNotice("core.party:1")).toBeNull();
    expect(takeNotice("core.party:2")).toBeNull();
  });

  it("a notice not taken within a few seconds is dropped (a later visit does not show it)", () => {
    vi.useFakeTimers();
    keepNotice("core.party:1", "Listo");
    vi.advanceTimersByTime(30_000);
    expect(takeNotice("core.party:1")).toBeNull();
  });
});

describe("chainedStep (minor 6)", () => {
  it("a step armed when the form's save stopped for a step-up runs once the form saves, with the saved id and version", async () => {
    const step = vi.fn(async () => {});
    const chain = chainedStep();
    chain.arm(step);
    expect(chain.resume("id-1", "2026-11-03T10:00:00.000Z")).toBe(true);
    expect(step).toHaveBeenCalledWith("id-1", "2026-11-03T10:00:00.000Z");
    // Once only.
    expect(chain.resume("id-1", null)).toBe(false);
    expect(step).toHaveBeenCalledTimes(1);
  });

  it("nothing armed (or disarmed by the next bar action): the form's save goes on as usual", () => {
    const chain = chainedStep();
    expect(chain.resume("id-1", null)).toBe(false);
    const step = vi.fn(async () => {});
    chain.arm(step);
    chain.disarm();
    expect(chain.resume("id-1", null)).toBe(false);
    expect(step).not.toHaveBeenCalled();
  });
});

describe("a notice's link", () => {
  it("travels with the notice and is taken once", () => {
    const link = { entity: "accounting.entry", id: "e-19", label: "NC-19" };
    keepNotice("accounting.entry:1", "Reversado con NC-19", link);
    expect(takeNoticeLink("accounting.entry:1")).toEqual(link);
    expect(takeNoticeLink("accounting.entry:1")).toBeNull();
  });
});
