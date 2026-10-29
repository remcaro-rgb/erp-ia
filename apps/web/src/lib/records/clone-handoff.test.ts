// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import type { CloneResult } from "./clone";
import { handOffClone, pendingClone, releaseClone, subscribeClones } from "./clone-handoff";

const copy = (entity: string, sourceRowId = "0192a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b"): Extract<CloneResult, { ok: true }> => ({
  ok: true,
  entity,
  sourceRowId,
  sourceTitle: "Almacenes Éxito S.A.",
  values: { legal_name: "Almacenes Éxito S.A." },
  carry: {},
  refLabels: {},
});

describe("clone handoff", () => {
  it("keeps the copy for its entity's create form only, until it is released", () => {
    const party = handOffClone(copy("core.party"))!;
    expect(party.values).toEqual({ legal_name: "Almacenes Éxito S.A." });
    expect(pendingClone("core.product")).toBeNull();
    expect(pendingClone("core.party")).toBe(party);
    // Reading does not take it (React may render the form twice before it is shown).
    expect(pendingClone("core.party")).toBe(party);
    releaseClone(party);
    expect(pendingClone("core.party")).toBeNull();
  });

  it("tells two copies of the same source apart, and releasing an older one keeps the newer", () => {
    const first = handOffClone(copy("core.party"))!;
    const second = handOffClone(copy("core.party"))!;
    expect(second.handoffId).not.toBe(first.handoffId);
    releaseClone(first);
    expect(pendingClone("core.party")).toBe(second);
    releaseClone(second);
    releaseClone(null);
    expect(pendingClone("core.party")).toBeNull();
  });

  it("tells its subscribers when a copy arrives or goes, until they unsubscribe", () => {
    let calls = 0;
    const unsubscribe = subscribeClones(() => calls++);
    const party = handOffClone(copy("core.party"))!;
    releaseClone(party);
    // Releasing what is no longer waiting changes nothing.
    releaseClone(party);
    expect(calls).toBe(2);
    unsubscribe();
    releaseClone(handOffClone(copy("core.party")));
    expect(calls).toBe(2);
  });
});
