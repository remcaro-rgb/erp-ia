import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { seedAuthUser, type AuthFixture } from "../../../../test-support/auth-fixtures";
import { MemoryJar } from "../../../../test-support/memory-jar";

const state = vi.hoisted(() => ({ jar: undefined as unknown }));
vi.mock("next/headers", () => ({ cookies: async () => state.jar, headers: async () => new Headers() }));
vi.mock("next-intl/server", () => ({ getLocale: async () => "es-419", getTranslations: async () => (key: string) => key }));

import { runProcess } from "@erp/kernel";
import { loginWithPassword } from "@/lib/auth/login";
import { requireCaller } from "@/lib/auth/claims";
import { processDeps } from "@/lib/server/runtime";
import { loadRecord } from "../load";
import { saveRecordAction } from "../actions";
import { cloneRecordAction } from "../clone";
import { createTicketAction, loadTicketAction } from "@/lib/support/actions";

// "Duplicar" wired to the processes (rule 37, design §22.13): the action reads the source through the entity's consult
// as the session's user and hands the create form its visible data without the identity fields; the save runs the
// entity's create process with the source recorded in the audit.

const GRANTS = ["support.ticket.create", "support.ticket.consult", "core.party.consult", "core.party.create", "core.party.update", "core.product.consult", "core.product.create", "core.contact.list", "kernel.custom_field.list", "kernel.attachment.list"];

const juridica = {
  kind: ["customer"],
  personType: "1",
  documentType: "31",
  documentNumber: "890900608",
  legalName: "Almacenes Éxito S.A.",
  taxResponsibilities: ["O-13"],
  taxScheme: "01",
  countryCode: "CO",
  departmentCode: "11",
  municipalityCode: "11001",
  addressLine: "Cra 48 # 32B Sur-139",
  invoiceEmail: "fe@exito.com",
  creditLimit: 250_000_000,
};

let fixture: AuthFixture;
let reader: AuthFixture;
let companyId: string;
const jars = new Map<string, MemoryJar>();

async function signInAs(user: AuthFixture) {
  let jar = jars.get(user.userId);
  if (!jar) {
    jar = new MemoryJar();
    await loginWithPassword(jar, { email: user.email, password: user.password, remember: false });
    jars.set(user.userId, jar);
  }
  state.jar = jar;
}
const run = async (process: string, input: unknown) => runProcess(processDeps(), await requireCaller(), process, input) as Promise<{ id: string }>;

beforeAll(async () => {
  fixture = await seedAuthUser({ role: "member" });
  reader = await seedAuthUser({ role: "member" });
  companyId = fixture.companyIds[0]!;
  const { sql } = fixture;
  await sql`insert into kernel.tenant_entitlements(tenant_id, key, source) values (${fixture.tenantId}, 'module:core', 'manual'), (${fixture.tenantId}, 'module:support', 'manual'), (${reader.tenantId}, 'module:core', 'manual')`;
  const [role] = await sql<{ id: string }[]>`select id from kernel.roles where company_id = ${companyId}`;
  for (const process of GRANTS) await sql`insert into kernel.process_permissions(company_id, role_id, process_id) values (${companyId}, ${role!.id}, ${process})`;
  const roles = [role!.id];
  await sql`insert into kernel.custom_fields(company_id, entity, key, label, type, max_length, required, roles_enter, roles_edit, roles_view)
            values (${companyId}, 'core.party', 'canal', 'Canal de venta', 'text', 20, false, ${roles}, ${roles}, ${roles}),
                   (${companyId}, 'core.party', 'zona', 'Zona', 'text', 20, false, ${[]}::uuid[], ${[]}::uuid[], ${roles})`;
  const readerCompany = reader.companyIds[0]!;
  const [readerRole] = await sql<{ id: string }[]>`select id from kernel.roles where company_id = ${readerCompany}`;
  for (const process of ["core.party.consult", "core.contact.list", "kernel.attachment.list", "kernel.custom_field.list"]) {
    await sql`insert into kernel.process_permissions(company_id, role_id, process_id) values (${readerCompany}, ${readerRole!.id}, ${process})`;
  }
  await signInAs(fixture);
});

afterAll(async () => {
  const { sql } = fixture;
  const companies = [...fixture.companyIds, ...reader.companyIds];
  await sql.begin(async (tx) => {
    await tx`set local session_replication_role = replica`;
    await tx`delete from core.parties where company_id = any(${companies}::uuid[])`;
    await tx`delete from support.tickets where company_id = any(${companies}::uuid[])`;
  });
  await sql`delete from core.entity_sequences where company_id = any(${companies}::uuid[])`;
  await sql`delete from kernel.outbox where company_id = any(${companies}::uuid[])`;
  await sql`delete from kernel.process_permissions where company_id = any(${companies}::uuid[])`;
  await sql`delete from kernel.custom_fields where company_id = any(${companies}::uuid[])`;
  await sql`delete from kernel.tenant_entitlements where tenant_id = any(${[fixture.tenantId, reader.tenantId]}::uuid[])`;
  await reader.cleanup();
  await fixture.cleanup();
});

describe("Duplicar", () => {
  it("hands the create form the source's visible data without its identity, and the save records the source", async () => {
    await signInAs(fixture);
    const { id: sourceId } = await run("core.party.create", { ...juridica, extra: { canal: "Mayoristas" }, extraFree: [{ name: "Ruta", value: "Norte 3" }] });
    // A value the caller sees but may not enter (an admin wrote it): the copy leaves it out, the create would refuse it.
    await fixture.sql`update core.parties set extra = extra || '{"zona": "Norte"}'::jsonb where id = ${sourceId}`;
    expect(((await loadRecord("core.party", sourceId))!.record!.extra as Record<string, unknown>).zona).toBe("Norte");
    expect((await loadRecord("core.party", sourceId))!.can.duplicate).toBe(true);

    const clone = await cloneRecordAction("core.party", sourceId);
    expect(clone).toMatchObject({ ok: true, entity: "core.party", sourceRowId: sourceId, sourceTitle: "Almacenes Éxito S.A." });
    if (!clone.ok) throw new Error("clone refused");
    expect(clone.values).toMatchObject({ kind: ["customer"], document_type: "31", legal_name: "Almacenes Éxito S.A.", invoice_email: "fe@exito.com", credit_limit: 250_000_000 });
    for (const field of ["id", "seq", "document_number", "check_digit", "dian_status", "invoice_ready", "company_id", "created_at"]) expect(clone.values).not.toHaveProperty(field);
    // The datos adicionales the caller sees travel with the save (the create form does not edit them).
    expect(clone.carry).toEqual({ extra: { canal: "Mayoristas" }, extraFree: [{ name: "Ruta", value: "Norte 3" }] });

    // The form's input without a NIT is refused like any party's; with a new one it is created from the source.
    const withoutNit: Record<string, unknown> = { ...juridica };
    delete withoutNit.documentNumber;
    const refused = await saveRecordAction("core.party", withoutNit, undefined, { sourceRowId: sourceId });
    expect(refused).toMatchObject({ ok: false, code: "invalid_input" });
    expect(!refused.ok && refused.details.some((d) => d.path?.[0] === "documentNumber")).toBe(true);
    const saved = await saveRecordAction("core.party", { ...clone.carry, ...withoutNit, documentNumber: "860002964" }, undefined, { sourceRowId: sourceId });
    expect(saved).toMatchObject({ ok: true });
    const newId = (saved as { id: string }).id;
    const [entry] = await fixture.sql`select source_row_id, origin from kernel.audit_log where row_id = ${newId} and process_id = 'core.party.create' and diff is null`;
    expect(entry).toMatchObject({ source_row_id: sourceId, origin: "ui" });
    const [stored] = await fixture.sql`select extra, extra_free from core.parties where id = ${newId}`;
    expect(stored).toMatchObject({ extra: { canal: "Mayoristas" }, extra_free: [{ name: "Ruta", value: "Norte 3" }] });
  });

  it("an update never carries a source, and a source the caller cannot read is refused", async () => {
    await signInAs(fixture);
    const { id: sourceId } = await run("core.party.create", { ...juridica, documentNumber: "800197268" });
    // The source must be a record the caller reads through the entity's consult.
    const unknown = await saveRecordAction("core.party", { ...juridica, documentNumber: "900373115" }, undefined, { sourceRowId: "0190d8b2-1c1e-7000-8000-000000000000" });
    expect(unknown).toMatchObject({ ok: false, code: "not_found" });
    // An update is an update: the option is ignored.
    const updated = await saveRecordAction("core.party", { id: sourceId, tradeName: "Éxito" }, undefined, { sourceRowId: sourceId });
    expect(updated).toEqual({ ok: true, id: sourceId });
  });

  it("is refused to a caller who may not create, and for a record they cannot see", async () => {
    await signInAs(fixture);
    const { id: sourceId } = await run("core.party.create", { ...juridica, documentNumber: "811000001" });
    await signInAs(reader);
    expect(await cloneRecordAction("core.party", sourceId)).toMatchObject({ ok: false, code: "forbidden" });
    const own = await reader.sql<{ id: string }[]>`insert into core.parties (company_id, kind, person_type, document_type, document_number, legal_name, dian_status)
      values (${reader.companyIds[0]!}, ${["customer"]}, '1', '31', '900111222', 'Tercero del lector', 'complete') returning id`;
    expect((await loadRecord("core.party", own[0]!.id))!.can.duplicate).toBe(false);
    expect(await cloneRecordAction("core.party", own[0]!.id)).toMatchObject({ ok: false, code: "forbidden" });
    await signInAs(fixture);
    // Another company's record looks missing; an entity without a page or a malformed id is bad input.
    expect(await cloneRecordAction("core.party", own[0]!.id)).toMatchObject({ ok: false, code: "not_found" });
    expect(await cloneRecordAction("core.nope", sourceId)).toMatchObject({ ok: false, code: "invalid_input" });
    expect(await cloneRecordAction("core.party", "x")).toMatchObject({ ok: false, code: "invalid_input" });
  });

  it("copies a ticket for the support screen's form, and files it with its source", async () => {
    await signInAs(fixture);
    const context = { route: "/parties", selection: "", lastAuditIds: [], consoleErrors: [] };
    const { id: sourceId } = await run("support.ticket.create", { kind: "question", title: "¿Cómo importo productos?", body: "No encuentro la plantilla.", context });
    const clone = await cloneRecordAction("support.ticket", sourceId);
    expect(clone).toMatchObject({ ok: true, entity: "support.ticket", sourceTitle: "¿Cómo importo productos?", values: { kind: "question", title: "¿Cómo importo productos?", context } });
    if (!clone.ok) throw new Error("clone refused");
    expect(clone.values).not.toHaveProperty("seq");
    expect(clone.values).not.toHaveProperty("status");
    const filed = await createTicketAction({ kind: "question", title: "¿Cómo importo productos?", body: "Otra vez.", context }, { sourceRowId: clone.sourceRowId });
    expect(filed).toMatchObject({ ok: true });
    const [entry] = await fixture.sql`select source_row_id from kernel.audit_log where row_id = ${(filed as { id: string }).id} and process_id = 'support.ticket.create' and diff is null`;
    expect(entry!.source_row_id).toBe(sourceId);
    expect((await loadTicketAction(sourceId)).ok && (await loadTicketAction(sourceId))).toMatchObject({ ticket: { canCreate: true } });
  });
});
