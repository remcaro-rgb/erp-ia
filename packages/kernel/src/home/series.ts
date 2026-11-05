import type { Tx } from "../db/client";

// The trend line of a home KPI (design §19a, OD-9, rule 29): one SQL statement over the last 14 days of the company's
// own calendar, run in the provider's transaction, so row security, the party scope and the field masks that decide the
// card's number decide the trend too.

/** The days a KPI trend covers, today included. */
export const SERIES_DAYS = 14;

/**
 * The trend of `source` (a published read view, `core.v_parties`): `SERIES_DAYS` daily values, oldest first and today last,
 * counting each row by the day of its `created_at` in the company's time zone. `count` is the rows created that day;
 * `tokens` the model tokens (input plus output) of the usage rows of that day. A day without rows is 0. Days are the
 * company's (`kernel.companies.timezone`): a row made at 23:30 in Bogotá belongs to that day, not to the next one in UTC.
 */
export async function dailySeries(tx: Tx, companyId: string, source: string, measure: "count" | "tokens" = "count", column = "created_at"): Promise<number[]> {
  return (await dailyPoints(tx, companyId, source, measure, column)).map((point) => point.value);
}

/** The same 14 days as `dailySeries`, each with its date (`2026-11-04`, the company's calendar): what a chart's axis shows. `column` is the timestamp the rows are dated by. */
export async function dailyPoints(tx: Tx, companyId: string, source: string, measure: "count" | "tokens" = "count", column = "created_at"): Promise<{ day: string; value: number }[]> {
  const value = measure === "tokens" ? tx`coalesce(sum(s.input_tokens + s.output_tokens), 0)` : tx`count(*)`;
  // The window's rows are read once and bucketed by the company's day, then laid on the 14 days (a day without rows is
  // 0). The lower bound keeps the read to the window: of the sources, only kernel.llm_usage (behind kernel.v_llm_usage)
  // has an index on (company_id, created_at) that turns it into a range scan; the others filter the company's rows.
  const stamp = tx`s.${tx(column)}`;
  const rows = await tx<{ day: string; value: number }[]>`
    with tz as (select timezone as name, (now() at time zone timezone)::date as today from kernel.v_companies where id = ${companyId}),
    per_day as (
      select (${stamp} at time zone tz.name)::date as day, ${value}::float8 as value
      from tz
      join ${tx(source)} s on s.company_id = ${companyId}
        and ${stamp} >= ((tz.today - ${SERIES_DAYS - 1}::int)::timestamp at time zone tz.name)
      group by 1
    ),
    days as (select tz.today - n as day from tz, generate_series(0, ${SERIES_DAYS - 1}::int) as n)
    select days.day::text as day, coalesce(per_day.value, 0)::float8 as value
    from days
    left join per_day on per_day.day = days.day
    order by days.day`;
  return rows.map((row) => ({ day: row.day, value: Number(row.value) }));
}
