import { describe, expect, it } from "vitest";
import { paramValues, reasonKeyOf, recommendationCloseInput, recommendationParam, recommendationRaiseInput, RECOMMENDATION_PARAMS_MAX } from "../recommend";

// The input a process hands ctx.recommendations (design §22.28, plan 2B Task 38): who sees it, what it is about, why, and the values its
// catalogue text names, each tagged with the field it shows so the kernel can mask it per viewer (rule 14).

const raise = {
  audienceProcess: "invoicing.invoice.create",
  subject: { entity: "sales.delivery", id: "0190a0f1-0000-7000-8000-000000000001" },
  reason: "over_invoicing",
  titleKey: "invoicing.recommendation.auto_skipped.title",
  bodyKey: "invoicing.recommendation.auto_skipped.body",
  params: { document: { value: "ENT-12", entity: "sales.delivery", field: "number" } },
};

describe("recommendationParam", () => {
  it("takes a text, a number or null, with or without its field", () => {
    for (const value of ["ENT-12", 3, null]) expect(recommendationParam.safeParse({ value }).success, String(value)).toBe(true);
    expect(recommendationParam.safeParse({ value: "x", entity: "sales.delivery", field: "number" }).success).toBe(true);
  });

  it("refuses an entity without its field and a field without its entity", () => {
    expect(recommendationParam.safeParse({ value: "x", entity: "sales.delivery" }).success).toBe(false);
    expect(recommendationParam.safeParse({ value: "x", field: "number" }).success).toBe(false);
  });

  it("refuses a long text, an object value and unknown keys", () => {
    expect(recommendationParam.safeParse({ value: "x".repeat(201) }).success).toBe(false);
    expect(recommendationParam.safeParse({ value: { a: 1 } }).success).toBe(false);
    expect(recommendationParam.safeParse({ value: "x", label: "y" }).success).toBe(false);
  });
});

describe("recommendationRaiseInput", () => {
  it("accepts an audience process, an audience role or both, and defaults the params to none", () => {
    expect(recommendationRaiseInput.safeParse(raise).success).toBe(true);
    const rest = { ...raise, audienceProcess: undefined };
    expect(recommendationRaiseInput.safeParse({ ...rest, audienceRoleId: "0190a0f1-0000-7000-8000-000000000002" }).success).toBe(true);
    const parsed = recommendationRaiseInput.parse({ ...raise, params: undefined });
    expect(parsed.params).toEqual({});
  });

  it("refuses a recommendation for nobody", () => {
    const rest = { ...raise, audienceProcess: undefined };
    expect(recommendationRaiseInput.safeParse(rest).success).toBe(false);
  });

  it("refuses a malformed audience process, reason, key or param name, and unknown keys", () => {
    expect(recommendationRaiseInput.safeParse({ ...raise, audienceProcess: "invoicing" }).success).toBe(false);
    for (const reason of ["Over", "1x", "over-invoicing", "", "x".repeat(101)]) expect(recommendationRaiseInput.safeParse({ ...raise, reason }).success, reason).toBe(false);
    expect(recommendationRaiseInput.safeParse({ ...raise, titleKey: "" }).success).toBe(false);
    expect(recommendationRaiseInput.safeParse({ ...raise, bodyKey: "x".repeat(201) }).success).toBe(false);
    expect(recommendationRaiseInput.safeParse({ ...raise, params: { "doc-number": { value: 1 } } }).success).toBe(false);
    expect(recommendationRaiseInput.safeParse({ ...raise, params: { Document: { value: 1 } } }).success).toBe(false);
    expect(recommendationRaiseInput.safeParse({ ...raise, title: "Texto" }).success).toBe(false);
  });

  it("caps the params", () => {
    const many = Object.fromEntries(Array.from({ length: RECOMMENDATION_PARAMS_MAX + 1 }, (_, i) => [`p${i}`, { value: i }]));
    expect(recommendationRaiseInput.safeParse({ ...raise, params: many }).success).toBe(false);
    const enough = Object.fromEntries(Array.from({ length: RECOMMENDATION_PARAMS_MAX }, (_, i) => [`p${i}`, { value: i }]));
    expect(recommendationRaiseInput.safeParse({ ...raise, params: enough }).success).toBe(true);
  });
});

describe("recommendationCloseInput", () => {
  it("takes the subject and an optional reason, nothing else", () => {
    expect(recommendationCloseInput.safeParse({ subject: raise.subject }).success).toBe(true);
    expect(recommendationCloseInput.safeParse({ subject: raise.subject, reason: "over_invoicing" }).success).toBe(true);
    expect(recommendationCloseInput.safeParse({ subject: { entity: "sales.delivery", id: "nope" } }).success).toBe(false);
    expect(recommendationCloseInput.safeParse({ subject: raise.subject, all: true }).success).toBe(false);
  });
});

describe("paramValues", () => {
  it("reads the value of each stored param; a masked one (value null) and anything malformed read as null", () => {
    expect(paramValues({ document: { value: "ENT-12", entity: "sales.delivery", field: "number" }, amount: { value: null }, count: { value: 3 }, odd: "x", deep: { value: { a: 1 } } }))
      .toEqual({ document: "ENT-12", amount: null, count: 3, odd: null, deep: null });
    expect(paramValues(null)).toEqual({});
    expect(paramValues([])).toEqual({});
  });
});

describe("reasonKeyOf", () => {
  it("is the reason's catalogue key in the raising module's namespace", () => {
    expect(reasonKeyOf("invoicing", "over_invoicing")).toBe("invoicing.recommendation.reason.over_invoicing");
    expect(reasonKeyOf(null, "x")).toBeNull();
    expect(reasonKeyOf("costing", null)).toBeNull();
  });
});
