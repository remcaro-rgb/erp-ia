import type { Sql } from "postgres";
import type { CustomFieldType } from "../custom-fields/types";
import { withClaims, type JwtClaims, type Tx } from "../db/client";
import type { EntityDef } from "../registry/entities";
import { buildQuery } from "./build-query";
import { EXTRA_PREFIX, type GridState } from "./grid-state";

/** How a field reaches the caller (rule 14, `kernel.field_mode`). */
export type FieldMode = "visible" | "masked" | "hidden";

/** An admin-defined field of the entity and whether the caller's roles may view it (`roles_view`). */
export interface GridExtraField {
  key: string;
  label: string;
  type: CustomFieldType;
  options: string[] | null;
  viewable: boolean;
}

export interface GridAccess {
  /** Mode of every registry field of the entity for the caller. */
  modes: Record<string, FieldMode>;
  /** The company's custom fields of the entity. */
  extras: GridExtraField[];
  /** The company's time zone. */
  timeZone: string;
}

export interface GridResult {
  rows: Record<string, unknown>[];
  total: number;
  aggregates?: Record<string, unknown>;
}

/**
 * What the caller may see of `entity`, resolved under the caller's claims in one round trip per question: the
 * mode of each field (`kernel.field_mode`), the custom fields with `roles_view` against the caller's roles,
 * and the company's time zone.
 */
export async function gridAccess(tx: Tx, entity: EntityDef): Promise<GridAccess> {
  const names = entity.fields.map((f) => f.name);
  const modes = await tx<{ field: string; mode: FieldMode }[]>`
    select f as field, kernel.field_mode(${entity.id}, f) as mode from unnest(${names}::text[]) as f`;
  const extras = await tx<{ key: string; label: string; type: CustomFieldType; options: string[] | null; viewable: boolean }[]>`
    select key, label, type, options, roles_view && kernel.current_role_ids() as viewable
    from kernel.custom_fields
    where entity = ${entity.id} and company_id = kernel.current_company_id()
    order by label, key`;
  const [company] = await tx<{ timezone: string }[]>`select timezone from kernel.companies where id = kernel.current_company_id()`;
  return {
    modes: Object.fromEntries(modes.map((m) => [m.field, m.mode])),
    extras: extras.map((e) => ({ ...e, viewable: e.viewable === true })),
    timeZone: company?.timezone ?? "UTC",
  };
}

/** Whether `field` (a registry field or `extra.<key>`) is shown as it is to the caller. */
export function visibleIn(access: GridAccess): (field: string) => boolean {
  return (field) => {
    if (field.startsWith(EXTRA_PREFIX)) {
      const key = field.slice(EXTRA_PREFIX.length);
      return access.modes.extra === "visible" && access.extras.some((e) => e.key === key && e.viewable);
    }
    return (access.modes[field] ?? "visible") === "visible";
  };
}

/**
 * Runs one grid page for the caller (design §9): resolves what they may see, builds the select over the masked
 * view and reads the rows, the total and the aggregates in one transaction under their claims, so company RLS,
 * the party scope and masking apply. Throws `QueryError` when the state uses a field the caller may not filter
 * or sort by.
 */
export async function runGridQuery(sql: Sql, claims: JwtClaims, entity: EntityDef, state: GridState): Promise<GridResult & { access: GridAccess }> {
  return withClaims(sql, claims, async (tx) => {
    const access = await gridAccess(tx, entity);
    const extras = Object.fromEntries(access.extras.map((e) => [e.key, e.type]));
    const q = buildQuery(entity, state, visibleIn(access), { extras, timeZone: access.timeZone });
    const rows = await tx.unsafe<Record<string, unknown>[]>(q.sql, q.params as never[]);
    const [count] = await tx.unsafe<{ total: number }[]>(q.countSql, q.params as never[]);
    const result: GridResult & { access: GridAccess } = { rows: [...rows], total: count?.total ?? 0, access };
    if (q.aggregateSql) {
      const [aggregates] = await tx.unsafe<Record<string, unknown>[]>(q.aggregateSql, q.params as never[]);
      result.aggregates = { ...aggregates };
    }
    return result;
  });
}

/** A role's party scope (design §5.18): which parties the caller sees (`kernel.party_scope()`). */
export type PartyScope = "ambos" | "clientes" | "proveedores" | "ninguno";

/** What a grid page needs to present the entity to the caller: the field access and the party scope. */
export async function gridPageAccess(sql: Sql, claims: JwtClaims, entity: EntityDef): Promise<GridAccess & { partyScope: PartyScope }> {
  return withClaims(sql, claims, async (tx) => {
    const access = await gridAccess(tx, entity);
    const [row] = await tx<{ scope: PartyScope | null }[]>`select kernel.party_scope() as scope`;
    return { ...access, partyScope: row?.scope ?? "ninguno" };
  });
}
