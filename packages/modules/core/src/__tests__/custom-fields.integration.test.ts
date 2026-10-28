import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { runProcess, type Caller } from "@erp/kernel";
import { withClaims } from "@erp/kernel/testing";
import { attachFile, coreHarness, exito, type CoreHarness } from "./helpers";

// Custom fields (Datos adicionales, design §5.14): definitions, validation inside the core create / update
// processes, masking by roles_view in consults, and the readiness of records that exist when a required
// field is defined. The suite lives in core because the entities and their dian_missing are core's.

const cafe = {
  sku: "CF-500",
  description: "Café tostado molido 500 g",
  kind: "good",
  idScheme: "010",
  standardCode: "7702001005000",
  uomCode: "94",
  ivaRate: "5",
  otherTaxes: [],
  listPrice: 28500,
  isFreeSample: false,
  trackStock: true,
};

describe("custom fields", () => {
  let h: CoreHarness;
  let sql: CoreHarness["sql"];
  let deps: CoreHarness["deps"];
  let admin: Caller;
  let seller: Caller;
  let otherCompanyAdmin: Caller;
  let adminRole: string;
  let memberRole: string;
  let nextDocument = 920000100;
  let nextSku = 1;

  beforeAll(async () => {
    h = await coreHarness({ companies: 2, users: [{ name: "seller", companies: [0], role: "member" }] });
    ({ sql, deps, admin } = h);
    seller = { claims: h.seed.claimsFor(h.seed.users.seller!, h.companyId), origin: "ui" };
    otherCompanyAdmin = { claims: h.seed.claimsFor(h.seed.users.both, h.seed.companies[1]!.id), origin: "ui" };
    adminRole = h.seed.companies[0]!.adminRoleId;
    memberRole = h.seed.companies[0]!.memberRoleId;
    await h.grantAll(h.companyId, memberRole, [
      "kernel.custom_field.set",
      "kernel.custom_field.list",
      "core.party.create",
      "core.party.update",
      "core.party.consult",
      "core.product.consult",
      "core.contact.list",
    ]);
  });
  afterAll(async () => {
    await h.cleanup();
  });
  // Definitions are per company and every party of the company feels them: each test starts clean.
  afterEach(async () => {
    await sql`delete from kernel.custom_fields where company_id = ${h.companyId}`;
  });

  /** The caller with a fresh step-up verification (rule 15): the admin processes consume one per run. */
  const stepUp = async (caller: Caller): Promise<Caller> => {
    const stepUpToken = randomUUID();
    await sql`insert into kernel.step_up_verifications(user_id, company_id, token)
              values (${caller.claims.sub}, ${caller.claims.active_company_id}, ${stepUpToken})`;
    return { ...caller, stepUpToken };
  };
  const remove = async (caller: Caller, entity: string, key: string) =>
    runProcess(deps, await stepUp(caller), "kernel.custom_field.remove", { entity, key });
  const define = async (caller: Caller, over: Record<string, unknown> = {}) =>
    runProcess(deps, await stepUp(caller), "kernel.custom_field.set", {
      entity: "core.party",
      key: "canal",
      label: "Canal comercial",
      type: "list",
      options: ["Retail", "HORECA", "Distribuidor"],
      rolesEnter: [adminRole, memberRole],
      rolesEdit: [adminRole, memberRole],
      rolesView: [adminRole, memberRole],
      ...over,
    });
  const newParty = async (overrides: Record<string, unknown> = {}, caller: Caller = admin) =>
    (await runProcess(deps, caller, "core.party.create", { ...exito, documentNumber: String(nextDocument++), ...overrides })).id as string;
  const newProduct = async (overrides: Record<string, unknown> = {}) =>
    (await runProcess(deps, admin, "core.product.create", { ...cafe, sku: `CF-${nextSku++}`, ...overrides })).id as string;
  const party = async (id: string) => (await sql`select dian_status, dian_missing, invoice_ready, extra, extra_free from core.parties where id = ${id}`)[0]!;
  const product = async (id: string) => (await sql`select dian_status, dian_missing, invoice_ready, extra from core.products where id = ${id}`)[0]!;
  const details = (error: unknown) => ((error as { details?: string[] }).details ?? []).join(" | ");
  /** Attaches the RUT and the Cámara de Comercio so the party's only pending data is the custom one. */
  const withFiles = async (partyId: string) => {
    for (const tag of ["RUT", "Cámara de Comercio"]) {
      await attachFile(sql, { tenantId: h.seed.tenantId, companyId: h.companyId, entity: "core.party", recordId: partyId, tag });
    }
  };

  it("only the company admin defines fields; every member lists them with what their own roles can do", async () => {
    await expect(define(seller)).rejects.toMatchObject({ code: "forbidden" });
    const created = await define(admin, { rolesEnter: [adminRole], rolesEdit: [adminRole] });
    // Defining the same key again changes the definition instead of duplicating it.
    expect(await define(admin, { label: "Canal", rolesEnter: [adminRole], rolesEdit: [adminRole] })).toEqual(created);

    const forSeller = await runProcess(deps, seller, "kernel.custom_field.list", { entity: "core.party" });
    expect(forSeller).toHaveLength(1);
    expect(forSeller[0]).toMatchObject({ key: "canal", label: "Canal", type: "list", options: ["Retail", "HORECA", "Distribuidor"], canEnter: false, canEdit: false, canView: true, rolesView: null });
    const forAdmin = await runProcess(deps, admin, "kernel.custom_field.list", { entity: "core.party" });
    expect(forAdmin[0]).toMatchObject({ canEnter: true, canEdit: true, rolesEnter: [adminRole], rolesView: [adminRole, memberRole] });

    await expect(remove(seller, "core.party", "canal")).rejects.toMatchObject({ code: "forbidden" });
    await remove(admin, "core.party", "canal");
    expect(await runProcess(deps, admin, "kernel.custom_field.list", { entity: "core.party" })).toEqual([]);
    await expect(remove(admin, "core.party", "canal")).rejects.toMatchObject({ code: "not_found" });
    const audit = await sql`select 1 from kernel.audit_log where process_id = 'kernel.custom_field.set' and row_id = ${created.id}`;
    expect(audit.length).toBeGreaterThan(0);
  });

  it("refuses a bad definition: foreign role, list without options, options on a text, unknown entity, wrong key", async () => {
    const foreign = h.seed.companies[1]!.adminRoleId;
    await expect(define(admin, { rolesView: [foreign] })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(define(admin, { options: undefined })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(define(admin, { type: "text" })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(define(admin, { entity: "core.nada" })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(define(admin, { key: "Canal Comercial" })).rejects.toMatchObject({ code: "invalid_input" });
    expect(await runProcess(deps, admin, "kernel.custom_field.list", { entity: "core.party" })).toEqual([]);
  });

  it("definitions are written only through the process and are private to the company", async () => {
    await define(admin);
    // Even the admin cannot write the table outside a process (rule 1) …
    await expect(
      withClaims(sql, admin.claims, (tx) => tx`insert into kernel.custom_fields(company_id, entity, key, label, type) values (${h.companyId}, 'core.party', 'directo', 'Directo', 'text')`),
    ).rejects.toThrow(/row-level security/);
    // … a definition cannot name a role of another company even when written by the service role …
    const foreign = h.seed.companies[1]!.adminRoleId;
    await expect(
      sql`insert into kernel.custom_fields(company_id, entity, key, label, type, roles_view) values (${h.companyId}, 'core.party', 'ajeno', 'Ajeno', 'text', ${[foreign]}::uuid[])`,
    ).rejects.toThrow(/not a role of its company/);
    // … and another company sees none of them.
    expect(await runProcess(deps, otherCompanyAdmin, "kernel.custom_field.list", { entity: "core.party" })).toEqual([]);
  });

  it("a module that stores extra data must say how a definition affects its records", async () => {
    await expect(
      sql`insert into kernel.custom_fields(company_id, entity, key, label, type) values (${h.companyId}, 'ghost.thing', 'k', 'K', 'text')`,
    ).rejects.toThrow(/module ghost has no custom_field_changed hook/);
  });

  it("create and update refuse a value outside the list, an undefined key and a value the caller's role may not enter", async () => {
    await define(admin, { key: "origen", label: "Origen del café", type: "text", options: undefined, rolesEnter: [adminRole], rolesEdit: [adminRole] });
    await define(admin);

    const outside = await runProcess(deps, admin, "core.party.create", { ...exito, documentNumber: String(nextDocument++), extra: { canal: "Mayorista" } }).catch((e: unknown) => e);
    expect(outside).toMatchObject({ code: "invalid_input" });
    expect(details(outside)).toContain("Canal comercial: Elige un valor de la lista");
    await expect(newParty({ extra: { fantasma: "x" } })).rejects.toMatchObject({ code: "invalid_input" });

    const partyId = await newParty({ extra: { canal: "Retail" } });
    // The seller may change the channel but not enter the origin.
    await runProcess(deps, seller, "core.party.update", { id: partyId, extra: { canal: "HORECA" } });
    const denied = await runProcess(deps, seller, "core.party.update", { id: partyId, extra: { canal: "HORECA", origen: "Huila" } }).catch((e: unknown) => e);
    expect(denied).toMatchObject({ code: "invalid_input" });
    expect(details(denied)).toContain("Origen del café: tu rol no puede modificar este dato");
    expect((await party(partyId)).extra).toEqual({ canal: "HORECA" });

    // The admin may enter it; from then on the seller cannot change it, but can resend it untouched.
    await runProcess(deps, admin, "core.party.update", { id: partyId, extra: { canal: "HORECA", origen: "Huila" } });
    await expect(runProcess(deps, seller, "core.party.update", { id: partyId, extra: { canal: "HORECA", origen: "Nariño" } })).rejects.toMatchObject({ code: "invalid_input" });
    await runProcess(deps, seller, "core.party.update", { id: partyId, extra: { canal: "Retail", origen: "Huila" } });
    expect((await party(partyId)).extra).toEqual({ canal: "Retail", origen: "Huila" });
  });

  it("a role not in roles_view does not receive the key from a consult, and cannot erase it by saving", async () => {
    await define(admin);
    await define(admin, { key: "dia_pago", label: "Día de pago habitual", type: "number", options: undefined, rolesView: [adminRole], rolesEnter: [adminRole], rolesEdit: [adminRole] });
    const partyId = await newParty({ extra: { canal: "Retail", dia_pago: "15" }, extraFree: [{ name: "Nota", value: "Paga los viernes" }] });

    const asAdmin = await runProcess(deps, admin, "core.party.consult", { id: partyId });
    expect(asAdmin.extra).toEqual({ canal: "Retail", dia_pago: "15" });
    const asSeller = await runProcess(deps, seller, "core.party.consult", { id: partyId });
    expect(asSeller.extra).toEqual({ canal: "Retail" });
    expect(asSeller.extra_free).toEqual([{ name: "Nota", value: "Paga los viernes" }]);

    // The seller's form never held dia_pago; saving the form must not wipe it.
    await runProcess(deps, seller, "core.party.update", { id: partyId, extra: { canal: "HORECA" } });
    expect((await party(partyId)).extra).toEqual({ canal: "HORECA", dia_pago: "15" });
    // Removing the definition hides the orphan value from everybody.
    await remove(admin, "core.party", "dia_pago");
    expect((await runProcess(deps, admin, "core.party.consult", { id: partyId })).extra).toEqual({ canal: "HORECA" });
    expect((await party(partyId)).extra).toMatchObject({ dia_pago: "15" });
  });

  it("defining and removing fields are step-up processes (rule 15): refused without a fresh verification, which is consumed", async () => {
    expect(deps.registry.process("kernel.custom_field.set").sensitivity).toBe("step-up");
    expect(deps.registry.process("kernel.custom_field.remove").sensitivity).toBe("step-up");
    const input = {
      entity: "core.party", key: "canal", label: "Canal", type: "text", rolesEnter: [adminRole], rolesEdit: [adminRole], rolesView: [adminRole],
    };
    await expect(runProcess(deps, admin, "kernel.custom_field.set", input)).rejects.toMatchObject({ code: "step_up_required" });
    await expect(runProcess(deps, admin, "kernel.custom_field.remove", { entity: "core.party", key: "canal" })).rejects.toMatchObject({ code: "step_up_required" });
    expect(await runProcess(deps, admin, "kernel.custom_field.list", { entity: "core.party" })).toEqual([]);
    const verified = await stepUp(admin);
    await runProcess(deps, verified, "kernel.custom_field.set", input);
    // One verification, one run.
    await expect(runProcess(deps, verified, "kernel.custom_field.remove", { entity: "core.party", key: "canal" })).rejects.toMatchObject({ code: "step_up_required" });
  });

  it("a role not in roles_view does not receive the key from the masked views (grids, exports and the assistant read them)", async () => {
    await define(admin, { key: "sitio", label: "Sitio web", type: "url", options: undefined });
    await define(admin, { key: "dia_pago", label: "Día de pago habitual", type: "number", options: undefined, rolesView: [adminRole], rolesEnter: [adminRole], rolesEdit: [adminRole] });
    await define(admin, { entity: "core.product", key: "costo_origen", label: "Costo en origen", type: "number", options: undefined, rolesView: [adminRole], rolesEnter: [adminRole], rolesEdit: [adminRole] });
    await define(admin, { entity: "core.party_contact", key: "cumple", label: "Cumpleaños", type: "date", options: undefined, rolesView: [adminRole], rolesEnter: [adminRole], rolesEdit: [adminRole] });
    await define(admin, { entity: "core.product_category", key: "linea", label: "Línea", type: "text", options: undefined, rolesView: [adminRole], rolesEnter: [adminRole], rolesEdit: [adminRole] });
    const partyId = await newParty({ extra: { sitio: "https://a.co", dia_pago: "15" } });
    const productId = await newProduct({ extra: { costo_origen: "9000" } });
    const categoryId = (await runProcess(deps, admin, "core.category.create", { name: "Café", ivaRate: "5", extra: { linea: "Premium" } })).id as string;
    const contactId = (await runProcess(deps, admin, "core.contact.create", { partyId, name: "Ana", email: "ana@exito.com", extra: { cumple: "1990-02-14" } })).id as string;
    // A value whose definition was removed is hidden from everybody.
    await sql`update core.parties set extra = extra || '{"huerfano": "x"}'::jsonb where id = ${partyId}`;

    const read = (caller: Caller, view: string, id: string) =>
      withClaims(sql, caller.claims, async (tx) => (await tx`select extra from ${tx(view)} where id = ${id}`)[0]?.extra as Record<string, unknown>);
    // The seller's role is in roles_view of "Sitio web" only.
    expect(await read(seller, "core.v_parties", partyId)).toEqual({ sitio: "https://a.co" });
    expect(await read(admin, "core.v_parties", partyId)).toEqual({ sitio: "https://a.co", dia_pago: "15" });
    expect(await read(seller, "core.v_products", productId)).toEqual({});
    expect(await read(admin, "core.v_products", productId)).toEqual({ costo_origen: "9000" });
    expect(await read(seller, "core.v_product_categories", categoryId)).toEqual({});
    expect(await read(admin, "core.v_product_categories", categoryId)).toEqual({ linea: "Premium" });
    expect(await read(seller, "core.v_party_contacts", contactId)).toEqual({});
    expect(await read(admin, "core.v_party_contacts", contactId)).toEqual({ cumple: "1990-02-14" });
    // Another company's admin does not see this company's rows, and its roles never match these definitions.
    expect(await read(otherCompanyAdmin, "core.v_parties", partyId)).toBeUndefined();
    // The table underneath still holds everything: only the view masks.
    expect((await party(partyId)).extra).toMatchObject({ dia_pago: "15", huerfano: "x" });
  });

  it("extra_free takes name / value texts of at most 200 characters", async () => {
    const partyId = await newParty({ extraFree: [{ name: "a".repeat(200), value: "b".repeat(200) }] });
    expect((await party(partyId)).extra_free).toHaveLength(1);
    await runProcess(deps, seller, "core.party.update", { id: partyId, extraFree: [{ name: "Otro", value: "x" }] });
    expect((await party(partyId)).extra_free).toEqual([{ name: "Otro", value: "x" }]);
    await expect(newParty({ extraFree: [{ name: "a", value: "b".repeat(201) }] })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(newParty({ extraFree: [{ name: "a".repeat(201), value: "b" }] })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(newParty({ extraFree: [{ name: "  ", value: "b" }] })).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("a required field left empty is missing data for dian_status and invoice_ready, filled it is complete", async () => {
    await define(admin, { required: true });
    const partyId = await newParty();
    await withFiles(partyId);
    expect(await party(partyId)).toMatchObject({ dian_status: "missing: 1", dian_missing: ["Dato adicional: Canal comercial"], invoice_ready: false });
    await runProcess(deps, admin, "core.party.update", { id: partyId, extra: { canal: "Retail" } });
    expect(await party(partyId)).toMatchObject({ dian_status: "complete", dian_missing: [], invoice_ready: true });
    // Clearing it again marks the record again; the pack's own pending data is kept next to it.
    const both = await newParty({ kind: ["customer", "supplier"] });
    expect((await party(both)).dian_missing).toEqual(["Correo para enviar documentos al proveedor", "Dato adicional: Canal comercial"]);
    expect((await party(both)).dian_status).toBe("missing: 2");
  });

  it("a required field defined after records exist marks them without failing their next unrelated update", async () => {
    const partyId = await newParty();
    await withFiles(partyId);
    const supplierBoth = await newParty({ kind: ["customer", "supplier"] });
    const productId = await newProduct();
    const gtinless = await newProduct({ standardCode: undefined });
    expect(await party(partyId)).toMatchObject({ dian_status: "complete", invoice_ready: true });
    expect(await product(productId)).toMatchObject({ dian_status: "complete", invoice_ready: true });

    await define(admin, { required: true });
    await define(admin, { entity: "core.product", key: "origen", label: "Origen del café", type: "text", options: undefined, required: true });
    // Same transaction as the definition: the existing rows are re-evaluated.
    expect(await party(partyId)).toMatchObject({ dian_status: "missing: 1", dian_missing: ["Dato adicional: Canal comercial"], invoice_ready: false });
    expect(await product(productId)).toMatchObject({ dian_status: "missing: 1", dian_missing: ["Dato adicional: Origen del café"], invoice_ready: false });
    expect(await product(gtinless)).toMatchObject({ dian_status: "missing: 2", dian_missing: ["Código GTIN", "Dato adicional: Origen del café"] });
    expect((await party(supplierBoth)).dian_missing).toEqual(["Correo para enviar documentos al proveedor", "Dato adicional: Canal comercial"]);

    // The next update that does not touch the field neither fails nor loses the mark.
    await runProcess(deps, admin, "core.party.update", { id: partyId, tradeName: "Éxito" });
    await runProcess(deps, admin, "core.product.update", { id: productId, brand: "Café del Norte" });
    expect(await party(partyId)).toMatchObject({ dian_status: "missing: 1", dian_missing: ["Dato adicional: Canal comercial"], invoice_ready: false });
    expect(await product(productId)).toMatchObject({ dian_status: "missing: 1", dian_missing: ["Dato adicional: Origen del café"] });
    // An update by a role that may not enter the field is no problem either.
    await runProcess(deps, seller, "core.party.update", { id: partyId, tradeName: "Éxito S.A." });

    // Filling it completes the record; relaxing the definition completes the rest; the pack's data is never touched.
    await runProcess(deps, admin, "core.party.update", { id: partyId, extra: { canal: "Retail" } });
    expect(await party(partyId)).toMatchObject({ dian_status: "complete", invoice_ready: true });
    await define(admin, { entity: "core.product", key: "origen", label: "Origen del café", type: "text", options: undefined, required: false });
    expect(await product(productId)).toMatchObject({ dian_status: "complete", dian_missing: [], invoice_ready: true });
    expect(await product(gtinless)).toMatchObject({ dian_status: "missing: 1", dian_missing: ["Código GTIN"] });
    await remove(admin, "core.party", "canal");
    expect(await party(supplierBoth)).toMatchObject({ dian_status: "missing: 1", dian_missing: ["Correo para enviar documentos al proveedor"] });
  });

  it("a required field of another company does not mark this company's records", async () => {
    await runProcess(deps, await stepUp(otherCompanyAdmin), "kernel.custom_field.set", {
      entity: "core.party",
      key: "canal",
      label: "Canal comercial",
      type: "text",
      required: true,
      rolesEnter: [],
      rolesEdit: [],
      rolesView: [],
    });
    try {
      const partyId = await newParty();
      expect((await party(partyId)).dian_missing).toEqual([]);
    } finally {
      await sql`delete from kernel.custom_fields where company_id = ${h.seed.companies[1]!.id}`;
    }
  });

  it("products, categories and contacts validate their extra too, and contacts are listed masked", async () => {
    await define(admin, { entity: "core.product", key: "vida_util", label: "Vida útil (días)", type: "number", options: undefined, maxLength: 4 });
    await define(admin, { entity: "core.product_category", key: "linea", label: "Línea", type: "list", options: ["Café", "Té"] });
    await define(admin, { entity: "core.party_contact", key: "cumple", label: "Cumpleaños", type: "date", options: undefined, rolesView: [adminRole] });

    await expect(newProduct({ extra: { vida_util: "doce" } })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(newProduct({ extra: { vida_util: "12345" } })).rejects.toMatchObject({ code: "invalid_input" });
    const productId = await newProduct({ extra: { vida_util: "365" } });
    expect((await product(productId)).extra).toEqual({ vida_util: "365" });
    await expect(runProcess(deps, admin, "core.product.update", { id: productId, extra: { vida_util: "x" } })).rejects.toMatchObject({ code: "invalid_input" });
    expect((await runProcess(deps, admin, "core.product.consult", { id: productId })).extra).toEqual({ vida_util: "365" });

    await expect(runProcess(deps, admin, "core.category.create", { name: "Bebidas", ivaRate: "19", extra: { linea: "Jugos" } })).rejects.toMatchObject({ code: "invalid_input" });
    const categoryId = (await runProcess(deps, admin, "core.category.create", { name: "Bebidas", ivaRate: "19", extra: { linea: "Té" }, extraFree: [{ name: "Nota", value: "x" }] })).id;
    await expect(runProcess(deps, admin, "core.category.update", { id: categoryId, extra: { linea: "Jugos" } })).rejects.toMatchObject({ code: "invalid_input" });
    expect((await runProcess(deps, admin, "core.category.consult", { id: categoryId })).extra).toEqual({ linea: "Té" });

    const partyId = await newParty();
    await expect(runProcess(deps, admin, "core.contact.create", { partyId, name: "Ana", extra: { cumple: "30/02" } })).rejects.toMatchObject({ code: "invalid_input" });
    const contactId = (await runProcess(deps, admin, "core.contact.create", { partyId, name: "Ana Gómez", email: "ana@exito.com", extra: { cumple: "1990-02-14" }, extraFree: [{ name: "Hijos", value: "2" }] })).id;
    await expect(runProcess(deps, admin, "core.contact.update", { id: contactId, extra: { cumple: "mañana" } })).rejects.toMatchObject({ code: "invalid_input" });
    const asAdmin = await runProcess(deps, admin, "core.contact.list", { partyId });
    expect(asAdmin).toEqual([
      expect.objectContaining({ id: contactId, partyId, name: "Ana Gómez", email: "ana@exito.com", phoneCc: "57", extra: { cumple: "1990-02-14" }, extraFree: [{ name: "Hijos", value: "2" }] }),
    ]);
    // The seller may not view the birthday: the key is not in the list they receive.
    const asSeller = await runProcess(deps, seller, "core.contact.list", { partyId });
    expect(asSeller[0]).toMatchObject({ id: contactId, extra: {} });
    await expect(runProcess(deps, admin, "core.contact.list", { partyId: "00000000-0000-4000-8000-000000000000" })).rejects.toMatchObject({ code: "not_found" });
  });
});
