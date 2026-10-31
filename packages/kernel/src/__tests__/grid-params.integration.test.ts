import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedTenant, testDb, ensureRoleProbe } from "../db/test-db";
import { withClaims } from "../db/client";
import { defineEntity } from "../registry/entities";
import { runGridQuery } from "../query/run";
import { QueryError } from "../query/errors";
import { GridState } from "../query/grid-state";

// Grid parameters (design §9, Task 7 of the gaps plan): an entity declares the parameters its view reads; the grid state carries
// their values and the query sets them as `erp.param.<name>` settings local to the query's transaction.

const PROBE = defineEntity({
  id: "kernel.param_probe",
  module: "kernel",
  schema: "kernel",
  table: "param_probe",
  label: "entity.kernel.param_probe",
  fields: [
    { name: "seen", type: "text", label: "field.kernel.param_probe.seen" },
    { name: "day", type: "text", label: "field.kernel.param_probe.day" },
  ],
  displayField: "seen",
  defaultSort: { field: "seen", dir: "asc" },
  gridParams: [{ name: "period_id", type: "uuid" }, { name: "on", type: "date" }],
});
const PLAIN = defineEntity({ ...PROBE, id: "kernel.param_plain", gridParams: undefined });

const state = (params?: Record<string, string>) => GridState.parse({ filters: [], sort: [], page: 1, pageSize: 10, ...(params ? { params } : {}) });

describe("grid params", () => {
  let sql: ReturnType<typeof testDb>;
  let seed: Awaited<ReturnType<typeof seedTenant>>;
  const claims = () => seed.claimsFor(seed.users.both, seed.companies[0]!.id);
  const PERIOD = "0198a000-0000-7000-8000-000000000001";

  beforeAll(async () => {
    sql = testDb();
    await ensureRoleProbe(sql);
    seed = await seedTenant(sql, { companies: 1 });
    await sql`insert into kernel.role_probe(company_id, secret) values (${seed.companies[0]!.id}, 'x')`;
    await sql`create or replace view kernel.v_param_probe with (security_invoker = true) as
      select id, company_id, nullif(current_setting('erp.param.period_id', true), '') as seen, nullif(current_setting('erp.param.on', true), '') as day from kernel.role_probe`;
    await sql`grant select on kernel.v_param_probe to authenticated`;
  });
  afterAll(async () => {
    await sql`drop view if exists kernel.v_param_probe`;
    await sql`delete from kernel.role_probe where company_id = ${seed.companies[0]!.id}`;
    await seed.cleanup();
    await sql.end();
  });

  it("grid params: declared params reach the view through erp.param.*, undeclared ones are refused, and the setting does not outlive the transaction", async () => {
    const seen = await runGridQuery(sql, claims(), PROBE, state({ period_id: PERIOD, on: "2026-10-01" }));
    expect(seen.rows[0]).toMatchObject({ seen: PERIOD, day: "2026-10-01" });
    // Without params the view reads an empty setting.
    expect((await runGridQuery(sql, claims(), PROBE, state())).rows[0]).toMatchObject({ seen: null });

    const refused = async (e: typeof PROBE, params: Record<string, string>) => runGridQuery(sql, claims(), e, state(params)).then(() => null, (error: unknown) => error);
    expect(await refused(PROBE, { other: "1" })).toMatchObject({ code: "unknown_param", field: "other" });
    expect(await refused(PLAIN, { period_id: PERIOD })).toBeInstanceOf(QueryError);
    expect(await refused(PROBE, { period_id: "not-a-uuid" })).toMatchObject({ code: "bad_value", field: "period_id" });
    expect(await refused(PROBE, { on: "2026-13-45" })).toMatchObject({ code: "bad_value", field: "on" });

    // The setting is local to the query's transaction: a later transaction of the same connection reads none.
    const [after] = await withClaims(sql, claims(), (tx) => tx<{ v: string | null }[]>`select nullif(current_setting('erp.param.period_id', true), '') as v`);
    expect(after!.v).toBeNull();
  });

  it("a grid state carries at most five params", () => {
    expect(GridState.safeParse({ filters: [], sort: [], page: 1, pageSize: 10, params: Object.fromEntries(["a", "b", "c", "d", "e", "f"].map((k) => [k, "1"])) }).success).toBe(false);
  });
});
