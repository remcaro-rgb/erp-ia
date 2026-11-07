import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { enrolTotp, seedAuthUser, totpCode, type AuthFixture } from "../../../../test-support/auth-fixtures";
import { MemoryJar } from "../../../../test-support/memory-jar";

const state = vi.hoisted(() => ({ jar: undefined as unknown }));
vi.mock("next/headers", () => ({ cookies: async () => state.jar, headers: async () => new Headers() }));
vi.mock("next-intl/server", async () => {
  const { messages } = await import("@erp/i18n");
  const catalogue = messages("es-419");
  const lookup = (key: string): unknown => key.split(".").reduce<unknown>((node, part) => (node && typeof node === "object" ? (node as Record<string, unknown>)[part] : undefined), catalogue);
  const t = Object.assign((key: string) => (typeof lookup(key) === "string" ? (lookup(key) as string) : key), { has: (key: string) => typeof lookup(key) === "string" });
  return { getLocale: async () => "es-419", getTranslations: async () => t };
});

import { completeMfa, loginWithPassword } from "@/lib/auth/login";
import { loadNestedRuns } from "@/lib/admin/load";
import { nestedAction } from "../actions";
import { loadNestedFailures } from "../load";

// The nested-run screens' data (plan 2B Task 32, R32-7, R32-12) against the real stack: the settings loader answers only the company admin; the
// queue loader the admin and a role granted `kernel.nested_failure.retry`, through the view without the stored input; anyone else gets null.

let admin: AuthFixture;
let plain: AuthFixture;
let granted: AuthFixture;
let dismisser: AuthFixture;
let adminSecret = "";
const jars = { admin: new MemoryJar(), plain: new MemoryJar(), granted: new MemoryJar(), dismisser: new MemoryJar() };

async function seedFailure(fixture: AuthFixture, over: { status?: string; reason?: string } = {}) {
  const companyId = fixture.companyIds[0]!;
  await fixture.sql`
    insert into kernel.nested_run_failures (company_id, parent_process, nested_process, input, error_code, reason, chain_id, actor_user_id, origin, status)
    values (${companyId}, 'crm.lead.convert', 'core.party.create', ${fixture.sql.json({ secret: "TOP-SECRET-INPUT" })}, 'invalid_input',
            ${over.reason ?? "El documento no es válido"}, gen_random_uuid(), ${fixture.userId}, 'ui', ${over.status ?? "pending"})`;
}

beforeAll(async () => {
  admin = await seedAuthUser({ role: "admin" });
  plain = await seedAuthUser({ role: "member" });
  granted = await seedAuthUser({ role: "member" });
  dismisser = await seedAuthUser({ role: "member" });
  adminSecret = await enrolTotp(admin);
  for (const key of ["module:core", "module:accounting", "module:inventory", "module:costing", "module:sales", "module:crm", "module:invoicing"]) {
    await admin.sql`insert into kernel.tenant_entitlements(tenant_id, key, source) values (${admin.tenantId}, ${key}, 'manual')`;
  }
  const [role] = await granted.sql<{ id: string }[]>`select id from kernel.roles where company_id = ${granted.companyIds[0]!} and name = 'member'`;
  await granted.sql`insert into kernel.process_permissions(company_id, role_id, process_id) values (${granted.companyIds[0]!}, ${role!.id}, 'kernel.nested_failure.retry')`;
  const [dRole] = await dismisser.sql<{ id: string }[]>`select id from kernel.roles where company_id = ${dismisser.companyIds[0]!} and name = 'member'`;
  await dismisser.sql`insert into kernel.process_permissions(company_id, role_id, process_id) values (${dismisser.companyIds[0]!}, ${dRole!.id}, 'kernel.nested_failure.dismiss')`;
  await seedFailure(dismisser);
  await seedFailure(admin);
  await seedFailure(admin, { status: "dismissed", reason: "Otro fallo" });
  await seedFailure(granted);
  expect(await loginWithPassword(jars.admin, { email: admin.email, password: admin.password, remember: false })).toEqual({ ok: true, next: "/mfa/verify" });
  expect(await completeMfa(jars.admin, { code: totpCode(adminSecret) })).toEqual({ ok: true, next: "/" });
  for (const [fixture, jar] of [[plain, jars.plain], [granted, jars.granted], [dismisser, jars.dismisser]] as const) {
    expect(await loginWithPassword(jar, { email: fixture.email, password: fixture.password, remember: false })).toEqual({ ok: true, next: "/" });
  }
});

afterAll(async () => {
  await granted.sql`delete from kernel.process_permissions where company_id = ${granted.companyIds[0]!}`;
  await dismisser.sql`delete from kernel.process_permissions where company_id = ${dismisser.companyIds[0]!}`;
  await admin.sql`delete from kernel.step_up_verifications where company_id = ${admin.companyIds[0]!}`;
  await admin.sql`delete from kernel.tenant_entitlements where tenant_id = ${admin.tenantId}`;
  // The rows' gap-free `seq` keeps a counter per company (core.entity_sequences).
  for (const fixture of [dismisser, granted, plain, admin]) await fixture.sql`delete from core.entity_sequences where company_id = ${fixture.companyIds[0]!}`;
  for (const fixture of [dismisser, granted, plain, admin]) await fixture.cleanup();
});

describe("loadNestedRuns", () => {
  it("answers the company admin with the defaults when nothing is configured", async () => {
    state.jar = jars.admin;
    const data = await loadNestedRuns();
    expect(data).toMatchObject({ maxDepth: 4, defaultDepth: 4, hardMax: 8, pairs: [], pending: 1 });
    // The screens that run the nested runs are not offered as a pair's parent or nested process.
    expect(data!.processes.some((p) => p.id.startsWith("kernel.nested_failure.") || p.id.startsWith("kernel.admin.nested_run."))).toBe(false);
    expect(data!.processes.some((p) => p.id === "kernel.admin.permission.set")).toBe(true);
  });

  it("offers the registry's processes with the derived ledger-or-stock flag, a nestedOnlyFrom process with its parents", async () => {
    state.jar = jars.admin;
    const { processes } = (await loadNestedRuns())!;
    const byId = new Map(processes.map((p) => [p.id, p]));
    expect(byId.get("crm.lead.convert")).toMatchObject({ ledgerOrStock: false, onlyFrom: null });
    expect(byId.get("core.party.create")).toMatchObject({ ledgerOrStock: false, onlyFrom: null });
    expect(byId.get("invoicing.note.issue_annulment")).toMatchObject({ ledgerOrStock: true, onlyFrom: ["invoicing.invoice.void"] });
    expect(byId.get("invoicing.invoice.void")).toMatchObject({ stepUp: true });
  });

  it("answers null to a plain role and to a role that only holds the retry", async () => {
    state.jar = jars.plain;
    expect(await loadNestedRuns()).toBeNull();
    state.jar = jars.granted;
    expect(await loadNestedRuns()).toBeNull();
  });
});

describe("loadNestedFailures", () => {
  it("lists the admin's queue, pending first, with the actor's name and no input", async () => {
    state.jar = jars.admin;
    const data = await loadNestedFailures();
    expect(data).toMatchObject({ truncated: false, canDismiss: true, isAdmin: true });
    expect(data!.rows.map((r) => r.status)).toEqual(["pending", "dismissed"]);
    expect(data!.rows[0]).toMatchObject({ parentProcess: "crm.lead.convert", nestedProcess: "core.party.create", reason: "El documento no es válido", attempts: 0 });
    expect(data!.rows[0]!.actor).toMatch(/^Auth user /);
    expect(JSON.stringify(data)).not.toContain("TOP-SECRET-INPUT");
    expect(Object.keys(data!.rows[0]!)).not.toContain("input");
  });

  it("gives a role granted the retry its company's queue (it cannot dismiss, it is not the admin), another company's none", async () => {
    state.jar = jars.granted;
    const data = await loadNestedFailures();
    expect(data).toMatchObject({ canDismiss: false, isAdmin: false });
    expect(data!.rows).toHaveLength(1);
    expect(JSON.stringify(data)).not.toContain("TOP-SECRET-INPUT");
  });

  it("gives a role granted only the dismissal the queue too, with Reintentar off and Descartar on", async () => {
    state.jar = jars.dismisser;
    const data = await loadNestedFailures();
    expect(data).toMatchObject({ canRetry: false, canDismiss: true, isAdmin: false });
    expect(data!.rows).toHaveLength(1);
    expect(JSON.stringify(data)).not.toContain("TOP-SECRET-INPUT");
    state.jar = jars.granted;
    expect(await loadNestedFailures()).toMatchObject({ canRetry: true, canDismiss: false });
    state.jar = jars.admin;
    expect(await loadNestedFailures()).toMatchObject({ canRetry: true, canDismiss: true });
  });

  it("answers null to a role without the grant", async () => {
    state.jar = jars.plain;
    expect(await loadNestedFailures()).toBeNull();
  });
});

describe("nestedAction", () => {
  it("runs the process of the kind named and asks for the step-up first (pair, depth and retry are sensitive)", async () => {
    state.jar = jars.admin;
    expect(await nestedAction("depth", { maxDepth: 6 })).toMatchObject({ ok: false, code: "step_up_required" });
    expect(await nestedAction("pair", { parent: "crm.lead.convert", nested: "core.party.create", totpCovers: false, onFailure: "rollback" })).toMatchObject({ ok: false, code: "step_up_required" });
  });

  it("refuses a kind that is not one of the four (the client never names a process id)", async () => {
    state.jar = jars.admin;
    expect(await nestedAction("kernel.admin.permission.set" as never, {})).toMatchObject({ ok: false, code: "not_found" });
    expect(await nestedAction("toString" as never, {})).toMatchObject({ ok: false, code: "not_found" });
  });

  it("dismisses a pending row for a role granted the dismissal and answers not_found for one already closed", async () => {
    state.jar = jars.granted;
    const [row] = await granted.sql<{ id: string }[]>`select id from kernel.nested_run_failures where company_id = ${granted.companyIds[0]!}`;
    // The granted role holds only the retry here: dismissal is another process.
    expect(await nestedAction("dismiss", { id: row!.id })).toMatchObject({ ok: false, code: "forbidden" });
    await granted.sql`insert into kernel.process_permissions(company_id, role_id, process_id)
      select company_id, role_id, 'kernel.nested_failure.dismiss' from kernel.process_permissions where company_id = ${granted.companyIds[0]!} limit 1`;
    expect(await nestedAction("dismiss", { id: row!.id })).toMatchObject({ ok: true });
    expect(await nestedAction("dismiss", { id: row!.id })).toMatchObject({ ok: false, code: "not_found" });
    const [after] = await granted.sql<{ status: string }[]>`select status from kernel.nested_run_failures where id = ${row!.id}`;
    expect(after!.status).toBe("dismissed");
  });
});
