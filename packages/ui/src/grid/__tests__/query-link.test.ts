import { describe, expect, it } from "vitest";
import { decodeGridQuery, gridQueryHref } from "../query-link";

// The assistant's "Abrir como grid" address (`/parties?q=…`): encoded once when the address is built, decoded once by
// the URL parser (`searchParams.get`), and parsed as JSON as it arrives.

/** What a page sees of the `q` parameter of an address: the URL parser has already decoded it. */
const received = (href: string) => new URLSearchParams(href.split("?")[1]).get("q");

describe("grid query link", () => {
  it("round-trips filters, sort and columns through an address", () => {
    const state = { filters: [{ field: "city", op: "eq" as const, value: "Bogotá" }], sort: [{ field: "legal_name", dir: "asc" as const }], page: 1, pageSize: 50, columns: ["legal_name", "city"] };
    expect(decodeGridQuery(received(gridQueryHref("/parties", state)))).toEqual({ filters: state.filters, sort: state.sort, columns: state.columns });
  });

  it("keeps a value with a percent sign as it is (it is decoded once, not twice)", () => {
    const filters = [
      { field: "legal_name", op: "contains" as const, value: "50%" },
      { field: "trade_name", op: "eq" as const, value: "%41" },
      { field: "notes", op: "contains" as const, value: "a&b=c#d é" },
    ];
    expect(decodeGridQuery(received(gridQueryHref("/parties", { filters, sort: [], page: 1, pageSize: 50 })))?.filters).toEqual(filters);
  });

  it("drops what is not a filter or a sort, and reads nothing from garbage", () => {
    const q = JSON.stringify({ filters: [{ field: "a", op: "drop table" }, { field: "b", op: "eq", value: 1 }], sort: [{ field: "c", dir: "up" }] });
    expect(decodeGridQuery(q)).toEqual({ filters: [{ field: "b", op: "eq", value: 1 }], sort: [] });
    expect(decodeGridQuery("{not json")).toBeNull();
    expect(decodeGridQuery(null)).toBeNull();
    expect(decodeGridQuery("42")).toBeNull();
  });
});
