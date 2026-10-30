import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineProcess } from "../define";
import type { ProcessDef } from "../../registry/types";

// `permission: "none"` skips the role matrix, so it is reserved for the kernel's own self-service processes
// (a user's preferences, and their own second step, design §22.19): module kernel, kind update or consult, id under
// `kernel.user_prefs.` or `kernel.user.mfa.`.

const base = (over: Partial<ProcessDef>): ProcessDef => ({
  id: "kernel.user_prefs.set",
  module: "kernel",
  kind: "update",
  permission: "none",
  description: "prueba",
  input: z.object({}),
  output: z.null(),
  handler: async () => null,
  ...over,
});

describe("defineProcess permission opt-out", () => {
  it("accepts a kernel user-prefs update or consult", () => {
    expect(defineProcess(base({})).permission).toBe("none");
    expect(defineProcess(base({ id: "kernel.user_prefs.list", kind: "consult" })).kind).toBe("consult");
  });

  it("refuses it for another module, another kind or another kernel process", () => {
    expect(() => defineProcess(base({ id: "core.party.create", module: "core", kind: "create" }))).toThrow(/permission "none"/);
    expect(() => defineProcess(base({ id: "kernel.user_prefs.purge", kind: "delete" }))).toThrow(/permission "none"/);
    expect(() => defineProcess(base({ id: "kernel.custom_field.set" }))).toThrow(/permission "none"/);
    expect(() => defineProcess(base({ id: "sales.user_prefs.set", module: "sales" }))).toThrow(/permission "none"/);
  });

  it("accepts the user's own second-step processes and nothing else of kernel.user", () => {
    expect(defineProcess(base({ id: "kernel.user.mfa.disable" })).permission).toBe("none");
    expect(() => defineProcess(base({ id: "kernel.user.other" }))).toThrow(/permission "none"/);
    expect(() => defineProcess(base({ id: "kernel.user.consult", kind: "consult" }))).toThrow(/permission "none"/);
    expect(() => defineProcess(base({ id: "kernel.user.mfa.purge", kind: "delete" }))).toThrow(/permission "none"/);
    expect(() => defineProcess(base({ id: "core.user.mfa.disable", module: "core" }))).toThrow(/permission "none"/);
  });

  it("leaves processes without the opt-out alone", () => {
    expect(defineProcess(base({ id: "core.party.create", module: "core", kind: "create", permission: undefined })).id).toBe("core.party.create");
  });
});
