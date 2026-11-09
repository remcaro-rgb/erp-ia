import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { syncModuleManifest, type Caller } from "@erp/kernel";
import { accounting } from "@erp/module-accounting";
import { postingModeHarness, type Harness } from "../../../../../../packages/modules/accounting/src/__tests__/posting-mode-harness";
import { POSTING_AGE_CHECK, runScheduledChecks, scheduledChecks, type ScheduledChecks } from "../scheduled-checks";

// Plan 2B.2 Task 52.7, final review I-2: the production wiring of the scheduled checks against the real database. `companies()` lists the
// asynchronous companies with accounting enabled plus those with an open posting_age row; `claims()` is the system user with the company's
// system admin role; `due()` is the cheap read; the process runs only for a due company, and one failing company does not stop the others.
// The database is shared with other suites: every assertion looks at this suite's two companies only.

let h: Harness;
let real: ScheduledChecks;
let ours: Set<string>;

beforeAll(async () => {
  h = await postingModeHarness();
  await syncModuleManifest(h.sql, accounting);
  // Company B gets its accounting too (asynchronous, with nothing waiting: the quiet company).
  await h.runStepUp("accounting.chart.seed", {}, h.otherAdmin);
  real = scheduledChecks({ sql: h.sql, registry: h.registry });
  ours = new Set([h.companyId, h.otherCompanyId]);
}, 300_000);

afterAll(async () => {
  if (!h) return;
  await h.sql`delete from kernel.recommendations where company_id = any(${[h.companyId, h.otherCompanyId]}::uuid[])`;
  await h.cleanup();
});

const listed = async () => (await real.companies()).filter((id) => ours.has(id)).sort();
const sorted = (...ids: string[]) => [...ids].sort();
const callerOf = async (companyId: string): Promise<Caller> => ({ claims: await real.claims(companyId), origin: "scheduler" });
const openRows = (companyId: string) => h.sql<{ id: string }[]>`
  select id from kernel.recommendations where company_id = ${companyId} and reason = 'posting_age' and status = 'new'`;
/** The real wiring on this suite's companies, recording which company each process run was for; `failFor` makes that company's run throw. */
function wired(failFor?: string) {
  const runs: string[] = [];
  const checks: ScheduledChecks = {
    ...real,
    companies: async () => (await real.companies()).filter((id) => ours.has(id)),
    run: async (caller, processId, input) => {
      runs.push(caller.claims.active_company_id);
      if (caller.claims.active_company_id === failFor) throw new Error("simulated failure");
      return real.run(caller, processId, input);
    },
  };
  return { checks, runs, options: { lastRun: new Map<string, number>() } };
}
const overdueInvoice = async () => {
  const invoice = await h.issuedInvoice();
  await h.sql`update kernel.outbox set created_at = now() - interval '90 minutes'
    where company_id = ${h.companyId} and event = 'invoicing.invoice.issued' and payload->>'invoiceId' = ${invoice.id}`;
  return invoice;
};

describe("scheduledChecks(deps) against the database", () => {
  it("claims are the system user holding the company's system admin role", async () => {
    const claims = await real.claims(h.companyId);
    expect(claims).toMatchObject({ sub: "00000000-0000-0000-0000-000000000000", active_company_id: h.companyId, company_ids: [h.companyId], role_ids: [h.seed.companies[0]!.adminRoleId] });
  });

  it("an asynchronous company with an overdue posting runs the process; a quiet asynchronous company is listed but runs nothing", async () => {
    await h.setMode("asynchronous");
    await h.setMode("asynchronous", h.otherAdmin);
    expect(await listed()).toEqual(sorted(h.companyId, h.otherCompanyId));
    await overdueInvoice();
    expect(await real.due(await callerOf(h.companyId))).toBe(true);
    expect(await real.due(await callerOf(h.otherCompanyId))).toBe(false);
    const { checks, runs, options } = wired();
    expect(await runScheduledChecks(checks, options)).toEqual({ checked: 1, failed: 0 });
    expect(runs).toEqual([h.companyId]);
    expect(await openRows(h.companyId)).toHaveLength(1);
    const audits = await h.sql`select 1 from kernel.audit_log where company_id = ${h.otherCompanyId} and process_id = ${POSTING_AGE_CHECK}`;
    expect(audits).toHaveLength(0);
  });

  it("an inline company with an open row is listed and the row closes; an inline company with nothing open is not listed", async () => {
    await h.setMode("inline_strict");
    await h.setMode("inline_strict", h.otherAdmin);
    expect(await listed()).toEqual([h.companyId]);
    const { checks, runs, options } = wired();
    expect(await runScheduledChecks(checks, options)).toEqual({ checked: 1, failed: 0 });
    expect(runs).toEqual([h.companyId]);
    expect(await openRows(h.companyId)).toEqual([]);
    expect(await listed()).toEqual([]);
  });

  it("a company with accounting disabled is skipped", async () => {
    await h.setMode("asynchronous");
    await h.setAccounting(false);
    try {
      expect(await listed()).toEqual([]);
    } finally {
      await h.setAccounting(true);
    }
    expect(await listed()).toEqual([h.companyId]);
  });

  it("one failing company does not stop the others", async () => {
    // Both due: A with an overdue posting, B (asynchronous, nothing waiting) with an open row about a record that does not wait, so the
    // plan closes it. The harness sets up no documents in B, so that row is a fixture on B's settings record (a subject the system
    // user reads). A's run is made to throw.
    await h.setMode("asynchronous", h.otherAdmin);
    const [settingsB] = await h.sql<{ id: string }[]>`select id from accounting.settings where company_id = ${h.otherCompanyId}`;
    await h.sql`
      insert into kernel.recommendations (company_id, source, process_id, module, audience_process_id, agent_profile, subject_entity, subject_id,
                                          reason, title_key, body_key, title, body, params, last_raised_at)
      values (${h.otherCompanyId}, 'process', ${POSTING_AGE_CHECK}, 'accounting', 'accounting.posting.retry', 'process', 'accounting.settings',
              ${settingsB!.id}, 'posting_age', 'accounting.recommendations.posting_age.title', 'accounting.recommendations.posting_age.body',
              'accounting.recommendations.posting_age.title', 'accounting.recommendations.posting_age.body', '{}'::jsonb, now())`;
    await overdueInvoice();
    expect(await real.due(await callerOf(h.companyId))).toBe(true);
    expect(await real.due(await callerOf(h.otherCompanyId))).toBe(true);
    const { checks, runs, options } = wired(h.companyId);
    const error = console.error;
    console.error = () => undefined;
    try {
      expect(await runScheduledChecks(checks, options)).toEqual({ checked: 1, failed: 1 });
    } finally {
      console.error = error;
    }
    expect(sorted(...runs)).toEqual(sorted(h.companyId, h.otherCompanyId));
    expect(await openRows(h.otherCompanyId)).toEqual([]);
    expect(await h.drain()).toEqual([]);
  });
});
