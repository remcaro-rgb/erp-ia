import { countryPack, ProcessError, type CountryPack, type ProcessContext } from "@erp/kernel";
import { z } from "zod";
import { id } from "./schemas";

// Helpers every core handler shares: the company's country pack, DIAN status, typed refusals, the
// party scope checks (design §5.18) and row mapping.

export const idInput = z.object({ id });
export const idOutput = z.object({ id: z.string() });

/** The country pack of the caller's active company (`kernel.companies.country_code`). */
export async function companyPack(ctx: ProcessContext): Promise<CountryPack> {
  const [company] = await ctx.tx<{ country_code: string }[]>`select country_code from kernel.companies where id = ${ctx.companyId}`;
  if (!company) throw new ProcessError("not_found", `company ${ctx.companyId} is not visible to the caller`);
  return countryPack(company.country_code);
}

/** `complete`, or `missing: <n>` for n pending DIAN data (design §5.8a). */
export function dianStatus(missing: readonly string[]): string {
  return missing.length === 0 ? "complete" : `missing: ${missing.length}`;
}

/** Refuses the run with `invalid_input` when there is any error; `details` lists them. */
export function rejectErrors(processId: string, errors: readonly string[]): void {
  if (errors.length > 0) throw new ProcessError("invalid_input", `invalid input for ${processId}`, { details: [...errors] });
}

/** SQLSTATE of a unique violation. */
const UNIQUE_VIOLATION = "23505";

/**
 * Runs a write and turns a violation of the unique constraint or index `constraint` into
 * `invalid_input` with `detail`, so a concurrent duplicate is refused like a sequential one.
 */
export async function refuseDuplicate<T>(processId: string, constraint: string, detail: string, write: () => Promise<T>): Promise<T> {
  try {
    return await write();
  } catch (error) {
    const pg = error as { code?: string; constraint_name?: string };
    if (pg.code === UNIQUE_VIOLATION && pg.constraint_name === constraint) {
      throw new ProcessError("invalid_input", `duplicate in ${processId}`, { details: [detail], cause: error });
    }
    throw error;
  }
}

/**
 * The stored kinds of a party the caller may write: it must be visible through `core.v_parties`
 * (`not_found` otherwise) and every non-employee kind must be inside the caller's party scope
 * (`forbidden` otherwise).
 */
export async function writableParty(ctx: ProcessContext, partyId: string): Promise<string[]> {
  const [row] = await ctx.tx<{ kind: string[]; covered: boolean }[]>`
    select p.kind, core.party_scope_covers(kernel.party_scope(), p.kind) as covered
    from core.v_parties v join core.parties p on p.id = v.id
    where v.id = ${partyId}`;
  if (!row) throw new ProcessError("not_found", `party ${partyId} not found`);
  if (!row.covered) throw new ProcessError("forbidden", `the caller's party scope does not cover ${row.kind.join(", ")}`);
  return row.kind;
}

/** Throws `forbidden` when a party with these kinds may not be written under the caller's party scope. */
export async function assertScopeCovers(ctx: ProcessContext, kind: readonly string[]): Promise<void> {
  const [row] = await ctx.tx<{ ok: boolean }[]>`select core.party_scope_covers(kernel.party_scope(), ${kind as string[]}::text[]) as ok`;
  if (!row?.ok) {
    throw new ProcessError("forbidden", `the caller's party scope does not cover ${kind.join(", ")}`, {
      details: [`El alcance de tu rol no cubre terceros de tipo ${kind.map((k) => KIND_NAMES[k] ?? k).join(" y ")}`],
    });
  }
}

/** The party kinds as the user reads them, for refusals. */
const KIND_NAMES: Record<string, string> = { customer: "cliente", supplier: "proveedor", employee: "empleado" };

/**
 * Copies `input` without the keys whose value is undefined: what a partial update actually sets,
 * and an insert row whose unset columns keep their defaults.
 */
export function defined<T extends Record<string, unknown>>(input: T): Partial<T> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)) as Partial<T>;
}

/** Copies `row` with undefined values turned into null, so an update clears what the record no longer has. */
export function undefinedAsNull<T extends Record<string, unknown>>(row: T): Record<string, Exclude<T[keyof T], undefined> | null> {
  return Object.fromEntries(Object.entries(row).map(([k, v]) => [k, v === undefined ? null : v])) as Record<string, Exclude<T[keyof T], undefined> | null>;
}

/** "" (a cleared field) becomes null; other values pass through. */
export const blank = (value: string | undefined): string | null | undefined => (value === "" ? null : value);

/** A jsonb parameter for `extra`, or undefined when not given. */
export const jsonb = (ctx: ProcessContext, value: Record<string, unknown> | undefined) =>
  value === undefined ? undefined : ctx.tx.json(value as Parameters<typeof ctx.tx.json>[0]);

/** A jsonb parameter for `extra_free` (name / value pairs), or undefined when not given. */
export const freeJsonb = (ctx: ProcessContext, value: { name: string; value: string }[] | undefined) =>
  value === undefined ? undefined : ctx.tx.json(value);

/** A numeric column (returned as a string by the driver) as a number, or undefined when null. */
export const num = (value: unknown): number | undefined => (value === null || value === undefined ? undefined : Number(value));
/** A nullable text column as an optional string. */
export const str = (value: unknown): string | undefined => (value === null || value === undefined ? undefined : String(value));
