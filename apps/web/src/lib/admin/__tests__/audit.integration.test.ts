import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { enrolTotp, seedAuthUser, totpCode, type AuthFixture } from "../../../../test-support/auth-fixtures";
import { MemoryJar } from "../../../../test-support/memory-jar";

const state = vi.hoisted(() => ({ jar: undefined as unknown }));
vi.mock("next/headers", () => ({ cookies: async () => state.jar, headers: async () => new Headers() }));
// The viewer reads the labels of the real Spanish catalogue (what the screen shows).
vi.mock("next-intl/server", async () => {
  const { messages } = await import("@erp/i18n");
  const catalogue = messages("es-419");
  const lookup = (key: string): unknown => key.split(".").reduce<unknown>((node, part) => (node && typeof node === "object" ? (node as Record<string, unknown>)[part] : undefined), catalogue);
  const t = Object.assign((key: string) => (typeof lookup(key) === "string" ? (lookup(key) as string) : key), { has: (key: string) => typeof lookup(key) === "string" });
  return { getLocale: async () => "es-419", getTranslations: async () => t };
});

import { auditEntryDetail, readAuditEntry, recordPageEntities, runProcess, withClaims, type JwtClaims } from "@erp/kernel";
import { completeMfa, loginWithPassword } from "@/lib/auth/login";
import { requireCaller } from "@/lib/auth/claims";
import { processDeps } from "@/lib/server/runtime";
import { loadAudit } from "../load";
import { auditEntryAction, auditTitlesAction } from "../audit-actions";
import { auditLabels } from "../audit-labels";
import { presentAuditDetail } from "../audit-view";

// The audit viewer's detail (design §22.13–14, rule 16) against the real stack, as the company admin signed in with
// their second step: the grid's catalogue names processes, entities and actors; an entry's detail lists each changed
// field of a party as `label · antes → después` with the catalogue's labels, the pack's codes and money formatted; a
// viewer whose role masks a field (not the admin) gets •••••• for it; the titles of the records the grid links to.

let fixture: AuthFixture;
let reader: AuthFixture;
let companyId: string;
let partyId: string;

const juridica = {
  kind: ["customer"],
  personType: "1",
  documentType: "31",
  documentNumber: "900373115",
  legalName: "Café del Norte S.A.S.",
  taxResponsibilities: ["O-13"],
  taxScheme: "01",
  countryCode: "CO",
  departmentCode: "11",
  municipalityCode: "11001",
  addressLine: "Cra 1 # 2-3",
  invoiceEmail: "fe@cafedelnorte.co",
};

const run = async (process: string, input: unknown) => runProcess(processDeps(), await requireCaller(), process, input);
const entryId = async (processId: string, processRow = true) => {
  const [row] = await fixture.sql<{ id: string }[]>`
    select id from kernel.audit_log where company_id = ${companyId} and process_id = ${processId} and row_id = ${partyId} and (diff is null) = ${processRow}
    order by occurred_at desc limit 1`;
  return row!.id;
};

beforeAll(async () => {
  fixture = await seedAuthUser({ role: "admin" });
  reader = await seedAuthUser({ role: "member" });
  companyId = fixture.companyIds[0]!;
  await fixture.sql`insert into kernel.tenant_entitlements(tenant_id, key, source) values (${fixture.tenantId}, 'module:core', 'manual')`;
  const secret = await enrolTotp(fixture);
  const jar = new MemoryJar();
  state.jar = jar;
  expect(await loginWithPassword(jar, { email: fixture.email, password: fixture.password, remember: false })).toEqual({ ok: true, next: "/mfa/verify" });
  expect(await completeMfa(jar, { code: totpCode(secret) })).toEqual({ ok: true, next: "/" });
  ({ id: partyId } = await run("core.party.create", juridica));
  await run("core.party.update", { id: partyId, tradeName: "Bosque QA", creditLimit: 1500000 });
});

afterAll(async () => {
  const { sql } = fixture;
  await sql`delete from core.parties where company_id = ${companyId}`;
  await sql`delete from core.entity_sequences where company_id = ${companyId}`;
  await sql`delete from kernel.outbox where company_id = ${companyId}`;
  await sql`delete from kernel.field_permissions where company_id = ${companyId}`;
  await sql`delete from kernel.membership_roles where membership_id in (select id from kernel.memberships where company_id = ${companyId} and user_id = ${reader.userId})`;
  await sql`delete from kernel.memberships where company_id = ${companyId} and user_id = ${reader.userId}`;
  await sql`delete from kernel.roles where company_id = ${companyId} and name = 'vendedor'`;
  await sql`delete from kernel.tenant_entitlements where tenant_id = ${fixture.tenantId}`;
  await reader.cleanup();
  await fixture.cleanup();
});

describe("audit grid catalogue", () => {
  it("names each process by its description, each entity by its catalogue name whichever way the entry spells it, and each actor", async () => {
    const data = await loadAudit();
    expect(data).not.toBeNull();
    const { catalogue } = data!;
    expect(catalogue.processes["core.party.update"]).toBe("Actualiza los datos de un tercero y recalcula su estado DIAN");
    expect(catalogue.entities["core.party"]).toEqual({ id: "core.party", label: "Tercero", recordPage: true });
    expect(catalogue.entities["core.parties"]).toEqual({ id: "core.party", label: "Tercero", recordPage: true });
    expect(catalogue.entities["core.category"]).toEqual({ id: "core.product_category", label: "Categoría de producto", recordPage: true });
    expect(catalogue.members[fixture.userId]).toMatch(/^Auth user /);
  });

  it("gives the titles of the records the grid links to, read through their masked views", async () => {
    expect(await auditTitlesAction([{ entity: "core.parties", id: partyId }, { entity: "kernel.roles", id: partyId }])).toEqual({ [partyId]: "Café del Norte S.A.S." });
  });
});

describe("audit entry detail", () => {
  it("lists a party update as label · antes → después, from the process entry and from the row change alike", async () => {
    for (const processRow of [true, false]) {
      const result = await auditEntryAction(await entryId("core.party.update", processRow));
      expect(result.ok).toBe(true);
      const view = (result as Extract<typeof result, { ok: true }>).view;
      const lines = view.changes.map((c) => `${c.label} · ${c.before} → ${c.after}`);
      expect(lines).toContain("Nombre comercial · — → Bosque QA");
      // The credit limit a creation stores is 0.
      expect(lines).toContain("Cupo de crédito · $ 0,00 → $ 1.500.000,00");
      expect(view.process).toEqual({ id: "core.party.update", description: "Actualiza los datos de un tercero y recalcula su estado DIAN" });
      expect(view.entityLabel).toBe("Tercero");
      expect(view.rowHref).toBe(`/r/core.party/${partyId}`);
      expect(view.rowTitle).toBe("Café del Norte S.A.S.");
      expect(view.input).toBeNull();
    }
  });

  it("shows a creation's input and stored values by their labels: option labels and the pack's codes", async () => {
    const result = await auditEntryAction(await entryId("core.party.create"));
    const view = (result as Extract<typeof result, { ok: true }>).view;
    expect(view.input).toEqual(expect.arrayContaining([expect.objectContaining({ label: "Tipo de documento", value: "31 · NIT" }), expect.objectContaining({ label: "Tipo de tercero", value: "Cliente" })]));
    expect(view.changes).toEqual(expect.arrayContaining([expect.objectContaining({ label: "Municipio", before: "—", after: "Bogotá D.C." })]));
  });

  it("refuses an id that is not an entry", async () => {
    expect(await auditEntryAction("not-an-id")).toMatchObject({ ok: false, code: "invalid_input" });
  });

  it("shows •••••• for a field the viewer's role masks (a viewer who is not the company admin)", async () => {
    // The audit view is the admin's: the entry is read as the admin, then described and presented as a seller of the
    // same company whose role masks the credit limit and hides the trade name.
    const [role] = await fixture.sql<{ id: string }[]>`insert into kernel.roles (company_id, name, is_system) values (${companyId}, 'vendedor', false) returning id`;
    const [membership] = await fixture.sql<{ id: string }[]>`insert into kernel.memberships (user_id, company_id) values (${reader.userId}, ${companyId}) returning id`;
    await fixture.sql`insert into kernel.membership_roles (membership_id, role_id) values (${membership!.id}, ${role!.id})`;
    await fixture.sql`insert into kernel.field_permissions (company_id, role_id, entity, field, mode) values
      (${companyId}, ${role!.id}, 'core.party', 'credit_limit', 'masked'), (${companyId}, ${role!.id}, 'core.party', 'trade_name', 'hidden')`;
    const seller: JwtClaims = { sub: reader.userId, tenant_id: fixture.tenantId, company_ids: [companyId], active_company_id: companyId, role_ids: [role!.id], locale: "es-419" };
    const { sql, registry } = processDeps();
    const caller = await requireCaller();
    const record = (await withClaims(sql, caller.claims, async (tx) => readAuditEntry(tx, await entryId("core.party.update"))))!;
    expect(record).not.toBeNull();
    // The seller reads nothing of the log itself.
    expect(await withClaims(sql, seller, (tx) => readAuditEntry(tx, record.id))).toBeNull();
    const detail = await withClaims(sql, seller, (tx) => auditEntryDetail(tx, registry, record));
    const view = presentAuditDetail(detail, await auditLabels(), recordPageEntities(registry.entities()));
    const lines = view.changes.map((c) => `${c.label} · ${c.before} → ${c.after}`);
    expect(lines).toContain("Cupo de crédito · •••••• → ••••••");
    expect(lines.some((l) => l.startsWith("Nombre comercial"))).toBe(false);
    expect(JSON.stringify(view)).not.toContain("1.500.000");
    expect(JSON.stringify(view)).not.toContain("Bosque QA");
  });
});
