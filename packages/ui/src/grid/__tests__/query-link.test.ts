import { describe, expect, it } from "vitest";
import { decodeGridQuery, encodeGridQuery } from "../query-link";

describe("grid query link", () => {
  it("round-trips filters, sort and columns", () => {
    const state = { filters: [{ field: "city", op: "eq" as const, value: "Bogotá" }], sort: [{ field: "legal_name", dir: "asc" as const }], page: 1, pageSize: 50, columns: ["legal_name", "city"] };
    expect(decodeGridQuery(encodeGridQuery(state))).toEqual({ filters: state.filters, sort: state.sort, columns: state.columns });
  });
  it("drops what is not a filter or a sort, and reads nothing from garbage", () => {
    const q = encodeURIComponent(JSON.stringify({ filters: [{ field: "a", op: "drop table" }, { field: "b", op: "eq", value: 1 }], sort: [{ field: "c", dir: "up" }] }));
    expect(decodeGridQuery(q)).toEqual({ filters: [{ field: "b", op: "eq", value: 1 }], sort: [] });
    expect(decodeGridQuery("%7Bnot json")).toBeNull();
    expect(decodeGridQuery(null)).toBeNull();
    expect(decodeGridQuery(encodeURIComponent("42"))).toBeNull();
  });
});
