import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { syncModuleManifest, SYSTEM_USER_ID, withClaims, type Caller, type JwtClaims } from "@erp/kernel";
import { accounting } from "../index";
import { postingAgePlan } from "../processes/posting-age";
import { postingModeHarness, type Harness } from "./posting-mode-harness";

// Plan 2B.2 Task 52.7 (owner item 74, rulings R52-5, R52-6): in the asynchronous posting mode a document may wait for its entry. The
// scheduled check `accounting.posting.age_check` (origin scheduler, the kernel's system user) raises the kernel recommendation `posting_age`
// about each document that waited longer than `accounting.settings.posting_alert_minutes` (default 60, 5–10080) to whoever may retry postings,
// merges on the next runs and closes it once the document has its entry; in inline strict mode it raises nothing and closes what is open.

let h: Harness;
let system: Caller;
let contador: Caller;
let ventas: Caller;

const CHECK = "accounting.posting.age_check";

beforeAll(async () => {
  h = await postingModeHarness();
  await syncModuleManifest(h.sql, accounting);
  const company = h.seed.companies[0]!;
  const claims: JwtClaims = { sub: SYSTEM_USER_ID, tenant_id: h.seed.tenantId, company_ids: [h.companyId], active_company_id: h.companyId, role_ids: [company.adminRoleId], locale: "es-419" };
  system = { claims, origin: "scheduler" };
  // The accounting role holds the retry (the audience, R52-5) and reads the invoices; the sales role reads the invoices only.
  const role = async (name: string, processes: string[]) => {
    const [row] = await h.sql<{ id: string }[]>`insert into kernel.roles(company_id, name, is_system) values (${h.companyId}, ${name}, false) returning id`;
    for (const id of processes) await h.sql`insert into kernel.process_permissions(company_id, role_id, process_id) values (${h.companyId}, ${row!.id}, ${id}) on conflict do nothing`;
    return row!.id;
  };
  const accountingRole = await role("Contabilidad", ["accounting.posting.retry", "invoicing.invoice.consult", "kernel.recommendation.list", "kernel.recommendation.decide"]);
  const salesRole = await role("Ventas", ["invoicing.invoice.consult", "kernel.recommendation.list"]);
  const clerk = h.seed.users.clerk!;
  await h.seed.holdRoles(clerk, h.companyId, [accountingRole, salesRole]);
  const base = h.seed.claimsFor(clerk, h.companyId) as JwtClaims;
  contador = { claims: { ...base, role_ids: [accountingRole] }, origin: "ui" };
  ventas = { claims: { ...base, role_ids: [salesRole] }, origin: "ui" };
  await h.setMode("asynchronous");
}, 300_000);

afterAll(async () => {
  if (!h) return;
  await h.sql`delete from kernel.recommendations where company_id = any(${[h.companyId, h.otherCompanyId]}::uuid[])`;
  await h.sql`delete from kernel.membership_roles where role_id in (select id from kernel.roles where company_id = ${h.companyId} and not is_system)`;
  await h.cleanup();
});

const check = () => h.run<{ raised: number; closed: number }>(system, CHECK, {});

interface RecRow { id: string; status: string; occurrences: number; subject_entity: string; subject_id: string; audience_process_id: string | null; module: string; title_key: string; body_key: string; params: Record<string, { value: unknown }> }
/** The posting_age rows of a document (service connection: every status). */
const rows = (sourceId: string) => h.sql<RecRow[]>`
  select id, status, occurrences, subject_entity, subject_id, audience_process_id, module, title_key, body_key, params from kernel.recommendations
  where company_id = ${h.companyId} and reason = 'posting_age' and subject_id = ${sourceId} order by created_at`;
const open = async (sourceId: string) => (await rows(sourceId)).filter((r) => r.status === "new");

/** What `caller` reads in kernel.v_recommendations about the document (authenticated, its claims). */
const visible = async (caller: Caller, sourceId: string) => {
  let out: { id: string; subject_id: string | null }[] = [];
  await h.sql.begin(async (tx) => {
    await tx`select set_config('request.jwt.claims', ${JSON.stringify({ role: "authenticated", ...caller.claims })}, true), set_config('role', 'authenticated', true)`;
    out = await tx<{ id: string; subject_id: string | null }[]>`
      select id, subject_id from kernel.v_recommendations where status = 'new' and reason = 'posting_age' and subject_id = ${sourceId}`;
  });
  return out;
};

/** The row-audit actions of one recommendation. */
const rowAudits = async (id: string) =>
  (await h.sql<{ action: string }[]>`select action from kernel.audit_log where entity = 'kernel.recommendations' and row_id = ${id} order by occurred_at`).map((r) => r.action);

/** The scheduler's cheap read (what the check would do), as the system user. */
const plan = () => withClaims(h.sql, system.claims, (tx) => postingAgePlan(tx, h.companyId), { allowSystem: true });

/** Ages a pending failure (its touch trigger keeps created_at: the triggers are off for this transaction only). */
const ageFailure = (failureId: string) => h.sql.begin(async (tx) => {
  await tx`set local session_replication_role = replica`;
  await tx`update accounting.posting_failures set created_at = now() - interval '2 hours' where id = ${failureId}`;
});

const ageEvent = (invoiceId: string, minutes: number) => h.sql`
  update kernel.outbox set created_at = now() - make_interval(mins => ${minutes})
  where company_id = ${h.companyId} and event = 'invoicing.invoice.issued' and payload->>'invoiceId' = ${invoiceId}`;

describe("(1) asynchronous: a queued posting older than N minutes", () => {
  it("raises one recommendation to the holders of accounting.posting.retry about the invoice; an unchanged second run writes nothing", async () => {
    const invoice = await h.issuedInvoice();
    await ageEvent(invoice.id, 90);
    expect(await h.pending(invoice.id)).toEqual([expect.objectContaining({ state: "queued" })]);
    expect(await check()).toMatchObject({ raised: 1 });
    const [first] = await open(invoice.id);
    expect(first).toMatchObject({
      subject_entity: "invoicing.invoice", subject_id: invoice.id, audience_process_id: "accounting.posting.retry", module: "accounting",
      title_key: "accounting.recommendations.posting_age.title", body_key: "accounting.recommendations.posting_age.body", occurrences: 1,
    });
    expect(first!.params.minutes!.value).toBe(60);
    expect(first!.params.state!.value).toBe("queued");
    // Fix round 1 (item 107): unchanged, the second run does not re-raise: one row, one occurrence, one row-audit entry (its insert).
    expect(await check()).toMatchObject({ raised: 0, closed: 0 });
    const again = await open(invoice.id);
    expect(again).toHaveLength(1);
    expect(again[0]).toMatchObject({ id: first!.id, occurrences: 1 });
    expect(await rowAudits(first!.id)).toEqual(["insert"]);
    // (4) the consumer posts it: the next run closes the recommendation.
    expect(await h.drain()).toEqual([]);
    expect(await h.pending(invoice.id)).toEqual([]);
    expect(await check()).toMatchObject({ closed: 1 });
    expect(await open(invoice.id)).toEqual([]);
    expect((await rows(invoice.id)).map((r) => r.status)).toEqual(["closed"]);
  });
});

describe("(2) younger than N", () => {
  it("raises nothing", async () => {
    const invoice = await h.issuedInvoice();
    await ageEvent(invoice.id, 30);
    await check();
    expect(await rows(invoice.id)).toEqual([]);
    expect(await h.drain()).toEqual([]);
  });
});

describe("(3) a failed posting older than N, and (4) its retry", () => {
  it("raises for the failure; once retried the next run closes it", async () => {
    const saved = await h.sql<{ account_id: string }[]>`
      delete from accounting.account_role_mappings where company_id = ${h.companyId} and role = 'receivable' and dimension is null returning account_id`;
    let failed: Awaited<ReturnType<Harness["pending"]>>[number] | undefined;
    let invoiceId: string;
    try {
      const invoice = await h.issuedInvoice();
      invoiceId = invoice.id;
      expect(await h.drain()).toEqual([]);
      [failed] = await h.pending(invoice.id);
      expect(failed).toMatchObject({ state: "failed" });
      await ageFailure(failed!.failure_id!);
      expect(await check()).toMatchObject({ raised: 1 });
      const [row] = await open(invoice.id);
      expect(row!.params.state!.value).toBe("failed");
    } finally {
      await h.runStepUp("accounting.account_role_mapping.update", { mappings: [{ role: "receivable", accountId: saved[0]!.account_id }] });
    }
    const invoice = { id: invoiceId! };
    expect(await h.run(h.admin, "accounting.posting.retry", { failureId: failed!.failure_id })).toMatchObject({ resolved: true });
    await check();
    expect(await open(invoice.id)).toEqual([]);
  });
});

describe("(8) who sees it", () => {
  it("shows in kernel.v_recommendations for the accounting role and not for a role without the retry", async () => {
    const invoice = await h.issuedInvoice();
    await ageEvent(invoice.id, 90);
    await check();
    const [row] = await open(invoice.id);
    expect(await visible(contador, invoice.id)).toEqual([{ id: row!.id, subject_id: invoice.id }]);
    expect(await visible(ventas, invoice.id)).toEqual([]);
    expect(await h.drain()).toEqual([]);
    await check();
  });
});

describe("(6) the threshold is the company's posting_alert_minutes", () => {
  it("defaults to 60, is updated under step-up, validated 5–10080, and moves the threshold", async () => {
    expect(await h.run(h.admin, "accounting.settings.consult", {})).toMatchObject({ postingAlertMinutes: 60 });
    for (const bad of [4, 10081, 1.5, 0]) {
      await expect(h.runStepUp("accounting.settings.update", { postingAlertMinutes: bad })).rejects.toMatchObject({ code: "invalid_input" });
    }
    await expect(h.sql`update accounting.settings set posting_alert_minutes = 4 where company_id = ${h.companyId}`).rejects.toThrow();
    await h.runStepUp("accounting.settings.update", { postingAlertMinutes: 180 });
    expect(await h.run(h.admin, "accounting.settings.consult", {})).toMatchObject({ postingAlertMinutes: 180 });
    const invoice = await h.issuedInvoice();
    await ageEvent(invoice.id, 120);
    await check();
    expect(await rows(invoice.id)).toEqual([]);
    await h.runStepUp("accounting.settings.update", { postingAlertMinutes: 90 });
    await check();
    const [row] = await open(invoice.id);
    expect(row!.params.minutes!.value).toBe(90);
    await h.runStepUp("accounting.settings.update", { postingAlertMinutes: 60 });
    expect(await h.drain()).toEqual([]);
    await check();
    expect(await open(invoice.id)).toEqual([]);
  });
});

describe("(5) inline strict", () => {
  it("raises nothing and closes what is open", async () => {
    const invoice = await h.issuedInvoice();
    await ageEvent(invoice.id, 90);
    await check();
    expect(await open(invoice.id)).toHaveLength(1);
    await h.setMode("inline_strict");
    try {
      // The event still waits (a queue left from the asynchronous mode), but the inline mode raises nothing and closes the open row.
      expect(await h.pending(invoice.id)).toHaveLength(1);
      expect(await check()).toMatchObject({ raised: 0, closed: 1 });
      expect(await open(invoice.id)).toEqual([]);
      await check();
      expect(await open(invoice.id)).toEqual([]);
    } finally {
      await h.setMode("asynchronous");
      expect(await h.drain()).toEqual([]);
    }
  });
});

describe("(7) origins", () => {
  it("a run from the screen is refused: the check runs only from the scheduler", async () => {
    await expect(h.run(h.admin, CHECK, {})).rejects.toMatchObject({ code: "forbidden" });
    await expect(h.run({ ...system, origin: "ui" }, CHECK, {})).rejects.toMatchObject({ code: "forbidden" });
  });
});

describe("fix round 1 (item 107): the scheduler's cheap read and state changes", () => {
  it("the plan is empty when nothing is overdue and nothing is open; an overdue document makes it non-empty, its raise empties it again", async () => {
    expect(await plan()).toMatchObject({ mode: "asynchronous", minutes: 60, raise: [], close: [] });
    const invoice = await h.issuedInvoice();
    expect((await plan()).raise).toEqual([]);
    await ageEvent(invoice.id, 90);
    expect((await plan()).raise).toEqual([expect.objectContaining({ entity: "invoicing.invoice", id: invoice.id, state: "queued" })]);
    await check();
    expect(await plan()).toMatchObject({ raise: [], close: [] });
    expect(await h.drain()).toEqual([]);
    expect((await plan()).close).toEqual([{ entity: "invoicing.invoice", id: invoice.id }]);
    await check();
    expect(await plan()).toMatchObject({ raise: [], close: [] });
  });

  it("a document that goes from queued to failed is re-raised once with the new state; unchanged again, it is not", async () => {
    const invoice = await h.issuedInvoice();
    await ageEvent(invoice.id, 90);
    await check();
    const [first] = await open(invoice.id);
    expect(first!.params.state!.value).toBe("queued");
    const saved = await h.sql<{ account_id: string }[]>`
      delete from accounting.account_role_mappings where company_id = ${h.companyId} and role = 'receivable' and dimension is null returning account_id`;
    let failureId: string;
    try {
      expect(await h.drain()).toEqual([]);
      const [failed] = await h.pending(invoice.id);
      expect(failed).toMatchObject({ state: "failed" });
      failureId = failed!.failure_id!;
      await ageFailure(failureId);
      expect(await check()).toMatchObject({ raised: 1 });
      const [changed] = await open(invoice.id);
      expect(changed).toMatchObject({ id: first!.id, occurrences: 2 });
      expect(changed!.params.state!.value).toBe("failed");
      expect(await check()).toMatchObject({ raised: 0 });
      expect((await open(invoice.id))[0]).toMatchObject({ occurrences: 2 });
      expect(await rowAudits(first!.id)).toEqual(["insert", "update"]);
    } finally {
      await h.runStepUp("accounting.account_role_mapping.update", { mappings: [{ role: "receivable", accountId: saved[0]!.account_id }] });
    }
    expect(await h.run(h.admin, "accounting.posting.retry", { failureId: failureId! })).toMatchObject({ resolved: true });
    expect(await check()).toMatchObject({ closed: 1 });
    expect(await open(invoice.id)).toEqual([]);
  });
});

describe("final review I-1: Descartar holds while the document waits in the same state", () => {
  it("dismissed, several runs raise nothing and write nothing; a change of state raises a new row", async () => {
    const invoice = await h.issuedInvoice();
    await ageEvent(invoice.id, 90);
    expect(await check()).toMatchObject({ raised: 1 });
    const [first] = await open(invoice.id);
    expect(await h.run(contador, "kernel.recommendation.decide", { id: first!.id, decision: "dismissed" })).toMatchObject({ status: "dismissed" });
    const auditsAfterDismiss = await rowAudits(first!.id);
    for (let i = 0; i < 3; i++) {
      expect((await plan()).raise).toEqual([]);
      expect(await check()).toMatchObject({ raised: 0 });
    }
    expect((await rows(invoice.id)).map((r) => r.status)).toEqual(["dismissed"]);
    expect(await rowAudits(first!.id)).toEqual(auditsAfterDismiss);

    const saved = await h.sql<{ account_id: string }[]>`
      delete from accounting.account_role_mappings where company_id = ${h.companyId} and role = 'receivable' and dimension is null returning account_id`;
    let failureId: string;
    try {
      expect(await h.drain()).toEqual([]);
      const [failed] = await h.pending(invoice.id);
      expect(failed).toMatchObject({ state: "failed" });
      failureId = failed!.failure_id!;
      await ageFailure(failureId);
      expect(await check()).toMatchObject({ raised: 1 });
      const fresh = await open(invoice.id);
      expect(fresh).toHaveLength(1);
      expect(fresh[0]!.id).not.toBe(first!.id);
      expect(fresh[0]!.params.state!.value).toBe("failed");
    } finally {
      await h.runStepUp("accounting.account_role_mapping.update", { mappings: [{ role: "receivable", accountId: saved[0]!.account_id }] });
    }
    expect(await h.run(h.admin, "accounting.posting.retry", { failureId: failureId! })).toMatchObject({ resolved: true });
    await check();
    expect(await open(invoice.id)).toEqual([]);
  });
});
