import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { fixtureRateFeed, type RateFeed } from "@erp/infra";
import { runProcess, setRateFeed, syncModuleManifest, SYSTEM_USER_ID, type Caller } from "@erp/kernel";
import { core } from "../index";
import { withClaims } from "@erp/kernel/testing";
import { coreHarness, type CoreHarness } from "./helpers";

// Rates and the TRM feed (plan 2B.2 Task 34.1; FX §2, §11 0147, §12; owner items 121, 122, 123; R34-2, R34-3). Migration 0147 creates
// core.exchange_rates (one row per company, currency and day; source trm | manual) with RLS, row audit and seq, the published view
// core.v_exchange_rates, the import log core.exchange_rate_imports (the subject of the feed-failure recommendation, one per company and
// date) and seeds EUR. The TRM comes from the country pack through the RateFeed port; here always the fixture (RATE_FEED=fixture).

const FIXTURES = fileURLToPath(new URL("../../../../localization/co/src/__fixtures__/trm/", import.meta.url));

describe("core exchange rates (0147)", () => {
  let h: CoreHarness;
  let sql: CoreHarness["sql"];
  let deps: CoreHarness["deps"];
  let admin: Caller;
  let other: Caller;

  beforeAll(async () => {
    h = await coreHarness({ companies: 2 });
    ({ sql, deps, admin } = h);
    other = { claims: h.seed.claimsFor(h.seed.users.both, h.seed.companies[1]!.id), origin: "ui" };
    setRateFeed(fixtureRateFeed(FIXTURES));
    // The recommendation API checks the raising process is registered (kernel.registered_processes).
    await syncModuleManifest(sql, core);
  });
  afterEach(async () => {
    setRateFeed(fixtureRateFeed(FIXTURES));
    await sql`delete from kernel.recommendations where company_id = any(${h.seed.companies.map((c) => c.id)}::uuid[]) and module = 'core'`;
    await sql`delete from core.exchange_rate_imports where company_id = any(${h.seed.companies.map((c) => c.id)}::uuid[])`;
    await sql`delete from core.exchange_rates where company_id = any(${h.seed.companies.map((c) => c.id)}::uuid[])`;
  });
  afterAll(async () => {
    setRateFeed(undefined);
    await h.cleanup();
  });

  const run = <T = Record<string, unknown>>(caller: Caller, processId: string, input: unknown) => runProcess(deps, caller, processId, input) as Promise<T>;
  const withStepUp = async <T = Record<string, unknown>>(caller: Caller, processId: string, input: unknown) => {
    const stepUpToken = randomUUID();
    await sql`insert into kernel.step_up_verifications(user_id, company_id, token) values (${caller.claims.sub}, ${caller.claims.active_company_id}, ${stepUpToken})`;
    return runProcess(deps, { ...caller, stepUpToken }, processId, input) as Promise<T>;
  };
  const rows = (companyId = h.companyId) =>
    sql<{ rate_date: string; rate: string; source: string; official_rate: string | null }[]>`
      select rate_date::text, rate::text, source, official_rate::text from core.exchange_rates where company_id = ${companyId} and currency = 'USD' order by rate_date`;
  const openFailures = () =>
    sql<{ subject_id: string; occurrences: number; params: Record<string, { value: unknown }> }[]>`
      select subject_id, occurrences, params from kernel.recommendations
      where company_id = ${h.companyId} and module = 'core' and reason = 'trm_import_failed' and status = 'new'`;

  it("(1) the table is company-bound (RLS), audited, numbered, and holds one rate per currency and day", async () => {
    const out = await run<{ id: string }>(admin, "core.exchange_rate.set", { currency: "USD", rateDate: "2026-11-02", rate: 4100.5, note: "Banco" });
    const [row] = await sql`select seq, source, rate::text, note, created_by from core.exchange_rates where id = ${out.id}`;
    expect(row).toMatchObject({ source: "manual", rate: "4100.500000", note: "Banco" });
    expect(Number(row!.seq)).toBeGreaterThan(0);
    const audit = await sql`select action, origin from kernel.audit_log where row_id = ${out.id} and process_id = 'core.exchange_rate.set'`;
    expect(audit.length).toBeGreaterThan(0);
    // Another company reads nothing, through the table or the published view.
    const seen = await withClaims(sql, other.claims, (tx) => tx`select id from core.exchange_rates union all select company_id from core.v_exchange_rates`);
    expect(seen).toEqual([]);
    const published = await withClaims(sql, admin.claims, (tx) => tx`select company_id, currency, rate_date::text, rate::text, source from core.v_exchange_rates`);
    expect(published).toEqual([{ company_id: h.companyId, currency: "USD", rate_date: "2026-11-02", rate: "4100.500000", source: "manual" }]);
    // The unique key, the source and the rate checks hold whoever writes.
    await expect(sql`insert into core.exchange_rates (company_id, currency, rate_date, rate, source) values (${h.companyId}, 'USD', '2026-11-02', 4000, 'trm')`).rejects.toThrow(/unique|duplicate/i);
    await expect(sql`insert into core.exchange_rates (company_id, currency, rate_date, rate, source) values (${h.companyId}, 'USD', '2026-11-03', 0, 'manual')`).rejects.toThrow();
    await expect(sql`insert into core.exchange_rates (company_id, currency, rate_date, rate, source) values (${h.companyId}, 'USD', '2026-11-03', 1, 'banco')`).rejects.toThrow();
    // A user session writes it only through the core.exchange_rate processes.
    await expect(withClaims(sql, admin.claims, (tx) => tx`insert into core.exchange_rates (company_id, currency, rate_date, rate, source) values (${h.companyId}, 'USD', '2026-11-04', 1, 'manual')`)).rejects.toThrow();
  });

  it("(2) set writes a manual rate (a second set on the same day replaces it); on a TRM day it refuses official_rate_exists", async () => {
    await run(admin, "core.exchange_rate.set", { currency: "USD", rateDate: "2026-11-03", rate: 4000 });
    await run(admin, "core.exchange_rate.set", { currency: "USD", rateDate: "2026-11-03", rate: 4010.25 });
    expect(await rows()).toEqual([{ rate_date: "2026-11-03", rate: "4010.250000", source: "manual", official_rate: null }]);
    await run(admin, "core.exchange_rate.import_official", { date: "2026-11-07" });
    const refused = await run(admin, "core.exchange_rate.set", { currency: "USD", rateDate: "2026-11-08", rate: 4200 }).catch((e: unknown) => e);
    expect(refused).toMatchObject({ code: "invalid_input" });
    expect((refused as Error).message).toMatch(/^official_rate_exists/);
    await expect(run(admin, "core.exchange_rate.set", { currency: "ZZZ", rateDate: "2026-11-03", rate: 1 })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(run(admin, "core.exchange_rate.set", { currency: "COP", rateDate: "2026-11-03", rate: 1 })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(run(admin, "core.exchange_rate.set", { currency: "USD", rateDate: "2026-11-03", rate: -1 })).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("(3) override_official needs the second factor; with it the TRM is replaced, source manual, and the audit holds old and new", async () => {
    await run(admin, "core.exchange_rate.import_official", { date: "2026-11-07" });
    const input = { currency: "USD", rateDate: "2026-11-08", rate: 4150, note: "Tasa del banco para el reintegro" };
    await expect(run(admin, "core.exchange_rate.override_official", input)).rejects.toMatchObject({ code: "step_up_required" });
    await expect(withStepUp(admin, "core.exchange_rate.override_official", { ...input, note: undefined })).rejects.toMatchObject({ code: "invalid_input" });
    const out = await withStepUp<{ id: string }>(admin, "core.exchange_rate.override_official", input);
    expect((await rows()).find((r) => r.rate_date === "2026-11-08")).toEqual({ rate_date: "2026-11-08", rate: "4150.000000", source: "manual", official_rate: "4123.450000" });
    const [audit] = await sql<{ diff: Record<string, { old: unknown; new: unknown }> }[]>`
      select diff from kernel.audit_log where row_id = ${out.id} and action = 'update' and diff is not null and process_id = 'core.exchange_rate.override_official'`;
    expect(audit!.diff.rate).toEqual({ old: 4123.45, new: 4150 });
    expect(audit!.diff.source).toEqual({ old: "trm", new: "manual" });
    // Only a TRM row is overridden: a manual day is refused (set changes it).
    await expect(withStepUp(admin, "core.exchange_rate.override_official", input)).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("(4) import_official writes one TRM row per day of the validity range; a rerun writes none; a manual day is skipped and listed", async () => {
    await run(admin, "core.exchange_rate.set", { currency: "USD", rateDate: "2026-11-07", rate: 4000 });
    const first = await run<{ written: number; skipped: unknown[] }>(admin, "core.exchange_rate.import_official", { date: "2026-11-07" });
    expect(first.written).toBe(2);
    expect(first.skipped).toEqual([{ rateDate: "2026-11-07", manualRate: 4000, officialRate: 4123.45 }]);
    expect(await rows()).toEqual([
      { rate_date: "2026-11-07", rate: "4000.000000", source: "manual", official_rate: "4123.450000" },
      { rate_date: "2026-11-08", rate: "4123.450000", source: "trm", official_rate: null },
      { rate_date: "2026-11-09", rate: "4123.450000", source: "trm", official_rate: null },
    ]);
    const again = await run<{ written: number }>(admin, "core.exchange_rate.import_official", { date: "2026-11-07" });
    expect(again.written).toBe(0);
    expect(await rows()).toHaveLength(3);
  });

  it("(4b) without the manual row the Saturday-to-Monday TRM writes three rows; the scheduler runs it as the system user", async () => {
    const [role] = await sql<{ id: string }[]>`select id from kernel.roles where company_id = ${h.companyId} and is_system and name = 'admin'`;
    const system: Caller = {
      claims: { sub: SYSTEM_USER_ID, tenant_id: h.seed.tenantId, company_ids: [h.companyId], active_company_id: h.companyId, role_ids: [role!.id], locale: "es-419" },
      origin: "scheduler",
    };
    const out = await run<{ written: number }>(system, "core.exchange_rate.import_official", { date: "2026-11-07" });
    expect(out.written).toBe(3);
    expect((await rows()).map((r) => [r.rate_date, r.source])).toEqual([["2026-11-07", "trm"], ["2026-11-08", "trm"], ["2026-11-09", "trm"]]);
  });

  it("(5) a missing fixture writes nothing and opens one recommendation for the date; a second run does not open another; a success closes it", async () => {
    const out = await run<{ written: number; failed: string[] }>(admin, "core.exchange_rate.import_official", { date: "2026-11-12" });
    expect(out).toMatchObject({ written: 0, failed: ["USD"] });
    expect(await rows()).toEqual([]);
    let open = await openFailures();
    expect(open).toHaveLength(1);
    expect(open[0]!.params.date!.value).toBe("2026-11-12");
    await run(admin, "core.exchange_rate.import_official", { date: "2026-11-12" });
    open = await openFailures();
    expect(open).toHaveLength(1);
    expect(open[0]!.occurrences).toBe(2);
    // Another date's failure is its own recommendation.
    await run(admin, "core.exchange_rate.import_official", { date: "2026-11-13" });
    expect(await openFailures()).toHaveLength(2);
    // The feed answers again: the date's recommendation closes.
    const feed: RateFeed = { getJson: async () => [{ valor: "4099.10", unidad: "COP", vigenciadesde: "2026-11-12T00:00:00.000", vigenciahasta: "2026-11-12T00:00:00.000" }] };
    setRateFeed(feed);
    expect((await run<{ written: number }>(admin, "core.exchange_rate.import_official", { date: "2026-11-12" })).written).toBe(1);
    open = await openFailures();
    expect(open).toHaveLength(1);
    expect(open[0]!.params.date!.value).toBe("2026-11-13");
  });

  it("(6) for_date answers the day's row, else the latest within 3 days before, else null", async () => {
    await run(admin, "core.exchange_rate.set", { currency: "USD", rateDate: "2026-11-06", rate: 4111 });
    const at = (date: string) => run(admin, "core.exchange_rate.for_date", { currency: "USD", date });
    expect(await at("2026-11-08")).toEqual({ rate: 4111, source: "manual", rateDate: "2026-11-06" });
    expect(await at("2026-11-09")).toEqual({ rate: 4111, source: "manual", rateDate: "2026-11-06" });
    expect(await at("2026-11-10")).toBeNull();
    expect(await at("2026-11-05")).toBeNull();
    await run(admin, "core.exchange_rate.import_official", { date: "2026-11-07" });
    expect(await at("2026-11-09")).toEqual({ rate: 4123.45, source: "trm", rateDate: "2026-11-09" });
    // The other company sees none of it.
    expect(await run(other, "core.exchange_rate.for_date", { currency: "USD", date: "2026-11-09" })).toBeNull();
  });

  it("(7) EUR is a currency, has no official rate, and takes manual rates", async () => {
    expect((await sql`select code from core.currencies where code = 'EUR'`).length).toBe(1);
    const out = await run<{ written: number; failed: string[] }>(admin, "core.exchange_rate.import_official", { date: "2026-11-07" });
    expect(out.failed).toEqual([]);
    expect((await sql`select 1 from core.exchange_rates where company_id = ${h.companyId} and currency = 'EUR'`).length).toBe(0);
    await run(admin, "core.exchange_rate.set", { currency: "EUR", rateDate: "2026-11-07", rate: 4480.75 });
    expect(await run(admin, "core.exchange_rate.for_date", { currency: "EUR", date: "2026-11-07" })).toEqual({ rate: 4480.75, source: "manual", rateDate: "2026-11-07" });
  });
});
