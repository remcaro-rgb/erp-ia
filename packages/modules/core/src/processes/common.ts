import { countryPack, ProcessError, type CountryPack, type ProcessContext } from "@erp/kernel";

// Helpers every core handler shares: the company's country pack, DIAN status, typed refusals and
// the party scope checks (design §5.18).

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

/** Throws `not_found` unless the party is visible to the caller through `core.v_parties` (company and party scope). */
export async function assertVisibleParty(ctx: ProcessContext, partyId: string): Promise<void> {
  const rows = await ctx.tx`select 1 from core.v_parties where id = ${partyId}`;
  if (rows.length === 0) throw new ProcessError("not_found", `party ${partyId} not found`);
}

/** Throws `forbidden` when a party of these kinds would be outside the caller's party scope. */
export async function assertScopeAllows(ctx: ProcessContext, kind: readonly string[]): Promise<void> {
  const [row] = await ctx.tx<{ ok: boolean }[]>`select core.party_scope_allows(kernel.party_scope(), ${kind as string[]}::text[]) as ok`;
  if (!row?.ok) throw new ProcessError("forbidden", `the caller's party scope does not cover ${kind.join(", ")}`);
}

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

/** A numeric column (returned as a string by the driver) as a number, or undefined when null. */
export const num = (value: unknown): number | undefined => (value === null || value === undefined ? undefined : Number(value));
/** A nullable text column as an optional string. */
export const str = (value: unknown): string | undefined => (value === null || value === undefined ? undefined : String(value));
