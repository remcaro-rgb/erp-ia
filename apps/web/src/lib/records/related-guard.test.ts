import { describe, expect, it, vi } from "vitest";
import { guardRelated } from "./related-guard";

describe("guardRelated: the related-documents tab never takes the record page down", () => {
  it("answers what the loader answers", async () => {
    expect(await guardRelated(async () => ({ count: 2 }))).toEqual({ count: 2 });
    expect(await guardRelated(async () => null)).toBeNull();
  });

  it("answers null and logs when the loader fails, whatever the failure (a SQL error, a step-up demand, a timeout)", async () => {
    const log = vi.fn();
    for (const failure of [new Error("handler_failed"), Object.assign(new Error("step_up_required"), { code: "step_up_required" }), "timeout", undefined]) {
      expect(await guardRelated(() => Promise.reject(failure), log)).toBeNull();
    }
    expect(log).toHaveBeenCalledTimes(4);
  });

  it("answers null when the loader throws before it returns a promise", async () => {
    expect(await guardRelated(() => { throw new Error("sync"); }, () => undefined)).toBeNull();
  });
});
