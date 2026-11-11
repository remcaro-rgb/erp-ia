import type { CustomFieldType } from "../custom-fields/types";
import type { EntityDef } from "../registry/entities";
import { IDENTIFIER, type FieldDef, type FieldType } from "../registry/fields";
import { QueryError } from "./errors";
import {
  CODE_SET_OPS,
  customFilterKind,
  EXTRA_KEY,
  EXTRA_PREFIX,
  filterKind,
  GridState,
  NO_VALUE_OPS,
  OPERATORS,
  orGroups,
  type AggregateFn,
  type FilterKind,
  type FilterOp,
  type GridFilter,
  type GridStateInput,
} from "./grid-state";

// The grid's query builder (design §9, rules 14 and 20): turns a grid state into one parameterised select over
// the entity's masked view `<schema>.v_<table>`, never the base table, so RLS, the party scope and field masking
// apply exactly as everywhere else. Identifiers come from the registry (checked against IDENTIFIER and quoted);
// every value is a parameter. Pure: the caller resolves what the caller may see (`visibleFields`).

export interface BuildQueryOptions {
  /**
   * The admin-defined fields of the entity in the caller's company, by key, with their type. `extra.<key>`
   * filters and sorts refer to them; a key not listed is unknown. Whether the caller's roles may view a key is
   * asked through `visibleFields("extra.<key>")`.
   */
  extras?: Readonly<Record<string, CustomFieldType>>;
  /** IANA time zone of the company: a datetime is compared as the day it falls on there. */
  timeZone?: string;
  /**
   * Rows `offset`..`offset + limit` instead of the state's page: an export reads the whole filter in windows of its
   * own, beyond the grid's page size. The state's `page` and `pageSize` are then ignored.
   */
  window?: { offset: number; limit: number };
}

export interface BuiltQuery {
  /** The page of rows. */
  sql: string;
  /** Parameters of `sql`, `countSql` and `aggregateSql` (they share the where clause). */
  params: unknown[];
  /** `total`: the rows of the whole filter. */
  countSql: string;
  /** One row with `<fn>:<field>` columns over the whole filter, when the state asks for aggregates. */
  aggregateSql?: string;
  /**
   * One row per group and level over the whole filter, when the state has `groupBy`: the group fields, `grouping(...)`
   * as "grouping", `count(*)` as "count" and the `<fn>:<field>` aggregates, `group by rollup(...)`. Its last row is the
   * grand total (grouping = every field), which the caller drops.
   */
  groupAggregateSql?: string;
  /** The `groupBy` fields in order, the first columns of `groupAggregateSql`. */
  groupFields?: string[];
  /** The columns `sql` returns, `id` first. */
  columns: string[];
}

/** One field as the builder uses it: the SQL expression to filter and sort by, and what it accepts. */
interface Target {
  name: string;
  kind: FilterKind;
  /** Filter expression (a datetime is its day in the company's zone); built only when a filter needs it, since the
   *  zone is a parameter and an unused parameter breaks the statement. */
  filterExpr: () => string;
  /** Sort expression. */
  sortExpr: string;
  type: FieldType | { custom: CustomFieldType };
  enumValues?: readonly string[];
  filterable: boolean;
  sortable: boolean;
}

/** A target with its filter expression built. */
type Bound = Target & { expr: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const NUMBER = /^-?\d+(\.\d+)?$/;
const TIME_ZONE = /^[A-Za-z_]+(\/[A-Za-z0-9_+-]+)*$/;
const MAX_TEXT = 500;
const MAX_LIST = 100;
/** A label can match many codes ("san" matches dozens of DANE municipalities); Colombia has about 1100. */
const MAX_CODES = 2000;

const quote = (name: string) => `"${name}"`;

/** The column a row-masked entity's rows carry when the row is a «••••» placeholder (D20, `EntityDef.rowMask`). */
export const ROW_MASKED = "__row_masked";

/** Escapes LIKE's wildcards and its escape character (backslash, Postgres' default). */
const likeEscape = (text: string) => text.replace(/[\\%_]/g, (c) => `\\${c}`);

function isCalendarDate(text: string): boolean {
  const m = DATE.exec(text);
  if (!m) return false;
  const date = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return date.getUTCFullYear() === Number(m[1]) && date.getUTCMonth() === Number(m[2]) - 1 && date.getUTCDate() === Number(m[3]);
}

const BOOL_TEXT: Record<"true" | "false", string[]> = { true: ["true", "Sí"], false: ["false", "No"] };

/**
 * Builds the select of one grid page. Throws `QueryError`: `unknown_field` (not in the registry, not a defined
 * extra key, or not a selectable column), `field_hidden` (hidden or masked for the caller, rule 14: a masked
 * field never filters, sorts, searches or aggregates), `field_not_filterable` / `field_not_sortable` (the
 * registry says so), `bad_operator` (the field's type does not take it), `bad_value` (a value that does not fit).
 */
export function buildQuery(
  entity: EntityDef,
  input: GridStateInput,
  visibleFields: (field: string) => boolean,
  options: BuildQueryOptions = {},
): BuiltQuery {
  for (const part of [entity.schema, entity.table]) {
    if (!IDENTIFIER.test(part)) throw new Error(`entity ${entity.id}: invalid identifier "${part}"`);
  }
  const parsed = GridState.safeParse(input);
  if (!parsed.success) throw new QueryError("bad_value", "state", parsed.error.issues[0]?.message);
  const state = parsed.data;
  const view = `${entity.schema}.v_${entity.table}`;
  const fields = new Map<string, FieldDef>(entity.fields.map((f) => [f.name, f]));
  // D20: a placeholder row of a row-masked entity never matches, sorts or aggregates by a value it masks.
  const rowMask = entity.rowMask;
  if (rowMask && !IDENTIFIER.test(rowMask.flag)) throw new Error(`entity ${entity.id}: invalid rowMask flag "${rowMask.flag}"`);
  const flag = rowMask ? `coalesce(${quote(rowMask.flag)}, false)` : "";
  const rowMasked = (name: string) => rowMask?.fields.includes(name) === true;
  const unmaskedOnly = (name: string, condition: string) => (rowMasked(name) ? `(not ${flag} and (${condition}))` : condition);
  for (const name of fields.keys()) if (!IDENTIFIER.test(name)) throw new Error(`entity ${entity.id}: invalid field name "${name}"`);

  const params: unknown[] = [];
  const param = (value: unknown) => {
    params.push(value);
    return `$${params.length}`;
  };
  let tzParam: string | undefined;
  const dayOf = (column: string) => {
    if (options.timeZone === undefined) return `(${column})::date`;
    if (!TIME_ZONE.test(options.timeZone)) throw new Error(`invalid time zone "${options.timeZone}"`);
    tzParam ??= param(options.timeZone);
    return `(${column} at time zone ${tzParam})::date`;
  };

  /** The field `name` refers to, checked to exist and to be visible to the caller. */
  const target = (name: string): Target => {
    if (name.startsWith(EXTRA_PREFIX)) {
      const key = name.slice(EXTRA_PREFIX.length);
      const type = EXTRA_KEY.test(key) ? options.extras?.[key] : undefined;
      if (!type || !fields.has("extra")) throw new QueryError("unknown_field", name);
      if (!visibleFields("extra") || !visibleFields(name)) throw new QueryError("field_hidden", name);
      const text = `("extra" ->> '${key}')`;
      const expr =
        type === "number"
          ? `(case when ${text} ~ '^-?[0-9]+([.,][0-9]+)?$' then replace("extra" ->> '${key}', ',', '.')::numeric end)`
          : type === "date"
            ? `(case when ${text} ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then ${text}::date end)`
            : text;
      return { name, kind: customFilterKind(type), filterExpr: () => expr, sortExpr: expr, type: { custom: type }, filterable: true, sortable: true };
    }
    if (name === "id" && !fields.has("id")) {
      return { name, kind: "uuid", filterExpr: () => quote("id"), sortExpr: quote("id"), type: "uuid", filterable: true, sortable: true };
    }
    const field = fields.get(name);
    if (!field) throw new QueryError("unknown_field", name);
    if (!visibleFields(name)) throw new QueryError("field_hidden", name);
    const column = quote(name);
    const kind = filterKind(field.type);
    const filterExpr = () => (field.type === "datetime" ? dayOf(column) : field.type === "json" ? `(${column})::text` : column);
    return {
      name,
      kind,
      filterExpr,
      sortExpr: rowMasked(name) ? `case when ${flag} then null else ${column} end` : column,
      type: field.type,
      enumValues: field.enumValues,
      filterable: field.filterable ?? true,
      sortable: field.sortable ?? true,
    };
  };

  // ---- values -------------------------------------------------------------------------------------
  const bad = (t: Target, why: string): never => {
    throw new QueryError("bad_value", t.name, why);
  };
  const textValue = (t: Target, value: unknown): string => {
    const text = typeof value === "number" && Number.isFinite(value) ? String(value) : value;
    if (typeof text !== "string" || text.trim() === "" || text.length > MAX_TEXT) return bad(t, "text expected");
    return text;
  };
  const numberValue = (t: Target, value: unknown): number => {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && NUMBER.test(value.trim())) return Number(value.trim());
    return bad(t, "number expected");
  };
  const dateValue = (t: Target, value: unknown): string => (typeof value === "string" && isCalendarDate(value) ? value : bad(t, "date YYYY-MM-DD expected"));
  const uuidValue = (t: Target, value: unknown): string => (typeof value === "string" && UUID.test(value) ? value : bad(t, "uuid expected"));
  const boolValue = (t: Target, value: unknown): boolean => {
    if (value === true || value === "true") return true;
    if (value === false || value === "false") return false;
    if (typeof t.type === "object" && (value === "Sí" || value === "No")) return value === "Sí";
    return bad(t, "true or false expected");
  };
  const listOf = <T>(t: Target, value: unknown, item: (v: unknown) => T): T[] => {
    if (!Array.isArray(value) || value.length === 0 || value.length > MAX_LIST) return bad(t, `a list of 1 to ${MAX_LIST} values expected`);
    return value.map(item);
  };

  // ---- predicates ---------------------------------------------------------------------------------
  const predicate = (filter: GridFilter): string => {
    const found = target(filter.field);
    if (!found.filterable) throw new QueryError("field_not_filterable", found.name);
    const op: FilterOp = filter.op;
    const codeSet = found.kind === "text" && CODE_SET_OPS.has(op);
    if (!codeSet && !OPERATORS[found.kind].includes(op)) throw new QueryError("bad_operator", found.name, `${op} does not apply to ${found.kind}`);
    return unmaskedOnly(found.name, condition(found, op, filter));
  };

  const condition = (found: Target, op: FilterOp, filter: GridFilter): string => {
    const codeSet = found.kind === "text" && CODE_SET_OPS.has(op);
    const t: Bound = { ...found, expr: found.filterExpr() };
    if (NO_VALUE_OPS.has(op)) return nullTest(t, op === "is_null");
    const { value, value2 } = filter;
    if (codeSet) return codeSetPredicate(t, op, value);
    switch (t.kind) {
      case "text":
      case "json":
        return textPredicate(t, op, textValue(t, value));
      case "number": {
        if (op === "between") return `${t.expr} between symmetric ${param(numberValue(t, value))}::numeric and ${param(numberValue(t, value2))}::numeric`;
        return `${t.expr} ${COMPARE[op]} ${param(numberValue(t, value))}::numeric`;
      }
      case "date": {
        if (op === "between") return `${t.expr} between ${param(dateValue(t, value))}::date and ${param(dateValue(t, value2))}::date`;
        return `${t.expr} ${COMPARE[op]} ${param(dateValue(t, value))}::date`;
      }
      case "uuid":
        if (op === "in") return `${t.expr} = any(${param(listOf(t, value, (v) => uuidValue(t, v)))}::uuid[])`;
        return `${t.expr} ${COMPARE[op]} ${param(uuidValue(t, value))}::uuid`;
      case "enum":
        return enumPredicate(t, op, value);
    }
  };

  const nullTest = (t: Bound, isNull: boolean): string => {
    const test =
      t.kind === "text"
        ? `nullif(${t.expr}, '') is null`
        : t.kind === "json"
          ? `(${t.sortExpr} is null or ${t.expr} in ('', '{}', '[]', 'null', '""'))`
          : `${t.expr} is null`;
    if (isNull) return test;
    return t.kind === "text" ? `nullif(${t.expr}, '') is not null` : t.kind === "json" ? `not ${test}` : `${t.expr} is not null`;
  };

  const textPredicate = (t: Bound, op: FilterOp, text: string): string => {
    const escaped = likeEscape(text);
    const pattern = op === "contains" || op === "ncontains" ? `%${escaped}%` : op === "starts" ? `${escaped}%` : op === "ends" ? `%${escaped}` : escaped;
    const like = `${t.expr} ilike ${param(pattern)}`;
    return op === "ncontains" || op === "neq" ? `not (${like})` : like;
  };

  /** `in`: the field holds one of the codes (none: nothing matches). `nin`: it holds a value that is none of them. */
  const codeSetPredicate = (t: Bound, op: FilterOp, value: unknown): string => {
    if (!Array.isArray(value) || value.length > MAX_CODES) return bad(t, `a list of up to ${MAX_CODES} codes expected`);
    const codes = value.map((v) => textValue(t, v));
    const present = `nullif(${t.expr}, '') is not null`;
    if (codes.length === 0) return op === "in" ? "false" : present;
    const member = `${t.expr} = any(${param(codes)}::text[])`;
    return op === "in" ? member : `${present} and not (${member})`;
  };

  const enumPredicate = (t: Bound, op: FilterOp, value: unknown): string => {
    const custom = typeof t.type === "object" ? t.type.custom : undefined;
    if (custom === "bool") {
      const texts = (v: unknown) => BOOL_TEXT[boolValue(t, v) ? "true" : "false"];
      const list = op === "in" ? [...new Set(listOf(t, value, texts).flat())] : texts(value);
      const test = `${t.expr} = any(${param(list)}::text[])`;
      return op === "neq" ? `not (${test})` : test;
    }
    if (custom === "list") {
      if (op === "in") return `${t.expr} = any(${param(listOf(t, value, (v) => textValue(t, v)))}::text[])`;
      return `${t.expr} ${COMPARE[op]} ${param(textValue(t, value))}::text`;
    }
    if (t.type === "boolean") {
      if (op === "in") return `${t.expr} = any(${param(listOf(t, value, (v) => boolValue(t, v)))}::boolean[])`;
      return `${t.expr} ${COMPARE[op]} ${param(boolValue(t, value))}::boolean`;
    }
    // A registry enum: the column may be a scalar or an array of values (a party's kind is text[]); jsonb
    // containment matches a scalar equal to the value and an array holding it.
    const member = (v: unknown): string => {
      const text = textValue(t, v);
      return t.enumValues && !t.enumValues.includes(text) ? bad(t, `one of ${t.enumValues.join(", ")} expected`) : text;
    };
    if (op === "in") return `exists (select 1 from unnest(${param(listOf(t, value, member))}::text[]) as v(x) where to_jsonb(${t.expr}) @> to_jsonb(v.x))`;
    const test = `to_jsonb(${t.expr}) @> to_jsonb(${param(member(value))}::text)`;
    return op === "neq" ? `not (${test})` : test;
  };

  // ---- where --------------------------------------------------------------------------------------
  const clauses: string[] = [];
  const search = state.search?.trim();
  if (search) {
    const searched = entity.fields.filter((f) => (f.searchable ?? false) && visibleFields(f.name));
    if (searched.length === 0) clauses.push("false");
    else {
      const p = param(`%${likeEscape(search)}%`);
      clauses.push(`(${searched.map((f) => unmaskedOnly(f.name, `${f.type === "text" ? quote(f.name) : `(${quote(f.name)})::text`} ilike ${p}`)).join(" or ")})`);
    }
  }
  if (state.filters.length > 0) {
    const groups = orGroups(state.filters).map((group) => `(${group.map(predicate).join(" and ")})`);
    clauses.push(`(${groups.join(" or ")})`);
  }
  const where = clauses.length > 0 ? ` where ${clauses.join(" and ")}` : "";

  // ---- order --------------------------------------------------------------------------------------
  const sortable = (name: string): Target => {
    const t = target(name);
    if (!t.sortable) throw new QueryError("field_not_sortable", t.name);
    return t;
  };
  const order: string[] = [];
  const ordered = new Set<string>();
  const orderBy = (t: Target, dir: "asc" | "desc") => {
    if (ordered.has(t.name)) return;
    ordered.add(t.name);
    order.push(`${t.sortExpr} ${dir} nulls last`);
  };
  const groupBy = state.groupBy ?? [];
  const groups = groupBy.map((name) => sortable(name));
  for (const t of groups) orderBy(t, "asc");
  const sorts = state.sort.length > 0 ? state.sort : fields.has(entity.defaultSort.field) && visibleFields(entity.defaultSort.field) ? [entity.defaultSort] : [];
  for (const s of sorts) orderBy(sortable(s.field), s.dir);
  if (!ordered.has("id")) order.push(`${quote("id")} asc`);

  // ---- columns and aggregates ---------------------------------------------------------------------
  const columns = ["id"];
  for (const name of state.columns ?? entity.fields.map((f) => f.name)) {
    if (name !== "id" && !fields.has(name)) throw new QueryError("unknown_field", name);
    if (!columns.includes(name)) columns.push(name);
  }

  const isRollupSum = (field: string, fn: AggregateFn) => fn === "sum" && entity.fields.some((f) => f.name === field && f.rollup);
  // D20: the filter is exactly "the lines of one parent" (no search, no other condition): the parent's id, else null.
  const parentOnly = (() => {
    const totals = rowMask?.totals;
    if (!totals || search || state.filters.length !== 1) return null;
    const [only] = state.filters;
    return only!.field === totals.parentField && only!.op === "eq" && typeof only!.value === "string" && UUID.test(only!.value) ? only!.value : null;
  })();
  const aggregateOf = ({ field, fn }: { field: string; fn: AggregateFn }, rollupAware: boolean): string => {
    const t = target(field);
    if (!aggregateApplies(fn, t.kind)) throw new QueryError("bad_operator", t.name, `${fn} does not apply to ${t.kind}`);
    if (rowMasked(t.name)) {
      const parentColumn = rowMask!.totals?.columns[t.name];
      if (rollupAware && fn === "sum" && parentColumn && parentOnly) {
        if (!IDENTIFIER.test(parentColumn) || !/^[a-z][a-z0-9_]*\.v_[a-z0-9_]+$/.test(rowMask!.totals!.view)) throw new Error(`entity ${entity.id}: invalid rowMask totals`);
        // The id is checked against UUID above; inlined, since a parameter only this statement used would break the others.
        return `(select ${quote(parentColumn)} from ${rowMask!.totals!.view} where "id" = '${parentOnly}'::uuid) as "${fn}:${t.name}"`;
      }
      const expr = t.kind === "date" ? quote(t.name) : t.filterExpr();
      return `case when bool_or(${flag}) then null else ${fn}(${expr}) end as "${fn}:${t.name}"`;
    }
    if (rollupAware && isRollupSum(field, fn)) {
      // UX-OD-3: the total of a roll-up column is the sum of the rows with no ancestor in the result (a group and its leaves are
      // never both added). The ancestors are walked in the whole visible view, so a root outside the filter still covers its
      // descendants inside it. Without a visible parent_id the structure is unknown and so is the total.
      if (!visibleFields("parent_id")) return `null::numeric as "sum:${t.name}"`;
      const column = quote(t.name);
      return `(with recursive hit as (select "id", "parent_id", ${column} as val from ${view}${where}),
        up(id, anc) as (select "id", "parent_id" from hit where "parent_id" is not null
          union select up.id, v."parent_id" from up join ${view} v on v."id" = up.anc where v."parent_id" is not null)
        select sum(val) from hit where not exists (select 1 from up where up.id = hit."id" and up.anc in (select "id" from hit))) as "sum:${t.name}"`;
    }
    // A date aggregates as stored (no day conversion, so no zone parameter).
    const expr = t.kind === "date" ? t.sortExpr : t.filterExpr();
    return `${fn}(${expr}) as "${fn}:${t.name}"`;
  };
  const aggregates = (state.aggregates ?? []).map((a) => aggregateOf(a, true));
  // Group subtotals leave a roll-up column out: its group row already carries it and a sum would repeat the descendants.
  const groupAggregates = (state.aggregates ?? []).filter((a) => !isRollupSum(a.field, a.fn)).map((a) => aggregateOf(a, false));

  // Distinct group fields only (a repeated one would make a level that adds nothing).
  const groupExprs = [...new Map(groups.map((t) => [t.name, t])).values()].map((t) => ({ name: t.name, expr: t.sortExpr }));
  const groupAggregateSql =
    groupExprs.length > 0
      ? `select ${[
          ...groupExprs.map((g) => `${g.expr} as ${quote(g.name)}`),
          `grouping(${groupExprs.map((g) => g.expr).join(", ")}) as "grouping"`,
          `count(*)::int as "count"`,
          ...groupAggregates,
        ].join(", ")} from ${view}${where} group by rollup(${groupExprs.map((g) => g.expr).join(", ")}) order by ${groupExprs.map((g) => `${g.expr} nulls last`).join(", ")}`
      : undefined;

  const { offset, limit } = options.window ?? { offset: (state.page - 1) * state.pageSize, limit: state.pageSize };
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1) throw new QueryError("bad_value", "window", "offset and limit must be whole numbers");
  return {
    sql: `select ${[...columns.map(quote), ...(rowMask ? [`${quote(rowMask.flag)} as ${quote(ROW_MASKED)}`] : [])].join(", ")} from ${view}${where} order by ${order.join(", ")} limit ${limit} offset ${offset}`,
    params,
    countSql: `select count(*)::int as total from ${view}${where}`,
    ...(aggregates.length > 0 ? { aggregateSql: `select ${aggregates.join(", ")} from ${view}${where}` } : {}),
    ...(groupAggregateSql ? { groupAggregateSql, groupFields: groupExprs.map((g) => g.name) } : {}),
    columns,
  };
}

const COMPARE: Partial<Record<FilterOp, string>> = { eq: "=", neq: "<>", gt: ">", gte: ">=", lt: "<", lte: "<=" };

function aggregateApplies(fn: AggregateFn, kind: FilterKind): boolean {
  if (fn === "count") return true;
  if (fn === "sum" || fn === "avg") return kind === "number";
  return kind === "number" || kind === "date";
}
