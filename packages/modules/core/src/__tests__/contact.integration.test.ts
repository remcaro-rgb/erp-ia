import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { runProcess, type Caller } from "@erp/kernel";
import { withClaims } from "@erp/kernel/testing";
import { coreHarness, exito, supplier, type CoreHarness } from "./helpers";

describe("core party contacts", () => {
  let h: CoreHarness;
  let sql: CoreHarness["sql"];
  let deps: CoreHarness["deps"];
  let admin: Caller;
  let partyId: string;

  beforeAll(async () => {
    h = await coreHarness({ companies: 2 });
    ({ sql, deps, admin } = h);
    partyId = (await runProcess(deps, admin, "core.party.create", exito)).id;
  });
  afterAll(async () => {
    await h.cleanup();
  });

  it("creates, updates and deletes a contact", async () => {
    const out = await runProcess(deps, admin, "core.contact.create", {
      partyId,
      name: "Ana Gómez",
      jobTitle: "Tesorera",
      email: "ana@exito.com",
      phone: "6015550000",
      ext: "123",
      mobile: "3001234567",
    });
    const [row] = await sql`select seq, party_id, name, phone_cc, mobile_cc, mobile from core.party_contacts where id = ${out.id}`;
    expect(row).toMatchObject({ party_id: partyId, name: "Ana Gómez", phone_cc: "57", mobile_cc: "57", mobile: "3001234567" });
    expect(Number(row!.seq)).toBeGreaterThan(0);

    await runProcess(deps, admin, "core.contact.update", { id: out.id, jobTitle: "Gerente financiera", email: "ana.gomez@exito.com" });
    const [updated] = await sql`select job_title, email, name from core.party_contacts where id = ${out.id}`;
    expect(updated).toMatchObject({ job_title: "Gerente financiera", email: "ana.gomez@exito.com", name: "Ana Gómez" });

    await runProcess(deps, admin, "core.contact.delete", { id: out.id });
    expect(await sql`select 1 from core.party_contacts where id = ${out.id}`).toHaveLength(0);
    const audit = await sql`select action from kernel.audit_log where process_id = 'core.contact.delete' and row_id = ${out.id}`;
    expect(audit.map((a) => a.action)).toContain("delete");
  });

  it("rejects an invalid e-mail or phone with invalid_input", async () => {
    await expect(runProcess(deps, admin, "core.contact.create", { partyId, name: "X", email: "no-es-correo" })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(runProcess(deps, admin, "core.contact.create", { partyId, name: "X", phone: "12" })).rejects.toMatchObject({ code: "invalid_input" });
    // Rule 11: +57 numbers are 10 digits starting with 3 or 60, or 7 digits.
    const error = await runProcess(deps, admin, "core.contact.create", { partyId, name: "X", phoneCc: "+57", phone: "12345678" }).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "invalid_input" });
    expect((error as { details: string[] }).details).toEqual(["Teléfono: Colombia: celular 10 dígitos (3…) o fijo 10 dígitos (60…)"]);
    await expect(runProcess(deps, admin, "core.contact.create", { partyId, name: "X", mobile: "12345678" })).rejects.toMatchObject({ code: "invalid_input" });
    // Another country follows its own length rule; the calling code is stored without "+".
    const abroad = await runProcess(deps, admin, "core.contact.create", { partyId, name: "Y", phoneCc: "+34", phone: "915551234", email: "y@iberia.es" });
    const [row] = await sql`select phone_cc, phone from core.party_contacts where id = ${abroad.id}`;
    expect(row).toMatchObject({ phone_cc: "34", phone: "915551234" });
    // An update validates the number against the stored calling code.
    await expect(runProcess(deps, admin, "core.contact.update", { id: abroad.id, phone: "12345" })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(runProcess(deps, admin, "core.contact.update", { id: abroad.id, phoneCc: "57" })).rejects.toMatchObject({ code: "invalid_input" });
    await runProcess(deps, admin, "core.contact.delete", { id: abroad.id });
  });

  it("a contact needs a party of the caller's company and scope", async () => {
    await expect(runProcess(deps, admin, "core.contact.create", { partyId: "00000000-0000-7000-8000-000000000000", name: "X" })).rejects.toMatchObject({
      code: "not_found",
    });
    const other: Caller = { claims: h.seed.claimsFor(h.seed.users.both, h.seed.companies[1]!.id), origin: "ui" };
    await expect(runProcess(deps, other, "core.contact.create", { partyId, name: "X" })).rejects.toMatchObject({ code: "not_found" });

    // Contacts of a party outside the caller's scope are not in the contacts view either.
    const provider = (await runProcess(deps, admin, "core.party.create", supplier("830000020"))).id;
    await runProcess(deps, admin, "core.contact.create", { partyId: provider, name: "Compras" });
    await runProcess(deps, admin, "core.contact.create", { partyId, name: "Cartera" });
    const company = h.seed.companies[0]!;
    await sql`update kernel.roles set party_scope = 'clientes' where id = ${company.memberRoleId}`;
    const claims = { ...admin.claims, role_ids: [company.memberRoleId] };
    const names = await withClaims(sql, claims, (tx) => tx<{ name: string }[]>`select name from core.v_party_contacts order by name`);
    expect(names.map((n) => n.name)).toEqual(["Cartera"]);
  });
});
