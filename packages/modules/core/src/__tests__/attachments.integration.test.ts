import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { defineEntity, MAX_ATTACHMENT_BYTES, missingAttachments, precheckAttachment, runProcess, type Caller } from "@erp/kernel";
import { seedTenant, withClaims } from "@erp/kernel/testing";
import { coreHarness, exito, type CoreHarness } from "./helpers";

// Attachments on any entity (design §5.13, §5.17). They live in the core suite, not the kernel's,
// because the owning entity (a party or a product), its update permission and `invoice_ready` are core's:
// @erp/kernel cannot depend on @erp/module-core.

const PARTY = "core.party";
const PRODUCT = "core.product";

describe("kernel attachments", () => {
  let h: CoreHarness;
  let sql: CoreHarness["sql"];
  let deps: CoreHarness["deps"];
  let admin: Caller;
  let cashier: Caller;
  let otherCompanyAdmin: Caller;
  let nextDocument = 910000100;

  beforeAll(async () => {
    h = await coreHarness({ companies: 2, users: [{ name: "cashier", companies: [0], role: "member" }] });
    ({ sql, deps, admin } = h);
    cashier = { claims: h.seed.claimsFor(h.seed.users.cashier!, h.companyId), origin: "ui" };
    otherCompanyAdmin = { claims: h.seed.claimsFor(h.seed.users.both, h.seed.companies[1]!.id), origin: "ui" };
  });
  afterAll(async () => {
    await h.cleanup();
  });

  /** A complete Colombian juridical customer (needs the RUT and the Cámara de Comercio). */
  const newParty = async (overrides: Record<string, unknown> = {}) => {
    const out = await runProcess(deps, admin, "core.party.create", { ...exito, documentNumber: String(nextDocument++), ...overrides });
    return out.id as string;
  };

  const storagePath = (recordId: string, fileName: string, entity = PARTY, companyId = h.companyId) =>
    `${h.seed.tenantId}/${companyId}/${entity}/${recordId}/0192a1b2-${fileName}`;

  const fileInput = (recordId: string, tag: string, fileName = `${tag}.pdf`, extra: Record<string, unknown> = {}) => ({
    entity: PARTY,
    recordId,
    tag,
    fileName,
    mimeType: "application/pdf",
    sizeBytes: 184320,
    storagePath: storagePath(recordId, fileName),
    ...extra,
  });

  const add = (caller: Caller, input: Record<string, unknown>) => runProcess(deps, caller, "kernel.attachment.add", input);
  const ready = async (table: "parties" | "products", id: string) =>
    (await sql`select invoice_ready from ${sql(`core.${table}`)} where id = ${id}`)[0]!.invoice_ready as boolean;

  it("adds an attachment to a party, lists it, and requires core.party.update permission", async () => {
    const partyId = await newParty();
    const company = h.seed.companies[0]!;
    // Without the attachment permission the run is refused before the handler.
    await expect(add(cashier, fileInput(partyId, "RUT"))).rejects.toMatchObject({ code: "forbidden" });
    // With it, but without the right to update the owning party, still forbidden.
    await h.grantAll(company.id, company.memberRoleId, ["kernel.attachment.add", "kernel.attachment.remove", "kernel.attachment.list", "core.party.consult"]);
    await expect(add(cashier, fileInput(partyId, "RUT"))).rejects.toMatchObject({ code: "forbidden" });
    expect((await sql`select 1 from kernel.attachments where record_id = ${partyId}`).length).toBe(0);

    const att = await add(admin, fileInput(partyId, "RUT"));
    expect(att).toMatchObject({ id: expect.any(String), entity: PARTY, recordId: partyId, tag: "RUT", fileName: "RUT.pdf", sizeBytes: 184320 });
    const listed = await runProcess(deps, admin, "kernel.attachment.list", { entity: PARTY, recordId: partyId });
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ id: att.id, tag: "RUT", fileName: "RUT.pdf", mimeType: "application/pdf" });
    // The cashier may read the list but not remove: removal also needs core.party.update.
    expect(await runProcess(deps, cashier, "kernel.attachment.list", { entity: PARTY, recordId: partyId })).toHaveLength(1);
    await expect(runProcess(deps, cashier, "kernel.attachment.remove", { id: att.id })).rejects.toMatchObject({ code: "forbidden" });
    // Granting core.party.update is what makes the cashier able to attach.
    await h.grantAll(company.id, company.memberRoleId, ["core.party.update"]);
    await expect(add(cashier, fileInput(partyId, "Otro", "otro.pdf"))).resolves.toMatchObject({ tag: "Otro" });

    const tooBig = await add(admin, fileInput(partyId, "RUT", "grande.pdf", { sizeBytes: 26 * 1024 * 1024 })).catch((e: unknown) => e);
    expect(tooBig).toMatchObject({ code: "invalid_input" });
    expect(MAX_ATTACHMENT_BYTES).toBe(25 * 1024 * 1024);
    // Exactly 25 MB is accepted.
    await expect(add(admin, fileInput(partyId, "Otro", "justo.pdf", { sizeBytes: MAX_ATTACHMENT_BYTES }))).resolves.toMatchObject({ sizeBytes: MAX_ATTACHMENT_BYTES });
  });

  it("remove is a soft delete that keeps the row and writes audit", async () => {
    const partyId = await newParty();
    const att = await add(admin, fileInput(partyId, "RUT"));
    await runProcess(deps, admin, "kernel.attachment.remove", { id: att.id });
    const [row] = await sql`select removed_at, removed_by, storage_path from kernel.attachments where id = ${att.id}`;
    expect(row!.removed_at).not.toBeNull();
    expect(row!.removed_by).toBe(h.seed.users.both);
    expect(row!.storage_path).toBe(att.storagePath);
    // The process-level entry and the row-level diff are both on the process, in the same chain.
    const audit = await sql`select action, entity, chain_id from kernel.audit_log where process_id = 'kernel.attachment.remove' and row_id = ${att.id} order by occurred_at`;
    expect(audit.map((a) => [a.entity, a.action])).toEqual(expect.arrayContaining([["kernel.attachment", "delete"], ["kernel.attachments", "update"]]));
    expect(new Set(audit.map((a) => a.chain_id)).size).toBe(1);
    // Removed files are not listed, and cannot be removed twice.
    expect(await runProcess(deps, admin, "kernel.attachment.list", { entity: PARTY, recordId: partyId })).toHaveLength(0);
    await expect(runProcess(deps, admin, "kernel.attachment.remove", { id: att.id })).rejects.toMatchObject({ code: "not_found" });
  });

  it("another company cannot list the attachment (RLS)", async () => {
    const partyId = await newParty();
    await add(admin, fileInput(partyId, "RUT"));
    await withClaims(sql, otherCompanyAdmin.claims, async (tx) => {
      expect((await tx`select 1 from kernel.attachments where record_id = ${partyId}`).length).toBe(0);
      expect((await tx`select 1 from kernel.v_attachment_counts where record_id = ${partyId}`).length).toBe(0);
    });
    await expect(runProcess(deps, otherCompanyAdmin, "kernel.attachment.list", { entity: PARTY, recordId: partyId })).rejects.toMatchObject({ code: "not_found" });
    await expect(add(otherCompanyAdmin, fileInput(partyId, "RUT"))).rejects.toMatchObject({ code: "not_found" });
  });

  it("upload without tag is rejected", async () => {
    const partyId = await newParty();
    for (const tag of ["", "   "]) {
      await expect(add(admin, fileInput(partyId, tag, "sin-etiqueta.pdf"))).rejects.toMatchObject({ code: "invalid_input" });
    }
    const { tag: _tag, ...withoutTag } = fileInput(partyId, "x", "sin-etiqueta.pdf");
    void _tag;
    await expect(add(admin, withoutTag)).rejects.toMatchObject({ code: "invalid_input" });
    expect((await sql`select 1 from kernel.attachments where record_id = ${partyId}`).length).toBe(0);
  });

  it("a Colombian juridical party without a Cámara de Comercio pdf has invoice_ready false and missingAttachments returns ['Cámara de Comercio']", async () => {
    const partyId = await newParty();
    const record = { id: partyId, companyId: h.companyId, countryCode: "CO", personType: "1", kind: ["customer"] };
    expect(await missingAttachments(sql, PARTY, record)).toEqual(["Cámara de Comercio", "RUT"]);
    expect(await ready("parties", partyId)).toBe(false);

    await add(admin, fileInput(partyId, "RUT"));
    expect(await missingAttachments(sql, PARTY, record)).toEqual(["Cámara de Comercio"]);
    expect(await ready("parties", partyId)).toBe(false);

    await add(admin, fileInput(partyId, "Cámara de Comercio", "camara.pdf"));
    expect(await missingAttachments(sql, PARTY, record)).toEqual([]);
    expect(await ready("parties", partyId)).toBe(true);

    // A natural person only needs the RUT; a foreign party needs neither.
    const natural = await newParty({ personType: "2", documentType: "13", documentNumber: String(nextDocument++), legalName: undefined, firstName: "Ana", firstSurname: "Gómez", taxResponsibilities: ["R-99-PN"], taxScheme: "ZZ" });
    expect(await missingAttachments(sql, PARTY, { ...record, id: natural, personType: "2" })).toEqual(["RUT"]);
    await add(admin, fileInput(natural, "RUT"));
    expect(await ready("parties", natural)).toBe(true);
  });

  it("removing the RUT flips invoice_ready to false in the same transaction", async () => {
    const partyId = await newParty({ personType: "1" });
    await add(admin, fileInput(partyId, "RUT"));
    const camara = await add(admin, fileInput(partyId, "Cámara de Comercio", "camara.pdf"));
    expect(await ready("parties", partyId)).toBe(true);
    const [rut] = await sql<{ id: string }[]>`select id from kernel.attachments where record_id = ${partyId} and tag = 'RUT'`;

    // The trigger runs inside the removing transaction: with the pipeline's audit context (what runProcess sets)
    // the party is already not ready before the transaction commits, and a rollback restores it.
    await withClaims(sql, admin.claims, async (tx) => {
      await tx`select set_config('erp.audit_process_id', 'kernel.attachment.remove', true)`;
      await tx`update kernel.attachments set removed_at = now(), removed_by = kernel.current_user_id() where id = ${rut!.id}`;
      const [inside] = await tx`select invoice_ready from core.parties where id = ${partyId}`;
      expect(inside!.invoice_ready).toBe(false);
      throw new Error("rollback");
    }).catch((e: Error) => expect(e.message).toBe("rollback"));
    expect(await ready("parties", partyId)).toBe(true);

    await runProcess(deps, admin, "kernel.attachment.remove", { id: rut!.id });
    expect(await ready("parties", partyId)).toBe(false);
    // The party row records the change under the removing process, in the same chain as the removal.
    const flips = await sql`select process_id, chain_id from kernel.audit_log where entity = 'core.parties' and row_id = ${partyId} and diff ? 'invoice_ready' and process_id = 'kernel.attachment.remove'`;
    expect(flips).toHaveLength(1);
    // Uploading a RUT again makes it ready; removing the Cámara breaks it again.
    await add(admin, fileInput(partyId, "RUT", "rut-nuevo.pdf"));
    expect(await ready("parties", partyId)).toBe(true);
    await runProcess(deps, admin, "kernel.attachment.remove", { id: camara.id });
    expect(await ready("parties", partyId)).toBe(false);
  });

  it("a file only satisfies a requirement when its tag matches (any case) and its type fits the required kind", async () => {
    const partyId = await newParty();
    // The tag is stored with the defined spelling.
    const rut = await add(admin, fileInput(partyId, "  rut ", "rut-minusculas.pdf"));
    expect(rut.tag).toBe("RUT");
    // A free-form tag is allowed and does not count for anything.
    await expect(add(admin, fileInput(partyId, "Foto del local", "local.png", { mimeType: "image/png" }))).resolves.toMatchObject({ tag: "Foto del local" });
    expect(await missingAttachments(sql, PARTY, { id: partyId, companyId: h.companyId, countryCode: "CO", personType: "1", kind: ["customer"] })).toEqual(["Cámara de Comercio"]);
  });

  it("a duplicate file name on the same record is rejected, never overwritten", async () => {
    const partyId = await newParty();
    const first = await add(admin, fileInput(partyId, "RUT", "documento.pdf"));
    const error = await add(admin, fileInput(partyId, "Otro", "Documento.PDF", { storagePath: storagePath(partyId, "otro-documento.pdf") })).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "invalid_input" });
    expect((error as { details: string[] }).details.join(" ")).toContain("Documento.PDF");
    expect((await sql`select 1 from kernel.attachments where record_id = ${partyId}`).length).toBe(1);
    // The same name on another record is fine, and the name is free again once the file is removed.
    const other = await newParty();
    await expect(add(admin, fileInput(other, "RUT", "documento.pdf"))).resolves.toBeDefined();
    await runProcess(deps, admin, "kernel.attachment.remove", { id: first.id });
    await expect(add(admin, fileInput(partyId, "RUT", "documento.pdf", { storagePath: storagePath(partyId, "documento-2.pdf") }))).resolves.toBeDefined();
    // The same storage path twice is also refused (the unique index, not an overwrite).
    await expect(add(admin, fileInput(partyId, "Otro", "distinto.pdf", { storagePath: storagePath(partyId, "documento-2.pdf") }))).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("a pdf tag with image/png is rejected; an image tag needs an image", async () => {
    const partyId = await newParty();
    await expect(add(admin, fileInput(partyId, "RUT", "rut.png", { mimeType: "image/png" }))).rejects.toMatchObject({ code: "invalid_input" });
    await expect(add(admin, fileInput(partyId, "RUT", "rut.pdf", { mimeType: "application/octet-stream" }))).rejects.toMatchObject({ code: "invalid_input" });
    await sql`insert into kernel.required_attachments(company_id, entity, tag, kind, required, condition, description)
              values (${h.companyId}, ${PARTY}, 'Fachada', 'image', false, null, 'Foto de la fachada')`;
    await expect(add(admin, fileInput(partyId, "Fachada", "fachada.pdf"))).rejects.toMatchObject({ code: "invalid_input" });
    await expect(add(admin, fileInput(partyId, "Fachada", "fachada.jpg", { mimeType: "image/jpeg" }))).resolves.toMatchObject({ tag: "Fachada" });
    expect((await sql`select 1 from kernel.attachments where record_id = ${partyId}`).length).toBe(1);
    await sql`delete from kernel.required_attachments where company_id = ${h.companyId} and tag = 'Fachada'`;
  });

  it("refuses unknown entities, other records' storage paths, invalid names and records the caller cannot see", async () => {
    const partyId = await newParty();
    const other = await newParty();
    await expect(add(admin, fileInput(partyId, "RUT", "x.pdf", { entity: "core.nope" }))).rejects.toMatchObject({ code: "invalid_input" });
    // A path in another record's, company's or tenant's folder, or one that climbs out of its own, is refused.
    for (const path of [
      storagePath(other, "x.pdf"),
      storagePath(partyId, "x.pdf", PARTY, h.seed.companies[1]!.id),
      storagePath(partyId, "x.pdf", PRODUCT),
      `${storagePath(partyId, "x.pdf").replace("0192a1b2-x.pdf", "")}../../../${other}/x.pdf`,
      "x",
    ]) {
      await expect(add(admin, fileInput(partyId, "Otro", "x.pdf", { storagePath: path }))).rejects.toMatchObject({ code: "invalid_input" });
    }
    await expect(add(admin, fileInput(partyId, "Otro", "dir/x.pdf"))).rejects.toMatchObject({ code: "invalid_input" });
    await expect(add(admin, fileInput("00000000-0000-7000-8000-000000000000", "RUT"))).rejects.toMatchObject({ code: "not_found" });
    await expect(runProcess(deps, admin, "kernel.attachment.list", { entity: "core.nope", recordId: partyId })).rejects.toMatchObject({ code: "invalid_input" });
    // The party scope that bounds reads of the party bounds its files too.
    const company = h.seed.companies[0]!;
    await sql`update kernel.roles set party_scope = 'proveedores' where id = ${company.memberRoleId}`;
    await h.grantAll(company.id, company.memberRoleId, ["kernel.attachment.list"]);
    await expect(runProcess(deps, cashier, "kernel.attachment.list", { entity: PARTY, recordId: partyId })).rejects.toMatchObject({ code: "not_found" });
    await sql`update kernel.roles set party_scope = 'ninguno' where id = ${company.memberRoleId}`;
  });

  it("v_attachment_counts counts the live files per record", async () => {
    const partyId = await newParty();
    const a = await add(admin, fileInput(partyId, "RUT"));
    await add(admin, fileInput(partyId, "Otro", "otro.pdf"));
    const counts = () => withClaims(sql, admin.claims, (tx) => tx<{ count: number }[]>`select count::int as count from kernel.v_attachment_counts where entity = ${PARTY} and record_id = ${partyId}`);
    expect(await counts()).toEqual([{ count: 2 }]);
    await runProcess(deps, admin, "kernel.attachment.remove", { id: a.id });
    expect(await counts()).toEqual([{ count: 1 }]);
  });

  it("required files are admin-defined: only the admin writes them, and a new requirement re-evaluates existing records", async () => {
    const productInput = { sku: "ATT-1", description: "Café", kind: "good", idScheme: "010", standardCode: "7702001005000", uomCode: "94", ivaRate: "5", otherTaxes: [], listPrice: 28500, isFreeSample: false, trackStock: true };
    const product = (await runProcess(deps, admin, "core.product.create", productInput)).id as string;
    // "Ficha técnica" is optional by default: a missing optional file never blocks.
    expect(await ready("products", product)).toBe(true);

    await expect(withClaims(sql, cashier.claims, (tx) => tx`update kernel.required_attachments set required = true where entity = ${PRODUCT}`)).resolves.toBeDefined();
    expect((await sql`select required from kernel.required_attachments where company_id = ${h.companyId} and entity = ${PRODUCT}`)[0]!.required).toBe(false);
    await expect(
      withClaims(sql, cashier.claims, (tx) => tx`insert into kernel.required_attachments(company_id, entity, tag, kind, required) values (${h.companyId}, ${PRODUCT}, 'Otra', 'any', true)`),
    ).rejects.toThrow();

    // The admin writes them only inside kernel.required_file.* (0021); a bare statement changes nothing.
    const asAdminProcess = (statement: (tx: Parameters<Parameters<typeof withClaims>[2]>[0]) => Promise<unknown>) =>
      withClaims(sql, admin.claims, async (tx) => {
        await tx`select set_config('erp.audit_process_id', 'kernel.required_file.set', true)`;
        return statement(tx);
      });
    expect(await withClaims(sql, admin.claims, (tx) => tx`update kernel.required_attachments set required = true where company_id = ${h.companyId} and entity = ${PRODUCT} returning id`)).toHaveLength(0);
    // The admin makes the data sheet mandatory: the existing product is no longer ready until it has one.
    await asAdminProcess((tx) => tx`update kernel.required_attachments set required = true where company_id = ${h.companyId} and entity = ${PRODUCT} and tag = 'Ficha técnica'`);
    expect(await ready("products", product)).toBe(false);
    expect(await missingAttachments(sql, PRODUCT, { id: product, companyId: h.companyId })).toEqual(["Ficha técnica"]);
    await add(admin, { entity: PRODUCT, recordId: product, tag: "Ficha técnica", fileName: "ficha.pdf", mimeType: "application/pdf", sizeBytes: 2048, storagePath: storagePath(product, "ficha.pdf", PRODUCT) });
    expect(await ready("products", product)).toBe(true);
    // Dropping the requirement frees every record that was waiting on it.
    await asAdminProcess((tx) => tx`update kernel.required_attachments set required = false where company_id = ${h.companyId} and entity = ${PRODUCT}`);
    const [other] = [(await runProcess(deps, admin, "core.product.create", { ...productInput, sku: "ATT-2", standardCode: "7702001005017" })).id as string];
    expect(await ready("products", other)).toBe(true);
  });

  it("the defaults are seeded per company by kernel.seed_required_attachments, idempotently", async () => {
    const rows = await sql`select entity, tag, kind, required, condition from kernel.required_attachments where company_id = ${h.companyId} and tag in ('RUT', 'Cámara de Comercio', 'Certificación bancaria', 'Ficha técnica') order by entity, tag`;
    expect(rows.map((r) => [r.entity, r.tag, r.kind, r.required, r.condition])).toEqual([
      [PARTY, "Cámara de Comercio", "pdf", true, "co-juridica"],
      [PARTY, "Certificación bancaria", "pdf", false, "proveedor"],
      [PARTY, "RUT", "pdf", true, "co"],
      [PRODUCT, "Ficha técnica", "pdf", false, null],
    ]);
    await sql`select kernel.seed_required_attachments(${h.companyId})`;
    expect((await sql`select 1 from kernel.required_attachments where company_id = ${h.companyId}`).length).toBe(4);
  });

  it("the bucket is private and closed to users", async () => {
    const [bucket] = await sql`select public, file_size_limit from storage.buckets where id = 'attachments'`;
    expect(bucket).toMatchObject({ public: false, file_size_limit: String(MAX_ATTACHMENT_BYTES) });
    await withClaims(sql, admin.claims, async (tx) => {
      expect((await tx`select 1 from storage.objects where bucket_id = 'attachments'`).length).toBe(0);
    });
    const insert = await withClaims(sql, admin.claims, (tx) => tx`insert into storage.objects(bucket_id, name) values ('attachments', 'x')`).catch((e: unknown) => e);
    expect(insert).toMatchObject({ code: "42501" });
  });

  it("kernel processes are always entitled; a module's processes still need their entitlement", async () => {
    // A tenant that bought nothing: no module:kernel and no module:core.
    const bare = await seedTenant(sql, { companies: 1, entitlements: [] });
    const company = bare.companies[0]!;
    const caller: Caller = { claims: bare.claimsFor(bare.users.both, company.id), origin: "ui" };
    try {
      await h.grantAll(company.id, company.adminRoleId, ["kernel.attachment.list", "core.party.consult"]);
      const [party] = await sql<{ id: string }[]>`
        insert into core.parties (company_id, kind, person_type, document_type, document_number, legal_name, dian_status)
        values (${company.id}, '{customer}', '1', '31', '900111222', 'Sin plan S.A.S.', 'complete') returning id`;
      await expect(runProcess(deps, caller, "kernel.attachment.list", { entity: PARTY, recordId: party!.id })).resolves.toEqual([]);
      await expect(runProcess(deps, caller, "core.party.consult", { id: party!.id })).rejects.toMatchObject({ code: "not_entitled" });
    } finally {
      await sql`delete from core.parties where company_id = ${company.id}`;
      await sql`delete from core.entity_sequences where company_id = ${company.id}`;
      await sql`delete from kernel.process_permissions where company_id = ${company.id}`;
      await sql`delete from kernel.outbox where company_id = ${company.id}`;
      await bare.cleanup();
    }
  });

  it("writes outside the process pipeline are refused, even for an admin of the company", async () => {
    const partyId = await newParty();
    const att = await add(admin, fileInput(partyId, "RUT"));
    for (const caller of [admin, cashier]) {
      const direct = await withClaims(
        sql,
        caller.claims,
        (tx) => tx`insert into kernel.attachments(company_id, entity, record_id, tag, file_name, mime_type, size_bytes, storage_path)
                   values (${h.companyId}, ${PARTY}, ${partyId}, 'RUT', 'directo.pdf', 'application/pdf', 10, ${storagePath(partyId, "directo.pdf")})`,
      ).catch((e: unknown) => e);
      expect(direct).toMatchObject({ code: "42501" });
      // Another process' name does not open the gate either.
      const other = await withClaims(sql, caller.claims, async (tx) => {
        await tx`select set_config('erp.audit_process_id', 'core.party.update', true)`;
        return tx`update kernel.attachments set removed_at = now() where id = ${att.id}`;
      });
      expect(other.count).toBe(0);
    }
    const direct = await withClaims(sql, admin.claims, (tx) => tx`update kernel.attachments set removed_at = now(), removed_by = kernel.current_user_id() where id = ${att.id}`);
    expect(direct.count).toBe(0);
    expect((await sql`select 1 from kernel.attachments where id = ${att.id} and removed_at is null`).length).toBe(1);
    expect((await sql`select 1 from kernel.attachments where record_id = ${partyId}`).length).toBe(1);
    // Removal is permanent and nothing else about a stored file can change, whoever asks.
    await runProcess(deps, admin, "kernel.attachment.remove", { id: att.id });
    await expect(sql`update kernel.attachments set removed_at = null where id = ${att.id}`).rejects.toMatchObject({ code: "23514" });
    await expect(sql`update kernel.attachments set tag = 'Otro' where id = ${att.id}`).rejects.toMatchObject({ code: "23514" });
  });

  it("standard audit columns: created_* is the upload, updated_* the removal; a tag is unique per entity whatever its case", async () => {
    const partyId = await newParty();
    const att = await add(admin, fileInput(partyId, "RUT"));
    const [before] = await sql`select created_by, created_at, updated_at, removed_by from kernel.attachments where id = ${att.id}`;
    expect(before!.created_by).toBe(h.seed.users.both);
    expect(att.uploadedBy).toBe(h.seed.users.both);
    await runProcess(deps, admin, "kernel.attachment.remove", { id: att.id });
    const [after] = await sql`select updated_by, updated_at, created_at from kernel.attachments where id = ${att.id}`;
    expect(after!.updated_by).toBe(h.seed.users.both);
    expect(after!.updated_at.getTime()).toBeGreaterThanOrEqual(before!.updated_at.getTime());
    expect(after!.created_at).toEqual(before!.created_at);
    await expect(
      sql`insert into kernel.required_attachments(company_id, entity, tag, kind) values (${h.companyId}, ${PARTY}, ' rut ', 'any')`,
    ).rejects.toMatchObject({ code: "23505" });
    const [req] = await sql`select created_by, created_at, updated_at from kernel.required_attachments where company_id = ${h.companyId} and tag = 'RUT'`;
    expect(req!.created_at).toBeInstanceOf(Date);
    await sql`update kernel.required_attachments set description = 'x' where company_id = ${h.companyId} and tag = 'RUT'`;
    const [touched] = await sql`select updated_at from kernel.required_attachments where company_id = ${h.companyId} and tag = 'RUT'`;
    expect(touched!.updated_at.getTime()).toBeGreaterThan(req!.updated_at.getTime());
  });

  it("precheckAttachment refuses before any bytes are stored, and says which kind the tag requires", async () => {
    const partyId = await newParty();
    const target = { entity: PARTY, recordId: partyId, tag: "rut", fileName: "rut.pdf", mimeType: "application/pdf", sizeBytes: 1024 };
    await expect(precheckAttachment(deps, admin, target)).resolves.toEqual({ tag: "RUT", kind: "pdf" });
    await expect(precheckAttachment(deps, admin, { ...target, tag: "Libre" })).resolves.toEqual({ tag: "Libre", kind: null });
    await expect(precheckAttachment(deps, admin, { ...target, entity: "core.nope" })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(precheckAttachment(deps, admin, { ...target, recordId: "not-a-uuid" })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(precheckAttachment(deps, admin, { ...target, tag: " " })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(precheckAttachment(deps, admin, { ...target, sizeBytes: MAX_ATTACHMENT_BYTES + 1 })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(precheckAttachment(deps, admin, { ...target, fileName: "../rut.pdf" })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(precheckAttachment(deps, admin, { ...target, recordId: "00000000-0000-7000-8000-000000000000" })).rejects.toMatchObject({ code: "not_found" });
    await expect(precheckAttachment(deps, otherCompanyAdmin, target)).rejects.toMatchObject({ code: "not_found" });
    const company = h.seed.companies[0]!;
    await sql`delete from kernel.process_permissions where company_id = ${company.id} and role_id = ${company.memberRoleId} and process_id = 'core.party.update'`;
    await expect(precheckAttachment(deps, cashier, target)).rejects.toMatchObject({ code: "forbidden" });
    await add(admin, fileInput(partyId, "RUT", "rut.pdf"));
    await expect(precheckAttachment(deps, admin, target)).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("an entity whose module has no attachments_changed hook cannot take files (no silent skip)", async () => {
    await sql`create schema if not exists fake`;
    await sql`create table fake.things (id uuid primary key default kernel.uuid_v7(), company_id uuid not null)`;
    await sql`alter table fake.things enable row level security`;
    await sql`create policy company_isolation on fake.things for all to authenticated using (company_id = (select kernel.current_company_id()))`;
    await sql`create view fake.v_things with (security_invoker = true) as select id, company_id from fake.things`;
    await sql`grant usage on schema fake to authenticated`;
    await sql`grant select on fake.things, fake.v_things to authenticated`;
    try {
      deps.registry.registerEntity(
        defineEntity({ entityType: "maestro", id: "fake.thing", module: "fake", schema: "fake", table: "things", label: "entity.fake.thing", displayField: "company_id", defaultSort: { field: "company_id", dir: "asc" }, fields: [{ name: "company_id", type: "uuid", label: "field.company" }] }),
      );
      await h.grantAll(h.companyId, h.seed.companies[0]!.adminRoleId, ["fake.thing.update"]);
      const [thing] = await sql<{ id: string }[]>`insert into fake.things(company_id) values (${h.companyId}) returning id`;
      const error = await add(admin, {
        entity: "fake.thing",
        recordId: thing!.id,
        tag: "Doc",
        fileName: "doc.pdf",
        mimeType: "application/pdf",
        sizeBytes: 10,
        storagePath: storagePath(thing!.id, "doc.pdf", "fake.thing"),
      }).catch((e: unknown) => e);
      expect(error).toMatchObject({ code: "handler_failed" });
      expect(String((error as { cause?: Error }).cause?.message)).toContain("module fake has no attachments_changed hook");
      expect((await sql`select 1 from kernel.attachments where record_id = ${thing!.id}`).length).toBe(0);
      // A requirement for such an entity is refused too.
      await expect(sql`insert into kernel.required_attachments(company_id, entity, tag, kind) values (${h.companyId}, 'fake.thing', 'Doc', 'any')`).rejects.toThrow(
        "module fake has no attachments_changed hook",
      );
    } finally {
      await sql`drop view fake.v_things`;
      await sql`drop table fake.things`;
      await sql`drop schema fake`;
    }
  });
});
