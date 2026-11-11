import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { seedAuthUser, type AuthFixture } from "../../../../test-support/auth-fixtures";
import { MemoryJar } from "../../../../test-support/memory-jar";

const state = vi.hoisted(() => ({ jar: undefined as unknown }));
vi.mock("next/headers", () => ({ cookies: async () => state.jar, headers: async () => new Headers() }));
// The record loader reads the request's locale and translations; the catalogue is not under test here.
vi.mock("next-intl/server", () => ({ getLocale: async () => "es-419", getTranslations: async () => (key: string) => key }));

import { runProcess, setFileStore } from "@erp/kernel";
import { MemoryFileStore } from "@erp/kernel/testing";
import { loginWithPassword } from "@/lib/auth/login";
import { requireCaller } from "@/lib/auth/claims";
import { processDeps } from "@/lib/server/runtime";
import { loadRecord } from "../load";
import { saveRecordAction } from "../actions";
import { createContactAction, removeContactAction, reorderPhotosAction, requestVerificationAction, suggestPhotoAction, updateContactAction } from "../tab-actions";

// The record page's tabs wired to the processes (Task 12b; design §5.13, §5.14, §5.16, §5.18) against the real stack:
// the server actions the tabs call run `core.contact.*`, `<entity>.update`, `kernel.attachment.reorder`,
// `kernel.ai.image_suggest` and `kernel.verify.request` as the session's user, and the loader hands the page the
// required files that apply to the record and what the caller may do.

const GRANTS = [
  "core.party.consult",
  "core.party.create",
  "core.party.update",
  "core.product.consult",
  "core.product.create",
  "core.product.update",
  "core.contact.list",
  "core.contact.create",
  "core.contact.update",
  "core.contact.delete",
  "kernel.custom_field.list",
  "kernel.attachment.add",
  "kernel.attachment.list",
  "kernel.attachment.remove",
  "kernel.attachment.reorder",
  "kernel.ai.image_suggest",
  "kernel.verify.request",
  "kernel.verify.status",
];

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
const cafe = {
  sku: "CAF-500",
  description: "Café tostado molido 500 g",
  kind: "good",
  idScheme: "010",
  standardCode: "7702001005000",
  uomCode: "94",
  ivaRate: "5",
  otherTaxes: [],
  listPrice: 28500,
  isFreeSample: false,
  standardCost: 16200,
  trackStock: true,
};
const draft = { name: "Ana Gómez", jobTitle: "Tesorera", email: "ana@cafedelnorte.co", phoneCc: "57", phone: "6015550000", ext: "123", mobileCc: "57", mobile: "3001234567" };

let fixture: AuthFixture;
let reader: AuthFixture;
let companyId: string;
const store = new MemoryFileStore();
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
const run = async (process: string, input: unknown) => runProcess(processDeps(), await requireCaller(), process, input);

/** A stored file of the record, as the service role (the attachment route is not under test here). */
async function file(entity: string, recordId: string, tag: string, fileName: string, mimeType = "application/pdf") {
  const { tenantId } = fixture;
  await fixture.sql`insert into kernel.attachments(company_id, entity, record_id, tag, file_name, mime_type, size_bytes, storage_path)
    values (${companyId}, ${entity}, ${recordId}, ${tag}, ${fileName}, ${mimeType}, 10, ${`${tenantId}/${companyId}/${entity}/${recordId}/0192-${fileName}`})`;
}

beforeAll(async () => {
  setFileStore(store);
  fixture = await seedAuthUser({ role: "member" });
  reader = await seedAuthUser({ role: "member" });
  companyId = fixture.companyIds[0]!;
  const { sql } = fixture;
  await sql`insert into kernel.tenant_entitlements(tenant_id, key, source) values (${fixture.tenantId}, 'module:core', 'manual'), (${reader.tenantId}, 'module:core', 'manual')`;
  const [role] = await sql<{ id: string }[]>`select id from kernel.roles where company_id = ${companyId}`;
  for (const process of GRANTS) await sql`insert into kernel.process_permissions(company_id, role_id, process_id) values (${companyId}, ${role!.id}, ${process})`;
  // The reader may only look.
  const readerCompany = reader.companyIds[0]!;
  const [readerRole] = await sql<{ id: string }[]>`select id from kernel.roles where company_id = ${readerCompany}`;
  for (const process of ["core.party.consult", "core.product.consult", "core.contact.list", "kernel.attachment.list", "kernel.custom_field.list"]) {
    await sql`insert into kernel.process_permissions(company_id, role_id, process_id) values (${readerCompany}, ${readerRole!.id}, ${process})`;
  }
  // The company's required files (what kernel.seed_required_attachments gives a Colombian company).
  await sql`insert into kernel.required_attachments(company_id, entity, tag, kind, required, condition, description) values
    (${companyId}, 'core.party', 'RUT', 'pdf', true, 'co', 'Registro Único Tributario vigente'),
    (${companyId}, 'core.party', 'Cámara de Comercio', 'pdf', true, 'co-juridica', 'Certificado de existencia'),
    (${companyId}, 'core.party', 'Certificación bancaria', 'pdf', false, 'proveedor', 'Cuenta bancaria'),
    (${companyId}, 'core.product', 'Ficha técnica', 'pdf', false, null, 'Ficha técnica del producto')`;
  // Fields the member role may enter, edit and see.
  const roles = [role!.id];
  await sql`insert into kernel.custom_fields(company_id, entity, key, label, type, max_length, required, roles_enter, roles_edit, roles_view) values
    (${companyId}, 'core.party', 'canal', 'Canal de venta', 'text', 20, false, ${roles}, ${roles}, ${roles}),
    (${companyId}, 'core.party', 'cupo_extra', 'Cupo extra', 'number', null, false, ${roles}, ${roles}, ${roles})`;
  await signInAs(fixture);
});

afterAll(async () => {
  setFileStore(undefined);
  const { sql } = fixture;
  await sql.begin(async (tx) => {
    await tx`set local session_replication_role = replica`;
    await tx`delete from core.party_contacts where company_id = ${companyId}`;
    await tx`delete from core.parties where company_id = ${companyId}`;
    await tx`delete from core.products where company_id = ${companyId}`;
    await tx`delete from kernel.attachments where company_id = ${companyId}`;
  });
  await sql`delete from kernel.verification_requests where company_id = ${companyId}`;
  await sql`delete from core.entity_sequences where company_id = any(${[...fixture.companyIds, ...reader.companyIds]}::uuid[])`;
  await sql`delete from kernel.outbox where company_id = ${companyId}`;
  await sql`delete from kernel.custom_fields where company_id = ${companyId}`;
  await sql`delete from kernel.required_attachments where company_id = ${companyId}`;
  await sql`delete from kernel.process_permissions where company_id = any(${[...fixture.companyIds, ...reader.companyIds]}::uuid[])`;
  await sql`delete from kernel.tenant_entitlements where tenant_id = any(${[fixture.tenantId, reader.tenantId]}::uuid[])`;
  await reader.cleanup();
  await fixture.cleanup();
});

describe("contacts", () => {
  it("creates, updates and removes a contact of a party through core.contact.*, and the loader lists it", async () => {
    await signInAs(fixture);
    const { id: partyId } = await run("core.party.create", juridica);

    const created = await createContactAction(partyId, draft);
    expect(created).toMatchObject({ ok: true, id: expect.any(String) });
    const id = (created as { id: string }).id;
    const listed = (await loadRecord("core.party", partyId))!.contacts;
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ id, name: "Ana Gómez", jobTitle: "Tesorera", email: "ana@cafedelnorte.co", phone: "6015550000", ext: "123", mobile: "3001234567" });

    expect(await updateContactAction(id, { ...draft, jobTitle: "Jefe de compras", ext: "" })).toEqual({ ok: true, id });
    expect((await loadRecord("core.party", partyId))!.contacts[0]).toMatchObject({ jobTitle: "Jefe de compras", ext: null });

    expect(await removeContactAction(id)).toEqual({ ok: true, id });
    expect((await loadRecord("core.party", partyId))!.contacts).toHaveLength(0);
    // The three runs are audited under their own processes, as the session's user, origin ui.
    const audit = await fixture.sql`select distinct process_id, origin from kernel.audit_log where process_id like 'core.contact.%' and row_id = ${id}`;
    expect(audit.map((a) => a.process_id).sort()).toEqual(["core.contact.create", "core.contact.delete", "core.contact.update"]);
    expect(audit.every((a) => a.origin === "ui")).toBe(true);
  });

  it("answers a refusal with the process's messages instead of throwing", async () => {
    await signInAs(fixture);
    const { id: partyId } = await run("core.party.create", { ...juridica, documentNumber: "900373116" });
    const bad = await createContactAction(partyId, { ...draft, email: "no-es-un-correo" });
    expect(bad).toMatchObject({ ok: false, code: "invalid_input" });
    expect((bad as { details: { message: string }[] }).details.map((d: { message: string }) => d.message).join(" ")).toMatch(/Correo/);
    expect(await createContactAction("00000000-0000-4000-8000-000000000000", draft)).toMatchObject({ ok: false, code: "not_found" });
    expect(await updateContactAction("not-a-uuid", draft)).toMatchObject({ ok: false, code: "invalid_input" });
  });

  it("a caller without the contact processes is refused and the loader says the tab is read-only for them", async () => {
    await signInAs(fixture);
    const { id: partyId } = await run("core.party.create", { ...juridica, documentNumber: "900373117" });
    const contact = await createContactAction(partyId, draft);
    const grants = await loadRecord("core.party", partyId);
    expect(grants!.can).toMatchObject({ contactCreate: true, contactUpdate: true, contactDelete: true, extra: true, attach: true });

    await signInAs(reader);
    // The reader's company has no such party; give them their own and check the flags and the refusal.
    const own = await reader.sql<{ id: string }[]>`insert into core.parties (company_id, kind, person_type, document_type, document_number, legal_name, dian_status)
      values (${reader.companyIds[0]!}, ${["customer"]}, '1', '31', '900111222', 'Tercero del lector', 'complete') returning id`;
    const loaded = await loadRecord("core.party", own[0]!.id);
    expect(loaded!.can).toMatchObject({ contactCreate: false, contactUpdate: false, contactDelete: false, extra: false, attach: false, reorder: false, suggest: false });
    // The reader may list files: an empty list is a list. Without that permission the page gets no list at all (null),
    // so the Archivos tab says it could not load them instead of showing "no files".
    expect(loaded!.attachments).toEqual([]);
    const [readerRole] = await reader.sql<{ id: string }[]>`select id from kernel.roles where company_id = ${reader.companyIds[0]!}`;
    await reader.sql`delete from kernel.process_permissions where role_id = ${readerRole!.id} and process_id = 'kernel.attachment.list'`;
    try {
      expect((await loadRecord("core.party", own[0]!.id))!.attachments).toBeNull();
    } finally {
      await reader.sql`insert into kernel.process_permissions(company_id, role_id, process_id) values (${reader.companyIds[0]!}, ${readerRole!.id}, 'kernel.attachment.list')`;
    }
    expect(await createContactAction(own[0]!.id, draft)).toMatchObject({ ok: false, code: "forbidden" });
    expect(await removeContactAction((contact as { id: string }).id)).toMatchObject({ ok: false, code: "forbidden" });
    await reader.sql`delete from core.parties where company_id = ${reader.companyIds[0]!}`;
    await signInAs(fixture);
  });

  it("requests the external verification of a contact's e-mail and phone: queued without a provider", async () => {
    await signInAs(fixture);
    const { id: partyId } = await run("core.party.create", { ...juridica, documentNumber: "900373118" });
    expect(await requestVerificationAction("core.party", partyId, "email", "ana@cafedelnorte.co")).toEqual({ ok: true, status: "queued" });
    expect(await requestVerificationAction("core.party", partyId, "phone", "+576015550000")).toEqual({ ok: true, status: "queued" });
    const rows = await fixture.sql`select kind, value, status from kernel.verification_requests where record_id = ${partyId} order by kind`;
    expect(rows.map((r) => [r.kind, r.value, r.status])).toEqual([["email", "ana@cafedelnorte.co", "queued"], ["phone", "+576015550000", "queued"]]);
    expect(await requestVerificationAction("core.party", partyId, "email", "roto")).toMatchObject({ ok: false, code: "invalid_input" });
  });
});

describe("what the page reads back", () => {
  it("the verification status of the contacts' e-mails and phones survives a reload (kernel.verify.status), and the files are listed for the Archivos tab", async () => {
    await signInAs(fixture);
    const { id: partyId } = await run("core.party.create", { ...juridica, documentNumber: "900373130" });
    await createContactAction(partyId, draft);
    expect((await loadRecord("core.party", partyId))!.verifications).toEqual({});
    await requestVerificationAction("core.party", partyId, "email", draft.email);
    await requestVerificationAction("core.party", partyId, "phone", "+576015550000");
    const loaded = (await loadRecord("core.party", partyId))!;
    expect(loaded.verifications).toEqual({ "email:ana@cafedelnorte.co": "queued", "phone:+576015550000": "queued" });
    // Asking twice does not add a request.
    await requestVerificationAction("core.party", partyId, "email", draft.email);
    expect((await fixture.sql`select 1 from kernel.verification_requests where record_id = ${partyId} and kind = 'email'`).length).toBe(1);

    expect(loaded.attachments).toEqual([]);
    await file("core.party", partyId, "RUT", "rut.pdf");
    expect((await loadRecord("core.party", partyId))!.attachments).toMatchObject([{ tag: "RUT", fileName: "rut.pdf", position: 0 }]);
  });
});

describe("step-up on the tab actions", () => {
  it("a sensitive process answers step_up_required and runs once the user's fresh token is presented", async () => {
    await signInAs(fixture);
    const { id: partyId } = await run("core.party.create", { ...juridica, documentNumber: "900373131" });
    const processes = ["core.contact.create", "kernel.attachment.reorder", "kernel.ai.image_suggest"];
    for (const process of processes) await fixture.sql`insert into kernel.sensitive_processes(company_id, process_id, mode) values (${companyId}, ${process}, 'self_2fa')`;
    try {
      const token = async () => {
        const value = randomUUID();
        await fixture.sql`insert into kernel.step_up_verifications(user_id, company_id, token) values (${fixture.userId}, ${companyId}, ${value})`;
        return value;
      };
      expect(await createContactAction(partyId, draft)).toMatchObject({ ok: false, code: "step_up_required" });
      expect(await createContactAction(partyId, draft, await token())).toMatchObject({ ok: true });
      // The token is consumed by the run.
      const used = await token();
      await createContactAction(partyId, { ...draft, name: "Otra" }, used);
      expect(await createContactAction(partyId, { ...draft, name: "Otra más" }, used)).toMatchObject({ ok: false, code: "step_up_required" });

      const { id: productId } = await run("core.product.create", { ...cafe, sku: "CAF-SU", standardCode: undefined });
      expect(await suggestPhotoAction("core.product", productId, { description: "Café" })).toMatchObject({ ok: false, code: "step_up_required" });
      expect(await suggestPhotoAction("core.product", productId, { description: "Café" }, await token())).toMatchObject({ ok: true });
      expect(await reorderPhotosAction("core.product", productId, ["00000000-0000-4000-8000-000000000000"])).toMatchObject({ ok: false, code: "step_up_required" });
    } finally {
      await fixture.sql`delete from kernel.sensitive_processes where company_id = ${companyId}`;
      await fixture.sql`delete from kernel.step_up_verifications where company_id = ${companyId}`;
    }
  });
});

describe("datos adicionales", () => {
  it("saves extra and extraFree through <entity>.update, touching nothing else; a bad value comes back with its message", async () => {
    await signInAs(fixture);
    const { id: partyId } = await run("core.party.create", { ...juridica, documentNumber: "900373119" });
    const before = (await loadRecord("core.party", partyId))!;
    expect(before.defs.map((d: { key: string }) => d.key)).toEqual(expect.arrayContaining(["canal", "cupo_extra"]));

    const ok = await saveRecordAction("core.party", { id: partyId, extra: { canal: "Mayoristas", cupo_extra: 2500000 }, extraFree: [{ name: "Ruta", value: "Norte 3" }] });
    expect(ok).toEqual({ ok: true, id: partyId, updatedAt: expect.any(String) });
    const after = (await loadRecord("core.party", partyId))!;
    expect(after.record).toMatchObject({ extra: { canal: "Mayoristas", cupo_extra: 2500000 }, extra_free: [{ name: "Ruta", value: "Norte 3" }], legal_name: "Café del Norte S.A.S.", dian_status: before.record!.dian_status });

    const bad = await saveRecordAction("core.party", { id: partyId, extra: { canal: "x".repeat(40), cupo_extra: "mucho" } });
    expect(bad).toMatchObject({ ok: false, code: "invalid_input" });
    expect((bad as { details: { message: string }[] }).details.length).toBeGreaterThan(0);
    expect((await loadRecord("core.party", partyId))!.record).toMatchObject({ extra: { canal: "Mayoristas" } });
  });
});

describe("datos adicionales: only what changed", () => {
  it("saves a patch of the changed keys: another writer's value for a key the form did not touch survives", async () => {
    await signInAs(fixture);
    const { id: partyId } = await run("core.party.create", { ...juridica, documentNumber: "900373132" });
    await saveRecordAction("core.party", { id: partyId, extra: { canal: "Mayoristas", cupo_extra: 1 } });
    // A form loaded now would hold cupo_extra = 1; somebody saves 2 meanwhile; the form then saves its own change.
    await saveRecordAction("core.party", { id: partyId, extraPatch: { cupo_extra: 2 } });
    expect(await saveRecordAction("core.party", { id: partyId, extraPatch: { canal: "Minoristas" } })).toEqual({ ok: true, id: partyId, updatedAt: expect.any(String) });
    expect((await loadRecord("core.party", partyId))!.record).toMatchObject({ extra: { canal: "Minoristas", cupo_extra: 2 } });
    expect(await saveRecordAction("core.party", { id: partyId, extraPatch: { canal: null } })).toEqual({ ok: true, id: partyId, updatedAt: expect.any(String) });
    expect((await loadRecord("core.party", partyId))!.record).toMatchObject({ extra: { cupo_extra: 2 } });
  });

  it("the tab is read-only for a role whose `extra` column is masked", async () => {
    await signInAs(fixture);
    const { id: partyId } = await run("core.party.create", { ...juridica, documentNumber: "900373133" });
    expect((await loadRecord("core.party", partyId))!.can.extra).toBe(true);
    const [role] = await fixture.sql<{ id: string }[]>`select id from kernel.roles where company_id = ${companyId}`;
    await fixture.sql`insert into kernel.field_permissions(company_id, role_id, entity, field, mode) values (${companyId}, ${role!.id}, 'core.party', 'extra', 'masked')`;
    try {
      expect((await loadRecord("core.party", partyId))!.can.extra).toBe(false);
    } finally {
      await fixture.sql`delete from kernel.field_permissions where company_id = ${companyId}`;
    }
  });
});

describe("photos", () => {
  it("reorders a product's photos (the order persists and the list returns it) and approves a suggestion made principal", async () => {
    await signInAs(fixture);
    const { id: productId } = await run("core.product.create", cafe);
    await file("core.product", productId, "Foto", "empaque.png", "image/png");
    await file("core.product", productId, "Foto", "taza.png", "image/png");
    const ids = async () => (await run("kernel.attachment.list", { entity: "core.product", recordId: productId })).map((a: { id: string }) => a.id);
    const [first, second] = await ids();

    expect(await reorderPhotosAction("core.product", productId, [second!, first!])).toEqual({ ok: true });
    expect(await ids()).toEqual([second, first]);

    const stored = store.files.size;
    const suggestion = await suggestPhotoAction("core.product", productId, { description: cafe.description, uom: "94", category: "Café" });
    expect(suggestion).toMatchObject({ ok: true, attachment: { tag: "Foto · IA", suggested: true, mimeType: "image/svg+xml" } });
    const suggestedId = (suggestion as unknown as { attachment: { id: string } }).attachment.id;
    expect(store.files.size).toBe(stored + 1);
    expect(await ids()).toEqual([second, first, suggestedId]);

    await reorderPhotosAction("core.product", productId, [suggestedId, second!, first!]);
    const list = await run("kernel.attachment.list", { entity: "core.product", recordId: productId });
    expect(list[0]).toMatchObject({ id: suggestedId, suggested: false });
  });

  it("answers a refusal with its code: unknown ids and a missing record", async () => {
    await signInAs(fixture);
    const { id: productId } = await run("core.product.create", { ...cafe, sku: "CAF-250", standardCode: undefined });
    expect(await reorderPhotosAction("core.product", productId, ["00000000-0000-4000-8000-000000000000"])).toMatchObject({ ok: false, code: "invalid_input" });
    expect(await suggestPhotoAction("core.product", "00000000-0000-4000-8000-000000000000", { description: "Algo" })).toMatchObject({ ok: false, code: "not_found" });
  });
});

describe("required files", () => {
  it("hands the page the requirements that apply to the record, in tag order", async () => {
    await signInAs(fixture);
    const { id: customer } = await run("core.party.create", { ...juridica, documentNumber: "900373120" });
    const loaded = (await loadRecord("core.party", customer))!;
    expect(loaded.requiredTags).toEqual([
      { tag: "Cámara de Comercio", kind: "pdf", required: true, description: "Certificado de existencia" },
      { tag: "RUT", kind: "pdf", required: true, description: "Registro Único Tributario vigente" },
    ]);
    expect(loaded.record).toMatchObject({ invoice_ready: false });

    // A natural-person supplier needs the RUT and may bring a bank certificate; no Cámara de Comercio.
    const { id: natural } = await run("core.party.create", {
      ...juridica,
      kind: ["supplier"],
      personType: "2",
      documentType: "13",
      documentNumber: "52123456",
      legalName: undefined,
      firstName: "Ana",
      firstSurname: "Gómez",
      taxResponsibilities: ["R-99-PN"],
      taxScheme: "ZZ",
      supplierEmail: "compras@ana.co",
      invoiceEmail: undefined,
    });
    expect((await loadRecord("core.party", natural))!.requiredTags.map((r) => r.tag)).toEqual(["Certificación bancaria", "RUT"]);

    // A product has only the optional data sheet.
    const { id: product } = await run("core.product.create", { ...cafe, sku: "CAF-1000", standardCode: undefined });
    expect((await loadRecord("core.product", product))!.requiredTags).toEqual([{ tag: "Ficha técnica", kind: "pdf", required: false, description: "Ficha técnica del producto" }]);
  });

  it("after the files are uploaded the reloaded record is invoice ready", async () => {
    await signInAs(fixture);
    const { id } = await run("core.party.create", { ...juridica, documentNumber: "900373121" });
    expect((await loadRecord("core.party", id))!.record).toMatchObject({ invoice_ready: false });
    await file("core.party", id, "RUT", "rut.pdf");
    await file("core.party", id, "Cámara de Comercio", "camara.pdf");
    expect((await loadRecord("core.party", id))!.record).toMatchObject({ invoice_ready: true });
  });
});
