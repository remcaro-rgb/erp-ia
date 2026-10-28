import { describe, expect, it } from "vitest";
import { buildQuery, GridState, operatorsFor, QueryError, type GridStateInput } from "../query";
import { defineEntity } from "../registry";

// The grid's server-side query builder (design §9, rules 14 and 20). A party-like entity of the test's own:
// the kernel never knows a module by name.
const partyEntity = defineEntity({
  id: "core.party",
  module: "core",
  schema: "core",
  table: "parties",
  label: "entity.core.party",
  displayField: "name",
  defaultSort: { field: "name", dir: "asc" },
  fields: [
    { name: "seq", type: "number", label: "field.seq" },
    { name: "name", type: "text", label: "field.name", searchable: true },
    { name: "document_number", type: "text", label: "field.document_number", searchable: true },
    { name: "kind", type: "enum", label: "field.kind", enumValues: ["customer", "supplier", "employee"] },
    { name: "credit_limit", type: "money", label: "field.credit_limit", sensitivity: "confidential" },
    { name: "is_active", type: "boolean", label: "field.is_active" },
    { name: "birthday", type: "date", label: "field.birthday" },
    { name: "created_at", type: "datetime", label: "field.created_at" },
    { name: "category_id", type: "ref", label: "field.category_id", ref: { entity: "core.product_category", display: "name" } },
    { name: "tax_responsibilities", type: "json", label: "field.tax_responsibilities" },
    { name: "notes", type: "text", label: "field.notes", filterable: false, sortable: false },
    { name: "extra", type: "json", label: "field.extra", sortable: false },
  ],
});

const state = (overrides: Partial<GridStateInput> = {}): GridStateInput => ({ filters: [], sort: [], page: 1, pageSize: 50, ...overrides });
const all = () => true;
const codeOf = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (error) {
    return error instanceof QueryError ? error.code : `not a QueryError: ${String(error)}`;
  }
  return undefined;
};

describe("buildQuery", () => {
  it("builds a filtered, sorted, paged select over the masked view", () => {
    const q = buildQuery(partyEntity, { filters: [{ field: "name", op: "contains", value: "éxito" }], sort: [{ field: "name", dir: "asc" }], page: 2, pageSize: 50 }, () => true);
    expect(q.sql).toMatch(/from core\.v_parties/);
    expect(q.sql).toMatch(/"name" ilike \$1/);
    expect(q.params[0]).toBe("%éxito%");
    expect(q.sql).toMatch(/order by "name" asc/);
    expect(q.sql).toMatch(/limit 50 offset 50/);
    // Same filter, no paging, for the total.
    expect(q.countSql).toMatch(/^select count\(\*\)::int as total from core\.v_parties where/);
    expect(q.countSql).toMatch(/"name" ilike \$1/);
    expect(q.countSql).not.toMatch(/limit|order by/);
  });

  it("never reads the base table", () => {
    const q = buildQuery(partyEntity, state(), all);
    expect(q.sql).not.toMatch(/core\.parties\b/);
    expect(q.countSql).not.toMatch(/core\.parties\b/);
  });

  it("refuses a filter on a hidden field", () => {
    expect(() => buildQuery(partyEntity, { filters: [{ field: "credit_limit", op: "gt", value: 1 }], sort: [], page: 1, pageSize: 50 }, (f) => f !== "credit_limit")).toThrow(/field_hidden/);
  });

  it("refuses sorting by a hidden or masked field (a masked field never filters or sorts)", () => {
    expect(codeOf(() => buildQuery(partyEntity, state({ sort: [{ field: "credit_limit", dir: "desc" }] }), (f) => f !== "credit_limit"))).toBe("field_hidden");
  });

  it("refuses unknown fields and non-filterable fields", () => {
    expect(codeOf(() => buildQuery(partyEntity, state({ filters: [{ field: "nope", op: "eq", value: "x" }] }), all))).toBe("unknown_field");
    expect(codeOf(() => buildQuery(partyEntity, state({ sort: [{ field: "nope", dir: "asc" }] }), all))).toBe("unknown_field");
    expect(codeOf(() => buildQuery(partyEntity, state({ filters: [{ field: "notes", op: "contains", value: "x" }] }), all))).toBe("field_not_filterable");
    expect(codeOf(() => buildQuery(partyEntity, state({ sort: [{ field: "notes", dir: "asc" }] }), all))).toBe("field_not_sortable");
    expect(codeOf(() => buildQuery(partyEntity, state({ columns: ["name", 'name"; drop table x; --'] }), all))).toBe("unknown_field");
  });

  it("refuses an operator its field type does not offer, and a value that does not fit", () => {
    expect(codeOf(() => buildQuery(partyEntity, state({ filters: [{ field: "name", op: "gt", value: "a" }] }), all))).toBe("bad_operator");
    expect(codeOf(() => buildQuery(partyEntity, state({ filters: [{ field: "kind", op: "contains", value: "cust" }] }), all))).toBe("bad_operator");
    expect(codeOf(() => buildQuery(partyEntity, state({ filters: [{ field: "credit_limit", op: "gt", value: "mucho" }] }), all))).toBe("bad_value");
    expect(codeOf(() => buildQuery(partyEntity, state({ filters: [{ field: "kind", op: "eq", value: "alien" }] }), all))).toBe("bad_value");
    expect(codeOf(() => buildQuery(partyEntity, state({ filters: [{ field: "category_id", op: "eq", value: "not-a-uuid" }] }), all))).toBe("bad_value");
    expect(codeOf(() => buildQuery(partyEntity, state({ filters: [{ field: "birthday", op: "eq", value: "31/12/2026" }] }), all))).toBe("bad_value");
  });

  it("between on a money field uses two parameters", () => {
    const q = buildQuery(partyEntity, state({ filters: [{ field: "credit_limit", op: "between", value: 1_000_000, value2: "5000000" }] }), all);
    expect(q.sql).toMatch(/"credit_limit" between symmetric \$1::numeric and \$2::numeric/);
    expect(q.params).toEqual([1_000_000, 5_000_000]);
    expect(codeOf(() => buildQuery(partyEntity, state({ filters: [{ field: "credit_limit", op: "between", value: 1 }] }), all))).toBe("bad_value");
  });

  it("offers the operators of each field type", () => {
    expect(operatorsFor("text")).toEqual(["contains", "ncontains", "starts", "ends", "eq", "neq", "is_null", "not_null"]);
    expect(operatorsFor("money")).toEqual(["eq", "neq", "gt", "gte", "lt", "lte", "between", "is_null", "not_null"]);
    expect(operatorsFor("number")).toEqual(operatorsFor("money"));
    expect(operatorsFor("enum")).toEqual(["eq", "neq", "in"]);
    expect(operatorsFor("boolean")).toEqual(["eq", "neq", "in"]);
    expect(operatorsFor("date")).toEqual(["eq", "gt", "lt", "between"]);
    expect(operatorsFor("datetime")).toEqual(["eq", "gt", "lt", "between"]);
  });

  it("text operators escape LIKE wildcards and compare without case", () => {
    const q = buildQuery(
      partyEntity,
      state({
        filters: [
          { field: "name", op: "starts", value: "50%_off" },
          { field: "name", op: "ends", value: "S.A.S." },
          { field: "name", op: "eq", value: "Éxito" },
          { field: "name", op: "ncontains", value: "x" },
          { field: "name", op: "is_null" },
        ],
      }),
      all,
    );
    expect(q.params).toEqual(["50\\%\\_off%", "%S.A.S.", "Éxito", "%x%"]);
    expect(q.sql).toMatch(/"name" ilike \$1 and "name" ilike \$2 and "name" ilike \$3 and not \("name" ilike \$4\) and nullif\("name", ''\) is null/);
  });

  it("enum filters work on scalar and array columns (a party's kind is text[])", () => {
    const q = buildQuery(partyEntity, state({ filters: [{ field: "kind", op: "in", value: ["customer", "supplier"] }, { field: "is_active", op: "eq", value: true }] }), all);
    expect(q.sql).toMatch(/exists \(select 1 from unnest\(\$1::text\[\]\) as v\(x\) where to_jsonb\("kind"\) @> to_jsonb\(v\.x\)\)/);
    expect(q.sql).toMatch(/"is_active" = \$2::boolean/);
    expect(q.params).toEqual([["customer", "supplier"], true]);
  });

  it("date filters compare days, in the company's time zone for datetimes", () => {
    const q = buildQuery(partyEntity, state({ filters: [{ field: "created_at", op: "between", value: "2026-01-01", value2: "2026-01-31" }, { field: "birthday", op: "lt", value: "2000-01-01" }] }), all, { timeZone: "America/Bogota" });
    expect(q.sql).toMatch(/\("created_at" at time zone \$1\)::date between \$2::date and \$3::date/);
    expect(q.sql).toMatch(/"birthday" < \$4::date/);
    expect(q.params).toEqual(["America/Bogota", "2026-01-01", "2026-01-31", "2000-01-01"]);
  });

  it("joins conditions with AND binding tighter than OR (OR-groups of AND-runs)", () => {
    // A y B o C y D  =  (A y B) o (C y D)
    const q = buildQuery(
      partyEntity,
      state({
        filters: [
          { field: "name", op: "contains", value: "a" },
          { field: "credit_limit", op: "gt", value: 10, join: "and" },
          { field: "name", op: "contains", value: "c", join: "or" },
          { field: "is_active", op: "eq", value: false },
        ],
      }),
      all,
    );
    expect(q.sql).toMatch(/where \(\("name" ilike \$1 and "credit_limit" > \$2::numeric\) or \("name" ilike \$3 and "is_active" = \$4::boolean\)\)/);
    // The first condition's join is meaningless and ignored.
    const first = buildQuery(partyEntity, state({ filters: [{ field: "name", op: "contains", value: "a", join: "or" }] }), all);
    expect(first.sql).toMatch(/where \(\("name" ilike \$1\)\)/);
  });

  it("searches the searchable fields the caller sees with one parameter", () => {
    const q = buildQuery(partyEntity, state({ search: "  9003  ", filters: [{ field: "is_active", op: "eq", value: true }] }), all);
    expect(q.sql).toMatch(/where \("name" ilike \$1 or "document_number" ilike \$1\) and \(\("is_active" = \$2::boolean\)\)/);
    expect(q.params).toEqual(["%9003%", true]);
    // A searchable field the caller cannot see is not searched.
    const masked = buildQuery(partyEntity, state({ search: "9003" }), (f) => f !== "document_number");
    expect(masked.sql).toMatch(/where \("name" ilike \$1\)/);
    // Nothing searchable is visible: nothing matches.
    expect(buildQuery(partyEntity, state({ search: "x" }), (f) => f !== "name" && f !== "document_number").sql).toMatch(/where false/);
  });

  it("filters admin-defined extra data with the custom field's type, and refuses keys the caller's roles cannot view", () => {
    const extras = { origen: "text", peso: "number", vence: "date", premium: "bool", canal: "list" } as const;
    const q = buildQuery(
      partyEntity,
      state({
        filters: [
          { field: "extra.origen", op: "contains", value: "huila" },
          { field: "extra.peso", op: "gte", value: 2.5 },
          { field: "extra.premium", op: "eq", value: true },
          { field: "extra.canal", op: "in", value: ["Retail", "HORECA"] },
        ],
        sort: [{ field: "extra.peso", dir: "desc" }],
      }),
      all,
      { extras },
    );
    expect(q.sql).toMatch(/\("extra" ->> 'origen'\) ilike \$1/);
    expect(q.sql).toMatch(/\(case when \("extra" ->> 'peso'\) ~ '\^-\?\[0-9\]\+\(\[\.,\]\[0-9\]\+\)\?\$' then replace\("extra" ->> 'peso', ',', '\.'\)::numeric end\) >= \$2::numeric/);
    expect(q.sql).toMatch(/\("extra" ->> 'premium'\) = any\(\$3::text\[\]\)/);
    expect(q.sql).toMatch(/\("extra" ->> 'canal'\) = any\(\$4::text\[\]\)/);
    expect(q.sql).toMatch(/order by \(case when \("extra" ->> 'peso'\).* desc nulls last/);
    expect(q.params).toEqual(["%huila%", 2.5, ["true", "Sí"], ["Retail", "HORECA"]]);

    // Defined but not viewable by the caller's roles, or the extra column itself masked: refused.
    expect(codeOf(() => buildQuery(partyEntity, state({ filters: [{ field: "extra.origen", op: "eq", value: "x" }] }), (f) => f !== "extra.origen", { extras }))).toBe("field_hidden");
    expect(codeOf(() => buildQuery(partyEntity, state({ filters: [{ field: "extra.origen", op: "eq", value: "x" }] }), (f) => f !== "extra", { extras }))).toBe("field_hidden");
    // Nobody defined it, or the key is malformed.
    expect(codeOf(() => buildQuery(partyEntity, state({ filters: [{ field: "extra.nadie", op: "eq", value: "x" }] }), all, { extras }))).toBe("unknown_field");
    expect(codeOf(() => buildQuery(partyEntity, state({ filters: [{ field: "extra.x') or true --", op: "eq", value: "x" }] }), all, { extras }))).toBe("unknown_field");
    expect(codeOf(() => buildQuery(partyEntity, state({ filters: [{ field: "extra.peso", op: "contains", value: "1" }] }), all, { extras }))).toBe("bad_operator");
  });

  it("selects the requested columns plus id, and every field by default (masked ones come back null from the view)", () => {
    expect(buildQuery(partyEntity, state({ columns: ["name", "credit_limit"] }), (f) => f !== "credit_limit").sql).toMatch(/^select "id", "name", "credit_limit" from core\.v_parties/);
    const q = buildQuery(partyEntity, state(), all);
    expect(q.sql).toMatch(/^select "id", "seq", "name", "document_number", "kind",/);
  });

  it("sorts by the entity's default sort with id as the tie-breaker; shift-sorts keep their order", () => {
    expect(buildQuery(partyEntity, state(), all).sql).toMatch(/order by "name" asc nulls last, "id" asc limit 50 offset 0$/);
    const multi = buildQuery(partyEntity, state({ sort: [{ field: "kind", dir: "desc" }, { field: "seq", dir: "asc" }] }), all);
    expect(multi.sql).toMatch(/order by "kind" desc nulls last, "seq" asc nulls last, "id" asc/);
  });

  it("aggregates visible numeric fields over the whole filter", () => {
    const q = buildQuery(partyEntity, state({ filters: [{ field: "is_active", op: "eq", value: true }], aggregates: [{ field: "credit_limit", fn: "sum" }, { field: "seq", fn: "count" }] }), all);
    expect(q.aggregateSql).toBe('select sum("credit_limit") as "sum:credit_limit", count("seq") as "count:seq" from core.v_parties where (("is_active" = $1::boolean))');
    expect(codeOf(() => buildQuery(partyEntity, state({ aggregates: [{ field: "credit_limit", fn: "sum" }] }), (f) => f !== "credit_limit"))).toBe("field_hidden");
    expect(codeOf(() => buildQuery(partyEntity, state({ aggregates: [{ field: "name", fn: "sum" }] }), all))).toBe("bad_operator");
  });

  it("the state schema bounds the page size and the operators", () => {
    expect(GridState.safeParse(state({ pageSize: 501 })).success).toBe(false);
    expect(GridState.safeParse(state({ page: 0 })).success).toBe(false);
    expect(GridState.safeParse({ ...state(), filters: [{ field: "name", op: "like", value: "x" }] }).success).toBe(false);
    expect(GridState.safeParse(state({ search: "x", filters: [{ field: "name", op: "contains", value: "x", join: "or" }] })).success).toBe(true);
  });
});
