import { describe, expect, it } from "vitest";
import type { EntityDef } from "../../registry/entities";
import { buildQuery, ROW_MASKED } from "../build-query";

// D20 (entity types spec §10, owner 2026-11-03): a documento's restricted lines are rows of the masked view with every identifying value
// null and the row flag set. The grid keeps them as «••••» placeholder rows (they count in pagination); a filter on a masked value never
// matches them, a total over them is the parent's true total (read from the parent's masked view) or unknown, never a partial sum.
const lines: EntityDef = {
  id: "probe.line",
  module: "probe",
  schema: "probe",
  table: "lines",
  label: "entity.probe.line",
  displayField: "line_no",
  defaultSort: { field: "line_no", dir: "asc" },
  fields: [
    { name: "entry_id", type: "ref", label: "x" },
    { name: "line_no", type: "number", label: "x" },
    { name: "account_id", type: "ref", label: "x" },
    { name: "description", type: "text", label: "x", searchable: true },
    { name: "debit", type: "money", label: "x" },
  ],
  rowMask: {
    flag: "is_restricted",
    fields: ["account_id", "description", "debit"],
    totals: { parentField: "entry_id", view: "probe.v_entries", columns: { debit: "total_debit" } },
  },
};
const all = () => true;
const st = (over: Record<string, unknown>) => ({ filters: [], sort: [], page: 1, pageSize: 50, ...over }) as never;
const ENTRY = "0190a000-0000-7000-8000-000000000001";

describe("row-masked placeholder rows (D20)", () => {
  it("selects the row flag as the placeholder marker and keeps the rows (no filter on the flag)", () => {
    const q = buildQuery(lines, st({ filters: [{ field: "entry_id", op: "eq", value: ENTRY }] }), all);
    expect(q.sql).toContain(`"is_restricted" as "${ROW_MASKED}"`);
    expect(q.countSql).not.toContain("is_restricted");
    expect(q.columns).not.toContain(ROW_MASKED);
  });

  it("a filter or search on a masked field never matches a placeholder row, whatever the operator", () => {
    const q = buildQuery(lines, st({ filters: [{ field: "debit", op: "is_null" }], search: "x" }), all);
    expect(q.sql).toMatch(/not coalesce\("is_restricted", false\) and \("debit" is null\)/);
    expect(q.sql).toMatch(/not coalesce\("is_restricted", false\) and \("description"/);
    // A field the placeholder keeps (line_no) filters as usual.
    expect(buildQuery(lines, st({ filters: [{ field: "line_no", op: "eq", value: 1 }] }), all).sql).not.toMatch(/not coalesce/);
  });

  it("sorting by a masked field puts placeholders last, never by their hidden value", () => {
    const q = buildQuery(lines, st({ sort: [{ field: "debit", dir: "desc" }] }), all);
    expect(q.sql).toContain(`case when coalesce("is_restricted", false) then null else "debit" end desc nulls last`);
  });

  it("the total of the parent's lines is the parent's true total, read from its masked view", () => {
    const q = buildQuery(lines, st({ filters: [{ field: "entry_id", op: "eq", value: ENTRY }], aggregates: [{ field: "debit", fn: "sum" }] }), all);
    expect(q.aggregateSql).toMatch(/\(select "total_debit" from probe\.v_entries where "id" = '0190a000-0000-7000-8000-000000000001'::uuid\) as "sum:debit"/);
    // Grouped, a subtotal is per group: never the parent's total.
    const grouped = buildQuery(lines, st({ filters: [{ field: "entry_id", op: "eq", value: ENTRY }], groupBy: ["line_no"], aggregates: [{ field: "debit", fn: "sum" }] }), all);
    expect(grouped.groupAggregateSql).toContain(`case when bool_or(coalesce("is_restricted", false)) then null else sum("debit") end`);
  });

  it("any other total over placeholder rows is unknown (null), never the partial sum of the visible rows", () => {
    const q = buildQuery(lines, st({ filters: [{ field: "entry_id", op: "eq", value: ENTRY }, { field: "line_no", op: "gt", value: 1 }], aggregates: [{ field: "debit", fn: "sum" }] }), all);
    expect(q.aggregateSql).toContain(`case when bool_or(coalesce("is_restricted", false)) then null else sum("debit") end as "sum:debit"`);
  });
});
