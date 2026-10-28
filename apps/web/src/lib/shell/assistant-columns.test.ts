import { describe, expect, it } from "vitest";
import { CORE_ENTITIES } from "@erp/module-core";
import { assistantColumnsOf } from "./assistant-columns";

// What the assistant's result tables know of an entity (rule 14): the registry's labels and types with the caller's
// field modes, as the grid has them, and nothing the grid leaves out.

const t = (key: string) => `«${key}»`;
const party = CORE_ENTITIES.find((e) => e.id === "core.party")!;

describe("assistantColumnsOf", () => {
  const columns = assistantColumnsOf(party, { modes: { credit_limit: "hidden", balance: "masked" }, extras: [{ key: "canal", label: "Canal", type: "text", options: null, viewable: true }], timeZone: "America/Bogota" }, t);

  it("carries the caller's mode of each field and the translated label and type", () => {
    expect(columns.find((c) => c.field === "legal_name")).toEqual({ field: "legal_name", label: "«field.core.party.legal_name»", type: "text", mode: "visible" });
    expect(columns.find((c) => c.field === "balance")).toMatchObject({ type: "money", mode: "masked" });
    expect(columns.find((c) => c.field === "credit_limit")).toMatchObject({ mode: "hidden" });
  });

  it("leaves out what the grid leaves out: the internal JSON, and admin-defined fields (a query returns none of them as a column)", () => {
    expect(columns.map((c) => c.field)).not.toContain("extra");
    expect(columns.map((c) => c.field)).not.toContain("extra_free");
    expect(columns.some((c) => c.field.startsWith("extra."))).toBe(false);
  });
});
