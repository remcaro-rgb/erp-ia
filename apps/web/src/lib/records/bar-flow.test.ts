import { afterEach, describe, expect, it, vi } from "vitest";
import { actionKey, chainedStep, clearBarFlow, keepNotice, stepLeftAfterSave, stepsAfterSave, takeNotice, takeNoticeLink } from "./bar-flow";

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
    expect(step).toHaveBeenCalledWith("id-1", "2026-11-03T10:00:00.000Z", null);
    // Once only.
    expect(chain.resume("id-1", null)).toBe(false);
    expect(step).toHaveBeenCalledTimes(1);
  });

  it("the save with the step-up code hands the step the status it left the record in (Task 14b)", () => {
    const step = vi.fn(async () => {});
    const chain = chainedStep();
    chain.arm(step);
    expect(chain.resume("q-1", "v1", "pending")).toBe(true);
    expect(step).toHaveBeenCalledWith("q-1", "v1", "pending");
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

describe("stepLeftAfterSave (Task 14b)", () => {
  it("a save that left the record pending approval has no Grabar left; any other status (or none answered) has", () => {
    expect(stepLeftAfterSave("pending")).toBe(false);
    for (const status of ["saved", "draft", "approved", null, undefined]) expect(stepLeftAfterSave(status)).toBe(true);
  });
});

describe("stepsAfterSave (plan 2B Task 20 fix round 1: saveOnly)", () => {
  it("runs a documento's Grabar after its form saved, unless the frame saves only (an invoice's Emitir is its own step)", () => {
    expect(stepsAfterSave({ entityType: "documento" }, false, true)).toEqual({ grabar: true, submit: false, nothing: false });
    expect(stepsAfterSave({ entityType: "documento", saveOnly: true }, false, true)).toEqual({ grabar: false, submit: false, nothing: false });
    // Guardar on an unchanged saveOnly Borrador does nothing at all: no Grabar, no Emitir.
    expect(stepsAfterSave({ entityType: "documento", saveOnly: true }, false, false)).toEqual({ grabar: false, submit: false, nothing: true });
    expect(stepsAfterSave({ entityType: "documento" }, false, false)).toEqual({ grabar: true, submit: false, nothing: false });
  });

  it("a maestro has no Grabar; «Guardar y enviar a aprobación» still sends it", () => {
    expect(stepsAfterSave({ entityType: "maestro" }, false, true)).toEqual({ grabar: false, submit: false, nothing: false });
    expect(stepsAfterSave({ entityType: "maestro" }, false, false)).toEqual({ grabar: false, submit: false, nothing: true });
    expect(stepsAfterSave({ entityType: "maestro" }, true, false)).toEqual({ grabar: false, submit: true, nothing: false });
    expect(stepsAfterSave({ entityType: "documento", saveOnly: true }, true, true)).toEqual({ grabar: false, submit: true, nothing: false });
  });
});
