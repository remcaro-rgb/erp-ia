import { describe, expect, it } from "vitest";
import { ACCOUNT_ROLES } from "../roles";
import { RuleTemplate } from "../template";
import { invoiceTemplate } from "./fixtures";

describe("posting rule template schema", () => {
  it("accepts the §5.4 invoice template", () => {
    expect(RuleTemplate.safeParse(invoiceTemplate).success).toBe(true);
  });
  it("refuses a line with both role and account, or neither", () => {
    const line = { side: "debit", amount: "$.a" };
    expect(RuleTemplate.safeParse({ description: "x", lines: [{ ...line, role: "cash", account: "1105" }] }).success).toBe(false);
    expect(RuleTemplate.safeParse({ description: "x", lines: [line] }).success).toBe(false);
  });
  it("refuses forEach with a second wildcard or without one", () => {
    const base = { role: "cash", side: "debit", amount: "$.a" };
    expect(RuleTemplate.safeParse({ description: "x", lines: [{ ...base, forEach: "$.a[*].b[*]" }] }).success).toBe(false);
    expect(RuleTemplate.safeParse({ description: "x", lines: [{ ...base, forEach: "$.a" }] }).success).toBe(false);
    expect(RuleTemplate.safeParse({ description: "x", lines: [{ ...base, forEach: "$.a[*]" }] }).success).toBe(true);
  });
  it("catalogues the roles of §5.3 plus suspense", () => {
    expect(ACCOUNT_ROLES).toContain("suspense");
    expect(ACCOUNT_ROLES).toHaveLength(29);
  });
});
