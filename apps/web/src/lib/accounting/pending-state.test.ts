import { describe, expect, it } from "vitest";
import { pendingByDocument } from "./pending-state";

const A = "0190a000-0000-7000-8000-000000000001";
const B = "0190a000-0000-7000-8000-000000000002";
const F = "0190a000-0000-7000-8000-0000000000f1";

describe("pendingByDocument (the badge of a document's record frame)", () => {
  it("a queued event of an enabled module is queued", () => {
    expect(pendingByDocument([{ source_id: A, state: "queued", failure_id: null }], "enabled").get(A)).toEqual({ state: "queued" });
  });

  it("a failure carries its id and wins over a queued event of the same document, in either order", () => {
    const failed = { source_id: A, state: "failed", failure_id: F };
    const queued = { source_id: A, state: "queued", failure_id: null };
    expect(pendingByDocument([queued, failed], "enabled").get(A)).toEqual({ state: "failed", failureId: F });
    expect(pendingByDocument([failed, queued], "enabled").get(A)).toEqual({ state: "failed", failureId: F });
  });

  it("an event parked because accounting is switched off or not bought reads parked, with the Task 50.9 reason", () => {
    const rows = [{ source_id: A, state: "queued", failure_id: null }];
    expect(pendingByDocument(rows, "switched_off").get(A)).toEqual({ state: "parked", reason: "accounting_disabled" });
    expect(pendingByDocument(rows, "not_purchased").get(A)).toEqual({ state: "parked", reason: "not_entitled" });
  });

  it("a failure stays failed whatever the gate; documents are independent; unknown states are ignored", () => {
    const map = pendingByDocument(
      [{ source_id: A, state: "failed", failure_id: F }, { source_id: B, state: "queued", failure_id: null }, { source_id: B, state: "other", failure_id: null }],
      "switched_off",
    );
    expect(map.get(A)).toEqual({ state: "failed", failureId: F });
    expect(map.get(B)).toEqual({ state: "parked", reason: "accounting_disabled" });
    expect(map.size).toBe(2);
  });

  it("nothing pending is an empty map", () => {
    expect(pendingByDocument([], "enabled").size).toBe(0);
  });

  it("a dead-lettered event reads dead, loses to a failure and beats a queued event, in any order", () => {
    const dead = { source_id: A, state: "dead", failure_id: null };
    const queued = { source_id: A, state: "queued", failure_id: null };
    const failed = { source_id: A, state: "failed", failure_id: F };
    expect(pendingByDocument([dead], "enabled").get(A)).toEqual({ state: "dead" });
    expect(pendingByDocument([queued, dead], "switched_off").get(A)).toEqual({ state: "dead" });
    expect(pendingByDocument([dead, queued], "enabled").get(A)).toEqual({ state: "dead" });
    expect(pendingByDocument([dead, failed], "enabled").get(A)).toEqual({ state: "failed", failureId: F });
    expect(pendingByDocument([failed, dead], "enabled").get(A)).toEqual({ state: "failed", failureId: F });
  });
});
