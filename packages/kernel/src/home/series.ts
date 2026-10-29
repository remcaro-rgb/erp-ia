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
export async function dailySeries(tx: Tx, companyId: string, source: string, measure: "count" | "tokens" = "count"): Promise<number[]> {
  const value = measure === "tokens" ? tx`coalesce(sum(s.input_tokens + s.output_tokens), 0)::float8` : tx`count(s.id)::float8`;
  const rows = await tx<{ value: number }[]>`
    with tz as (select timezone as name from kernel.v_companies where id = ${companyId}),
    days as (select (now() at time zone tz.name)::date - n as day from tz, generate_series(0, ${SERIES_DAYS - 1}::int) as n)
    select ${value} as value
    from days
    cross join tz
    -- The lower bound lets the index on created_at cut the scan to the window; the join then buckets by the company's day.
    left join ${tx(source)} s on s.company_id = ${companyId}
      and s.created_at >= (((now() at time zone tz.name)::date - ${SERIES_DAYS - 1}::int)::timestamp at time zone tz.name)
      and (s.created_at at time zone tz.name)::date = days.day
    group by days.day
    order by days.day`;
  return rows.map((row) => Number(row.value));
}
