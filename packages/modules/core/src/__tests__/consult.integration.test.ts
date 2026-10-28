import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runProcess, type Caller } from "@erp/kernel";
import { coreHarness, type CoreHarness } from "./helpers";

// The own consult process of every core entity (design §9, rule 13): units, price lists and their items, party
// contacts and document sequences are read one row at a time through their masked views, as the caller.

describe("core consult processes", () => {
  let h: CoreHarness;
  let admin: Caller;
  let adminB: Caller;
  let priceListId: string;
  let sequenceId: string;
  let otherSequenceId: string;

  beforeAll(async () => {
    h = await coreHarness({ companies: 2 });
    admin = h.admin;
    adminB = { claims: h.seed.claimsFor(h.seed.users.both, h.seed.companies[1]!.id), origin: "ui" };
    const [list] = await h.sql<{ id: string }[]>`insert into core.price_lists (company_id, name, currency_code) values (${h.companyId}, 'Mayoristas', 'COP') returning id`;
    priceListId = list!.id;
    const [seq] = await h.sql<{ id: string }[]>`
      insert into core.document_sequences (company_id, document_type, prefix, next_number, padding) values (${h.companyId}, 'FE', 'FE-', 1, 5) returning id`;
    sequenceId = seq!.id;
    const [other] = await h.sql<{ id: string }[]>`
      insert into core.document_sequences (company_id, document_type, prefix, next_number, padding) values (${h.seed.companies[1]!.id}, 'FE', 'B-', 1, 5) returning id`;
    otherSequenceId = other!.id;
  });
  afterAll(async () => {
    await h.cleanup();
  });

  it("reads one row of the entity's masked view, in the caller's company only", async () => {
    expect(await runProcess(h.deps, admin, "core.price_list.consult", { id: priceListId })).toMatchObject({ id: priceListId, name: "Mayoristas", currency_code: "COP" });
    expect(await runProcess(h.deps, admin, "core.document_sequence.consult", { id: sequenceId })).toMatchObject({ prefix: "FE-" });
    await expect(runProcess(h.deps, admin, "core.document_sequence.consult", { id: otherSequenceId })).rejects.toMatchObject({ code: "not_found" });
    await expect(runProcess(h.deps, adminB, "core.price_list.consult", { id: priceListId })).rejects.toMatchObject({ code: "not_found" });
    const [uom] = await h.sql<{ id: string }[]>`select id from core.uoms where code = 'KGM'`;
    expect(await runProcess(h.deps, admin, "core.uom.consult", { id: uom!.id })).toMatchObject({ code: "KGM" });
  });

  it("a party's contact is read within the party scope", async () => {
    const { id: partyId } = await runProcess(h.deps, admin, "core.party.create", {
      kind: ["supplier"],
      personType: "1",
      documentType: "31",
      documentNumber: "900373115",
      legalName: "Café del Norte S.A.S.",
      supplierEmail: "compras@cafedelnorte.co",
    });
    const { id: contactId } = await runProcess(h.deps, admin, "core.contact.create", { partyId, name: "Ana Gómez", email: "ana@cafedelnorte.co" });
    expect(await runProcess(h.deps, admin, "core.party_contact.consult", { id: contactId })).toMatchObject({ name: "Ana Gómez", party_id: partyId });
    // A role that sees only customers does not see a supplier's contact.
    await h.sql`update kernel.roles set party_scope = 'clientes' where id = ${h.seed.companies[0]!.adminRoleId}`;
    try {
      await expect(runProcess(h.deps, admin, "core.party_contact.consult", { id: contactId })).rejects.toMatchObject({ code: "not_found" });
    } finally {
      await h.sql`update kernel.roles set party_scope = 'ambos' where id = ${h.seed.companies[0]!.adminRoleId}`;
    }
  });
});
