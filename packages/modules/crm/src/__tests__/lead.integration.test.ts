import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { crmHarness, prospect, type CrmHarness } from "./helpers";

// Prospectos and their conversion (plan 2B Task 11): crm.lead.convert creates the tercero through core's own create process (the DIAN
// validation applies, missing data sets dian_status, the tercero is not invoice_ready) and an oportunidad in the default embudo.

describe("crm leads", () => {
  let h: CrmHarness;

  beforeAll(async () => {
    h = await crmHarness();
  });
  afterAll(async () => {
    await h.cleanup();
  });

  it("creates a prospecto in stage new, owned by the caller, Grabado", async () => {
    const out = await h.run<{ id: string }>(h.vendedor, "crm.lead.create", prospect("Café del Sur S.A.S."));
    const [row] = await h.sql`select stage, status, source, owner_id, company_id from crm.leads where id = ${out.id}`;
    expect(row).toMatchObject({ stage: "new", status: "saved", source: "referral", company_id: h.companyId });
    expect(row!.owner_id).toBe(h.vendedor.claims.sub);
  });

  it("validates the e-mail and the phone (indicativo and number together)", async () => {
    await expect(h.run(h.admin, "crm.lead.create", prospect("Mal correo", { email: "no-es-correo" }))).rejects.toMatchObject({ code: "invalid_input" });
    await expect(h.run(h.admin, "crm.lead.create", prospect("Solo número", { phone: "3105551234" }))).rejects.toMatchObject({ code: "invalid_input" });
    const ok = await h.run<{ id: string }>(h.admin, "crm.lead.create", prospect("Con teléfono", { phoneCc: "+57", phone: "3105551234" }));
    const [row] = await h.sql`select phone_cc, phone from crm.leads where id = ${ok.id}`;
    expect(row).toEqual({ phone_cc: "57", phone: "3105551234" });
  });

  it("updates a prospecto and moves it by hand but never to converted", async () => {
    const { id } = await h.run<{ id: string }>(h.admin, "crm.lead.create", prospect("Tostadora Andina"));
    await h.run(h.admin, "crm.lead.update", { id, stage: "qualified", notes: "Pide cotización" });
    const [row] = await h.sql`select stage, notes from crm.leads where id = ${id}`;
    expect(row).toEqual({ stage: "qualified", notes: "Pide cotización" });
    await expect(h.run(h.admin, "crm.lead.update", { id, stage: "converted" })).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("convert creates the tercero through core.party.create: DIAN data missing, so not invoice_ready, and an oportunidad", async () => {
    const lead = await h.run<{ id: string }>(h.vendedor, "crm.lead.create", prospect("Cafetería La Esquina S.A.S.", { documentNumber: "800197268" }));
    // The vendedor may not create terceros: an admin converts.
    await expect(h.run(h.vendedor, "crm.lead.convert", { id: lead.id })).rejects.toMatchObject({ code: "forbidden" });

    const out = await h.run<{ partyId: string; opportunityId: string; opportunityNumber: string; dianStatus: string; invoiceReady: boolean }>(h.admin, "crm.lead.convert", { id: lead.id, amount: 1500000 });
    expect(out.opportunityNumber).toMatch(/^OP-\d+$/);
    const [party] = await h.sql`select kind, document_type, document_number, check_digit, legal_name, dian_status, dian_missing, invoice_ready, invoice_email from core.parties where id = ${out.partyId}`;
    expect(party).toMatchObject({ kind: ["customer"], document_type: "31", document_number: "800197268", legal_name: "Cafetería La Esquina S.A.S.", invoice_ready: false });
    expect(String(party!.dian_status)).toMatch(/^missing/);
    expect(party!.dian_missing).toEqual(expect.arrayContaining(["Municipio (DANE)", "Dirección"]));
    expect(out).toMatchObject({ invoiceReady: false });
    expect(out.dianStatus).toMatch(/^missing/);

    const [opportunity] = await h.sql`select party_id, lead_id, title, outcome, amount, owner_id, status from crm.opportunities where id = ${out.opportunityId}`;
    expect(opportunity).toMatchObject({ party_id: out.partyId, lead_id: lead.id, title: "Cafetería La Esquina S.A.S.", outcome: "open", status: "saved" });
    expect(Number(opportunity!.amount)).toBe(1500000);
    // The deal keeps the prospecto's owner.
    expect(opportunity!.owner_id).toBe(h.vendedor.claims.sub);

    const [converted] = await h.sql`select stage, converted_party_id, converted_opportunity_id, converted_at from crm.leads where id = ${lead.id}`;
    expect(converted).toMatchObject({ stage: "converted", converted_party_id: out.partyId, converted_opportunity_id: out.opportunityId });
    expect(converted!.converted_at).not.toBeNull();
    // Core's own event was emitted by the party create, and the audit attributes the party rows to the nested core.party.create, on the chain of the convert run.
    expect((await h.sql`select 1 from kernel.outbox where company_id = ${h.companyId} and event = 'core.party.created' and payload->>'id' = ${out.partyId}`).length).toBe(1);
    expect((await h.sql`select 1 from kernel.audit_log where entity = 'core.parties' and row_id = ${out.partyId} and process_id = 'core.party.create' and action = 'insert'`).length).toBe(1);
  });

  it("convert refuses a converted prospecto, one without document data, and an invalid document, leaving nothing behind", async () => {
    const lead = await h.run<{ id: string }>(h.admin, "crm.lead.create", prospect("Sin documento", { personType: undefined, documentType: undefined, documentNumber: undefined }));
    const missing = await h.run(h.admin, "crm.lead.convert", { id: lead.id }).catch((e: unknown) => e);
    expect(missing).toMatchObject({ code: "invalid_input" });
    expect((missing as { details: string[] }).details.join(" ")).toContain("número de documento");

    // The pack refuses a NIT with dots: the whole conversion rolls back.
    const bad = await h.run(h.admin, "crm.lead.convert", { id: lead.id, personType: "1", documentType: "31", documentNumber: "900.373.115" }).catch((e: unknown) => e);
    expect(bad).toMatchObject({ code: "invalid_input" });
    const [still] = await h.sql`select stage, converted_party_id from crm.leads where id = ${lead.id}`;
    expect(still).toEqual({ stage: "new", converted_party_id: null });
    expect((await h.sql`select 1 from crm.opportunities where lead_id = ${lead.id}`).length).toBe(0);

    // With the document given at conversion it works once and only once.
    await h.run(h.admin, "crm.lead.convert", { id: lead.id, personType: "1", documentType: "31", documentNumber: "860002964" });
    await expect(h.run(h.admin, "crm.lead.convert", { id: lead.id, personType: "1", documentType: "31", documentNumber: "860002964" })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(h.run(h.admin, "crm.lead.update", { id: lead.id, notes: "tarde" })).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("convert of a persona natural asks for its names and builds the legal name from them", async () => {
    const lead = await h.run<{ id: string }>(h.admin, "crm.lead.create", prospect("Carlos Ruiz", { personType: "2", documentType: "13", documentNumber: "1020304050" }));
    await expect(h.run(h.admin, "crm.lead.convert", { id: lead.id })).rejects.toMatchObject({ code: "invalid_input" });
    const out = await h.run<{ partyId: string }>(h.admin, "crm.lead.convert", { id: lead.id, firstName: "Carlos", firstSurname: "Ruiz" });
    const [party] = await h.sql`select person_type, legal_name, first_name, first_surname from core.parties where id = ${out.partyId}`;
    expect(party).toMatchObject({ person_type: "2", first_name: "Carlos", first_surname: "Ruiz" });
    expect(party!.legal_name).toContain("Carlos");
  });

  it("convert links an existing tercero instead of creating one, and a duplicate document is refused", async () => {
    const first = await h.run<{ id: string }>(h.admin, "crm.lead.create", prospect("Primero", { documentNumber: "900373115" }));
    const done = await h.run<{ partyId: string }>(h.admin, "crm.lead.convert", { id: first.id });
    const second = await h.run<{ id: string }>(h.admin, "crm.lead.create", prospect("Mismo NIT", { documentNumber: "900373115" }));
    const dup = await h.run(h.admin, "crm.lead.convert", { id: second.id }).catch((e: unknown) => e);
    expect(dup).toMatchObject({ code: "invalid_input" });
    expect((dup as { details: string[] }).details.join(" ")).toContain("900373115");
    const linked = await h.run<{ partyId: string }>(h.admin, "crm.lead.convert", { id: second.id, partyId: done.partyId });
    expect(linked.partyId).toBe(done.partyId);
  });

  it("convert refuses a discarded prospecto, and a tercero that is not a customer", async () => {
    const lead = await h.run<{ id: string }>(h.admin, "crm.lead.create", prospect("Descartado", { documentNumber: "901111111" }));
    await h.run(h.admin, "crm.lead.update", { id: lead.id, stage: "discarded" });
    const refused = await h.run(h.admin, "crm.lead.convert", { id: lead.id }).catch((e: unknown) => e);
    expect(refused).toMatchObject({ code: "invalid_input" });
    expect((refused as Error).message).toContain("lead_discarded");
    expect((await h.sql`select stage from crm.leads where id = ${lead.id}`)[0]!.stage).toBe("discarded");

    const supplier = await h.run<{ id: string }>(h.admin, "core.party.create", { kind: ["supplier"], personType: "1", documentType: "31", documentNumber: "805000427", legalName: "Proveedor S.A.S." });
    await h.run(h.admin, "crm.lead.update", { id: lead.id, stage: "qualified" });
    const notCustomer = await h.run(h.admin, "crm.lead.convert", { id: lead.id, partyId: supplier.id }).catch((e: unknown) => e);
    expect(notCustomer).toMatchObject({ code: "invalid_input" });
    expect((notCustomer as Error).message).toContain("party_not_customer");
  });

  it("row isolation: a salesperson sees their own prospectos and the unowned ones, a manager (reassign) all", async () => {
    const { withClaims } = await import("@erp/kernel/testing");
    const mine = await h.run<{ id: string }>(h.vendedor, "crm.lead.create", prospect("Del vendedor", { documentNumber: "902222222" }));
    const theirs = await h.run<{ id: string }>(h.vendedora, "crm.lead.create", prospect("De la vendedora", { documentNumber: "903333333" }));
    const seen = (caller: typeof h.vendedor) =>
      withClaims(h.sql, caller.claims, (tx) => tx<{ id: string }[]>`select id from crm.v_leads where id = any(${[mine.id, theirs.id]}::uuid[])`);
    expect((await seen(h.vendedor)).map((r) => r.id)).toEqual([mine.id]);
    expect((await seen(h.vendedora)).map((r) => r.id)).toEqual([theirs.id]);
    expect((await seen(h.admin)).map((r) => r.id).sort()).toEqual([mine.id, theirs.id].sort());
    await expect(h.run(h.vendedor, "crm.lead.consult", { id: theirs.id })).rejects.toMatchObject({ code: "not_found" });
  });

  it("keeps companies apart: a prospecto of company 0 is invisible and not convertible from company 1", async () => {
    const lead = await h.run<{ id: string }>(h.admin, "crm.lead.create", prospect("Aislado", { documentNumber: "901234567" }));
    await expect(h.run(h.other, "crm.lead.consult", { id: lead.id })).rejects.toMatchObject({ code: "not_found" });
    await expect(h.run(h.other, "crm.lead.convert", { id: lead.id })).rejects.toMatchObject({ code: "not_found" });
  });
});
