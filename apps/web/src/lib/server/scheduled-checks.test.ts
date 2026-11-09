import { describe, expect, it, vi } from "vitest";
import type { Caller } from "@erp/kernel";
import { POSTING_AGE_CHECK, runScheduledChecks, tickWithChecks, type ScheduledChecks } from "./scheduled-checks";

// Plan 2B.2 Task 52.7 (ruling R52-6): after the outbox drain, the tick runs the scheduled checks, each in its own try/catch: once per
// company with origin `scheduler` and the system user's claims; one failing company stops neither the others nor the drain's answer.

const claimsOf = (companyId: string) => ({ sub: "00000000-0000-0000-0000-000000000000", tenant_id: "t", company_ids: [companyId], active_company_id: companyId, role_ids: ["r"], locale: "es-419" });

function fake(companies: string[], failing: Set<string>, idle: Set<string> = new Set()) {
  const runs: { caller: Caller; processId: string; input: unknown }[] = [];
  const asked: string[] = [];
  const checks: ScheduledChecks = {
    companies: async () => companies,
    due: async (caller) => {
      asked.push(caller.claims.active_company_id);
      return !idle.has(caller.claims.active_company_id);
    },
    claims: async (companyId) => {
      if (failing.has(`claims:${companyId}`)) throw new Error(`no admin role in ${companyId}`);
      return claimsOf(companyId);
    },
    run: async (caller, processId, input) => {
      runs.push({ caller, processId, input });
      if (failing.has(caller.claims.active_company_id)) throw new Error(`check failed in ${caller.claims.active_company_id}`);
      return { raised: 0, closed: 0 };
    },
  };
  return { checks, runs, asked };
}

/** A fresh throttle per test, on a clock the test moves. */
function clock(start = 1_000_000) {
  const state = { now: start };
  return { state, options: { now: () => state.now, lastRun: new Map<string, number>() } };
}

describe("runScheduledChecks", () => {
  it("runs the posting age check once per company, as the system user with origin scheduler", async () => {
    const { checks, runs } = fake(["c1", "c2"], new Set());
    expect(await runScheduledChecks(checks, clock().options)).toEqual({ checked: 2, failed: 0 });
    expect(runs.map((r) => [r.caller.claims.active_company_id, r.caller.origin, r.processId, r.input])).toEqual([
      ["c1", "scheduler", POSTING_AGE_CHECK, {}],
      ["c2", "scheduler", POSTING_AGE_CHECK, {}],
    ]);
    expect(runs[0]!.caller.claims.sub).toBe("00000000-0000-0000-0000-000000000000");
  });

  it("a company that fails (its run or its claims) does not stop the others", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { checks, runs } = fake(["c1", "c2", "c3", "c4"], new Set(["c2", "claims:c3"]));
    expect(await runScheduledChecks(checks, clock().options)).toEqual({ checked: 2, failed: 2 });
    expect(runs.map((r) => r.caller.claims.active_company_id)).toEqual(["c1", "c2", "c4"]);
    expect(error).toHaveBeenCalledTimes(2);
    error.mockRestore();
  });

  it("a failing company list is logged and checks nothing", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { checks, runs } = fake([], new Set());
    checks.companies = async () => {
      throw new Error("database down");
    };
    expect(await runScheduledChecks(checks, clock().options)).toEqual({ checked: 0, failed: 0 });
    expect(runs).toEqual([]);
    expect(error).toHaveBeenCalledOnce();
    error.mockRestore();
  });
});

describe("runScheduledChecks: only when there is something to do, at most once a minute (fix round 1, item 107)", () => {
  it("a company with nothing overdue and nothing open is asked but its process is not run (no audit row)", async () => {
    const { checks, runs, asked } = fake(["c1", "c2"], new Set(), new Set(["c1"]));
    expect(await runScheduledChecks(checks, clock().options)).toEqual({ checked: 1, failed: 0 });
    expect(asked).toEqual(["c1", "c2"]);
    expect(runs.map((r) => r.caller.claims.active_company_id)).toEqual(["c2"]);
  });

  it("a second tick within 60 s neither asks nor runs; after 60 s it does again", async () => {
    const { checks, runs, asked } = fake(["c1"], new Set());
    const { state, options } = clock();
    await runScheduledChecks(checks, options);
    state.now += 30_000;
    expect(await runScheduledChecks(checks, options)).toEqual({ checked: 0, failed: 0 });
    expect(asked).toHaveLength(1);
    state.now += 30_000;
    await runScheduledChecks(checks, options);
    expect(asked).toHaveLength(2);
    expect(runs).toHaveLength(2);
  });

  it("a company whose cheap read throws is counted failed and the next one still runs", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { checks, runs } = fake(["c1", "c2"], new Set());
    checks.due = async (caller) => {
      if (caller.claims.active_company_id === "c1") throw new Error("read failed");
      return true;
    };
    expect(await runScheduledChecks(checks, clock().options)).toEqual({ checked: 1, failed: 1 });
    expect(runs.map((r) => r.caller.claims.active_company_id)).toEqual(["c2"]);
    error.mockRestore();
  });

  it("the minute is per company: a new company is not held back by another's last run", async () => {
    const { checks, asked } = fake(["c1"], new Set());
    const { state, options } = clock();
    await runScheduledChecks(checks, options);
    state.now += 10_000;
    checks.companies = async () => ["c1", "c2"];
    await runScheduledChecks(checks, options);
    expect(asked).toEqual(["c1", "c2"]);
  });
});

describe("tickWithChecks", () => {
  it("answers the drain's result whatever the checks do", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const checks = vi.fn(async () => {
      throw new Error("checks failed");
    });
    expect(await tickWithChecks(async () => ({ dispatched: 3 }), checks)).toEqual({ ok: true, result: { dispatched: 3 } });
    expect(checks).toHaveBeenCalledOnce();
    error.mockRestore();
  });

  it("runs the checks after the drain, and also when the drain failed", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const order: string[] = [];
    const checks = async () => {
      order.push("checks");
    };
    await tickWithChecks(async () => {
      order.push("drain");
      return { dispatched: 0 };
    }, checks);
    const failed = await tickWithChecks(async () => {
      order.push("drain");
      throw new Error("drain failed");
    }, checks);
    expect(failed).toEqual({ ok: false });
    expect(order).toEqual(["drain", "checks", "drain", "checks"]);
    error.mockRestore();
  });
});
