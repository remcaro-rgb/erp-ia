import { describe, expect, it } from "vitest";
import { kpiSchema } from "../kpis";

// The KPI contract of the home screen (design §19a, OD-9): the optional trend is exactly 14 daily values, never negative.

const base = { id: "core.parties", label: "home.kpi.core_parties.label", value: 3, unit: "count" as const };

describe("kpiSchema series", () => {
  it("is optional", () => {
    expect(kpiSchema.safeParse(base).success).toBe(true);
  });

  it("accepts exactly 14 non-negative numbers, oldest to newest", () => {
    expect(kpiSchema.safeParse({ ...base, series: Array.from({ length: 14 }, (_, i) => i) }).success).toBe(true);
  });

  it("refuses another length, a negative value or a non-finite one", () => {
    expect(kpiSchema.safeParse({ ...base, series: Array(13).fill(1) }).success).toBe(false);
    expect(kpiSchema.safeParse({ ...base, series: Array(15).fill(1) }).success).toBe(false);
    expect(kpiSchema.safeParse({ ...base, series: [...Array(13).fill(1), -1] }).success).toBe(false);
    expect(kpiSchema.safeParse({ ...base, series: [...Array(13).fill(1), Number.NaN] }).success).toBe(false);
  });
});
