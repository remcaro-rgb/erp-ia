import { describe, expect, it } from "vitest";
import { requirementApplies } from "../required";

// The TypeScript twin of the condition `case` in kernel.missing_attachments (migration 0007): the record page
// shows the checklist of the requirements that apply to the record, so both must agree.

describe("requirementApplies", () => {
  const juridicaCo = { countryCode: "CO", personType: "1", kind: ["customer"] };

  it("no condition always applies", () => {
    expect(requirementApplies(null, {})).toBe(true);
    expect(requirementApplies(null, juridicaCo)).toBe(true);
  });

  it("co needs a Colombian record; co-juridica also a juridical person", () => {
    expect(requirementApplies("co", juridicaCo)).toBe(true);
    expect(requirementApplies("co", { ...juridicaCo, countryCode: "US" })).toBe(false);
    expect(requirementApplies("co", { ...juridicaCo, countryCode: null })).toBe(false);
    expect(requirementApplies("co-juridica", juridicaCo)).toBe(true);
    expect(requirementApplies("co-juridica", { ...juridicaCo, personType: "2" })).toBe(false);
    expect(requirementApplies("co-juridica", { ...juridicaCo, countryCode: "VE" })).toBe(false);
  });

  it("proveedor and cliente read the party kinds", () => {
    expect(requirementApplies("proveedor", { kind: ["supplier", "customer"] })).toBe(true);
    expect(requirementApplies("proveedor", { kind: ["customer"] })).toBe(false);
    expect(requirementApplies("proveedor", { kind: null })).toBe(false);
    expect(requirementApplies("cliente", { kind: ["customer"] })).toBe(true);
    expect(requirementApplies("cliente", { kind: ["supplier"] })).toBe(false);
  });

  it("a condition it does not know applies: a requirement is never silently waived", () => {
    expect(requirementApplies("something-new", juridicaCo)).toBe(true);
  });

  it("a fact the caller cannot see (undefined, hidden by a field permission) does not waive the requirement either", () => {
    expect(requirementApplies("co", {})).toBe(true);
    expect(requirementApplies("co-juridica", { countryCode: "CO" })).toBe(true);
    expect(requirementApplies("proveedor", {})).toBe(true);
    // Known facts still decide.
    expect(requirementApplies("co", { countryCode: "US" })).toBe(false);
  });
});
