// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CloneResult } from "./clone";
import { clearCloneHandoff, currentClone, finishClone, handOffClone, leaveClone, subscribeClones, takeClone } from "./clone-handoff";

const copy = (entity: string, sourceRowId = "0192a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b"): Extract<CloneResult, { ok: true }> => ({
  ok: true,
  entity,
  sourceRowId,
  sourceTitle: "Almacenes Éxito S.A.",
  values: { legal_name: "Almacenes Éxito S.A." },
  carry: {},
  refLabels: {},
});

afterEach(() => {
  clearCloneHandoff();
  vi.useRealTimers();
});

describe("clone handoff", () => {
  it("hands the copy to its entity's create form only; the form takes it once and keeps it while shown", () => {
    const party = handOffClone(copy("core.party"))!;
    expect(currentClone("core.product")).toBeNull();
    expect(currentClone("core.party")).toBe(party);
    takeClone("core.party");
    expect(currentClone("core.party")).toBe(party);
    // Taken: a second take finds nothing new and keeps it.
    takeClone("core.party");
    expect(currentClone("core.party")).toBe(party);
    finishClone("core.party");
    expect(currentClone("core.party")).toBeNull();
  });

  it("a form left (hidden or unmounted) lets its copy go, unless it is shown again at once (React's strict re-run)", () => {
    vi.useFakeTimers();
    const party = handOffClone(copy("core.party"))!;
    takeClone("core.party");
    leaveClone("core.party");
    takeClone("core.party");
    vi.runAllTimers();
    expect(currentClone("core.party")).toBe(party);
    leaveClone("core.party");
    vi.runAllTimers();
    // Shown again later without a fresh "Duplicar": an empty form.
    expect(currentClone("core.party")).toBeNull();
  });

  it("tells two copies of the same source apart, and a fresh one replaces the one in the form", () => {
    const first = handOffClone(copy("core.party"))!;
    takeClone("core.party");
    const second = handOffClone(copy("core.party"))!;
    expect(second.handoffId).not.toBe(first.handoffId);
    expect(currentClone("core.party")).toBe(second);
    takeClone("core.party");
    expect(currentClone("core.party")).toBe(second);
  });

  it("clearCloneHandoff forgets every copy (sign-out, company switch)", () => {
    vi.useFakeTimers();
    handOffClone(copy("core.party"));
    takeClone("core.party");
    handOffClone(copy("support.ticket"));
    leaveClone("core.party");
    clearCloneHandoff();
    vi.runAllTimers();
    expect(currentClone("core.party")).toBeNull();
    expect(currentClone("support.ticket")).toBeNull();
  });

  it("tells its subscribers about every change, until they unsubscribe", () => {
    let calls = 0;
    const unsubscribe = subscribeClones(() => calls++);
    handOffClone(copy("core.party"));
    takeClone("core.party");
    finishClone("core.party");
    // Nothing to finish: no change.
    finishClone("core.party");
    expect(calls).toBe(3);
    unsubscribe();
    handOffClone(copy("core.party"));
    expect(calls).toBe(3);
  });
});
