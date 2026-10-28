import { describe, expect, it, vi } from "vitest";
import { ProcessError } from "../errors";

describe("ProcessError", () => {
  it("is recognised by instanceof, also when another copy of the module created it", async () => {
    expect(new ProcessError("forbidden", "x")).toBeInstanceOf(ProcessError);
    expect(new Error("x")).not.toBeInstanceOf(ProcessError);
    expect((null as unknown as object) instanceof ProcessError).toBe(false);
    // A second copy of the module, as a bundler that compiles the kernel twice would load it.
    vi.resetModules();
    const copy = await import("../errors");
    expect(copy.ProcessError).not.toBe(ProcessError);
    const foreign = new copy.ProcessError("invalid_input", "y", { details: ["31: solo dígitos"] });
    expect(foreign).toBeInstanceOf(ProcessError);
    expect(new ProcessError("not_found", "z")).toBeInstanceOf(copy.ProcessError);
  });

  it("is a handler refusal unless the pipeline says it is a gate one", () => {
    expect(new ProcessError("forbidden", "x").stage).toBe("handler");
    expect(new ProcessError("forbidden", "x", { stage: "gate" }).stage).toBe("gate");
  });
});
