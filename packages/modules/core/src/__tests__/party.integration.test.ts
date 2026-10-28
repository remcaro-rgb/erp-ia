import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { runProcess, type Caller } from "@erp/kernel";
import { withClaims } from "@erp/kernel/testing";
import { coreHarness, exito, supplier, type CoreHarness } from "./helpers";

describe("core parties", () => {
  let h: CoreHarness;
  let sql: CoreHarness["sql"];
  let deps: CoreHarness["deps"];
  let admin: Caller;
  let vendedor: Caller;

  beforeAll(async () => {
    h = await coreHarness({ companies: 2, users: [{ name: "vendedor", companies: [0], role: "member" }] });
    ({ sql, deps, admin } = h);
    // The member role becomes a sales role that only sees customers.
    const company = h.seed.companies[0]!;
    await sql`update kernel.roles set name = 'vendedor', party_scope = 'clientes' where id = ${company.memberRoleId}`;
    await h.grantAll(company.id, company.memberRoleId, ["core.party.create", "core.party.update", "core.party.consult"]);
    vendedor = { claims: h.seed.claimsFor(h.seed.users.vendedor!, h.companyId), origin: "ui" };
  });
  afterAll(async () => {
    await h.cleanup();
  });

  it("creates a customer with a valid NIT and emits core.party.created", async () => {
    const out = await runProcess(deps, admin, "core.party.create", exito);
    const [row] = await sql`select document_number, check_digit, dian_status, invoice_ready from core.parties where id = ${out.id}`;
    expect(row).toMatchObject({ document_number: "900373115", check_digit: "3", dian_status: "complete", invoice_ready: true });
    expect((await sql`select 1 from kernel.outbox where event = 'core.party.created' and payload->>'id' = ${out.id}`).length).toBe(1);
  });

  it("rejects format errors with invalid_input and stores missing data as dian_status", async () => {
    const base = { kind: ["customer"], personType: "1", documentType: "31", legalName: "x", taxResponsibilities: ["R-99-PN"], taxScheme: "ZZ", countryCode: "CO" };
    await expect(runProcess(deps, admin, "core.party.create", { ...base, documentNumber: "900.373.115" })).rejects.toMatchObject({
      code: "invalid_input",
    });
    const out = await runProcess(deps, admin, "core.party.create", { ...base, documentNumber: "800197268" });
    const [row] = await sql`select dian_status, dian_missing, invoice_ready from core.parties where id = ${out.id}`;
    expect(row!.dian_status).toBe("missing: 4");
    expect(row!.dian_missing).toEqual([
      "Departamento (DANE)",
      "Municipio (DANE)",
      "Dirección",
      "Correo para recibir facturas electrónicas",
    ]);
    expect(row!.invoice_ready).toBe(false);
  });

  it("rejects a duplicate tax id in the same company but allows it in another company", async () => {
    const first = { ...exito, documentNumber: "860002964" };
    await runProcess(deps, admin, "core.party.create", first);
    const error = await runProcess(deps, admin, "core.party.create", first).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "invalid_input" });
    expect((error as { details: string[] }).details.join(" ")).toContain("860002964");
    const otherCompany = h.seed.companies[1]!.id;
    const inOther: Caller = { claims: h.seed.claimsFor(h.seed.users.both, otherCompany), origin: "ui" };
    const out = await runProcess(deps, inOther, "core.party.create", first);
    const [row] = await sql`select company_id from core.parties where id = ${out.id}`;
    expect(row!.company_id).toBe(otherCompany);
  });

  it("creating a party of kind customer+supplier without supplier_email stores dian_missing containing \"Correo para enviar documentos al proveedor\"", async () => {
    const out = await runProcess(deps, admin, "core.party.create", { ...exito, kind: ["customer", "supplier"], documentNumber: "890903938" });
    const [row] = await sql`select dian_status, dian_missing, kind from core.parties where id = ${out.id}`;
    expect(row!.dian_missing).toEqual(["Correo para enviar documentos al proveedor"]);
    expect(row!.dian_status).toBe("missing: 1");
    expect(row!.kind).toEqual(["customer", "supplier"]);
  });

  it("phone \"12\" with cc 57 is rejected with invalid_input", async () => {
    const error = await runProcess(deps, admin, "core.party.create", { ...exito, documentNumber: "811000001", phoneCc: "57", phone: "12" }).catch(
      (e: unknown) => e,
    );
    expect(error).toMatchObject({ code: "invalid_input" });
    expect((error as { details: string[] }).details.some((d) => d.startsWith("Teléfono"))).toBe(true);
    expect((await sql`select 1 from core.parties where company_id = ${h.companyId} and document_number = '811000001'`).length).toBe(0);
  });

  it("update re-validates the merged record, keeps seq and emits core.party.updated; deactivate clears invoice_ready", async () => {
    const out = await runProcess(deps, admin, "core.party.create", { ...exito, documentNumber: "830000001", invoiceEmail: undefined });
    const [before] = await sql`select seq, dian_status from core.parties where id = ${out.id}`;
    expect(before!.dian_status).toBe("missing: 1");
    await runProcess(deps, admin, "core.party.update", { id: out.id, invoiceEmail: "facturas@cliente.co", phone: "3001234567", creditLimit: 5000000 });
    const [after] = await sql`select seq, dian_status, invoice_ready, phone, phone_cc, credit_limit, legal_name from core.parties where id = ${out.id}`;
    expect(after).toMatchObject({ seq: before!.seq, dian_status: "complete", invoice_ready: true, phone: "3001234567", phone_cc: "57", legal_name: exito.legalName });
    expect(Number(after!.credit_limit)).toBe(5000000);
    expect((await sql`select 1 from kernel.outbox where event = 'core.party.updated' and payload->>'id' = ${out.id}`).length).toBe(1);
    await expect(runProcess(deps, admin, "core.party.update", { id: out.id, invoiceEmail: "no-es-correo" })).rejects.toMatchObject({ code: "invalid_input" });

    await runProcess(deps, admin, "core.party.deactivate", { id: out.id });
    const [inactive] = await sql`select is_active, invoice_ready, dian_status from core.parties where id = ${out.id}`;
    expect(inactive).toMatchObject({ is_active: false, invoice_ready: false, dian_status: "complete" });
  });

  it("seq is assigned by the database and cannot be changed by an update", async () => {
    const out = await runProcess(deps, admin, "core.party.create", { ...exito, documentNumber: "830000002" });
    const [row] = await sql`select seq from core.parties where id = ${out.id}`;
    await withClaims(sql, admin.claims, (tx) => tx`update core.parties set seq = 999999 where id = ${out.id}`);
    const [after] = await sql`select seq from core.parties where id = ${out.id}`;
    expect(after!.seq).toBe(row!.seq);
  });

  it("seq is gap-free under 20 concurrent party.create", async () => {
    const outs = await Promise.all(
      Array.from({ length: 20 }, (_, i) => runProcess(deps, admin, "core.party.create", supplier(String(700000100 + i)))),
    );
    const rows = await sql<{ seq: string }[]>`select seq from core.parties where id = any(${outs.map((o) => o.id)}::uuid[]) order by seq`;
    const seqs = rows.map((r) => Number(r.seq));
    expect(seqs).toHaveLength(20);
    expect(seqs.at(-1)! - seqs[0]!).toBe(19);
    const [max] = await sql<{ max: string }[]>`select max(seq) as max from core.parties where company_id = ${h.companyId}`;
    const [count] = await sql<{ n: number }[]>`select count(*)::int as n from core.parties where company_id = ${h.companyId}`;
    // Every seq of the company from 1 to the max is used exactly once, rejected runs included.
    expect(Number(max!.max)).toBe(count!.n);
  });

  it("consult reads the masked view: a hidden field comes back null", async () => {
    const out = await runProcess(deps, admin, "core.party.create", { ...exito, documentNumber: "830000003", creditLimit: 1000 });
    const company = h.seed.companies[0]!;
    await sql`insert into kernel.field_permissions(company_id, role_id, entity, field, mode)
              values (${company.id}, ${company.memberRoleId}, 'core.party', 'credit_limit', 'hidden')`;
    const seen = await runProcess(deps, vendedor, "core.party.consult", { id: out.id });
    expect(seen).toMatchObject({ id: out.id, legal_name: exito.legalName, credit_limit: null });
    const full = await runProcess(deps, admin, "core.party.consult", { id: out.id });
    expect(Number(full.credit_limit)).toBe(1000);
  });

  it("a vendedor with party_scope clientes cannot read a supplier through core.party.consult", async () => {
    const provider = await runProcess(deps, admin, "core.party.create", supplier("830000004"));
    const customer = await runProcess(deps, admin, "core.party.create", { ...exito, documentNumber: "830000005" });
    await expect(runProcess(deps, vendedor, "core.party.consult", { id: provider.id })).rejects.toMatchObject({ code: "not_found" });
    await expect(runProcess(deps, vendedor, "core.party.consult", { id: customer.id })).resolves.toMatchObject({ id: customer.id });
    // The scope also bounds writes: the supplier is invisible to update, and a supplier cannot be created.
    await expect(runProcess(deps, vendedor, "core.party.update", { id: provider.id, phone: "3001234567" })).rejects.toMatchObject({ code: "not_found" });
    await expect(runProcess(deps, vendedor, "core.party.create", supplier("830000006"))).rejects.toMatchObject({ code: "forbidden" });
    await expect(runProcess(deps, vendedor, "core.party.update", { id: customer.id, kind: ["supplier"] })).rejects.toMatchObject({ code: "forbidden" });
    // The view itself filters, so grids and exports see the same rows.
    const kinds = await withClaims(sql, vendedor.claims, (tx) => tx<{ kind: string[] }[]>`select kind from core.v_parties`);
    expect(kinds.length).toBeGreaterThan(0);
    expect(kinds.every((r) => r.kind.includes("customer"))).toBe(true);
  });

  it("a write is forbidden when any non-employee kind of the record is outside the caller's scope; ambos may do it all", async () => {
    const dual = { ...exito, kind: ["customer", "supplier"], supplierEmail: "compras@exito.com" };
    await expect(runProcess(deps, vendedor, "core.party.create", { ...dual, documentNumber: "830000030" })).rejects.toMatchObject({ code: "forbidden" });
    const customer = await runProcess(deps, vendedor, "core.party.create", { ...exito, documentNumber: "830000031" });
    await expect(runProcess(deps, vendedor, "core.party.update", { id: customer.id, kind: ["customer", "supplier"] })).rejects.toMatchObject({
      code: "forbidden",
    });
    const existing = await runProcess(deps, admin, "core.party.create", { ...dual, documentNumber: "830000032" });
    await expect(runProcess(deps, vendedor, "core.party.update", { id: existing.id, supplierEmail: "otro@exito.com" })).rejects.toMatchObject({
      code: "forbidden",
    });
    await expect(runProcess(deps, vendedor, "core.party.update", { id: existing.id, kind: ["customer"] })).rejects.toMatchObject({ code: "forbidden" });
    const [unchanged] = await sql`select kind, supplier_email from core.parties where id = ${existing.id}`;
    expect(unchanged).toMatchObject({ kind: ["customer", "supplier"], supplier_email: "compras@exito.com" });
    // An employee kind does not need a party scope.
    await expect(runProcess(deps, vendedor, "core.party.create", { ...exito, kind: ["customer", "employee"], documentNumber: "830000033" })).resolves.toMatchObject({
      id: expect.any(String),
    });

    // The admin's scope is ambos: the same three writes succeed.
    await expect(runProcess(deps, admin, "core.party.create", { ...dual, documentNumber: "830000034" })).resolves.toMatchObject({ id: expect.any(String) });
    await runProcess(deps, admin, "core.party.update", { id: customer.id, kind: ["customer", "supplier"], supplierEmail: "compras@cliente.co" });
    await runProcess(deps, admin, "core.party.update", { id: existing.id, supplierEmail: "otro@exito.com" });
    const rows = await sql`select id, kind, supplier_email from core.parties where id = any(${[customer.id, existing.id]}::uuid[]) order by document_number`;
    expect(rows.map((r) => [r.kind, r.supplier_email])).toEqual([
      [["customer", "supplier"], "compras@cliente.co"],
      [["customer", "supplier"], "otro@exito.com"],
    ]);
  });

  it("an update onto another party's document is invalid_input", async () => {
    await runProcess(deps, admin, "core.party.create", { ...exito, documentNumber: "830000040" });
    const other = await runProcess(deps, admin, "core.party.create", { ...exito, documentNumber: "830000041" });
    const error = await runProcess(deps, admin, "core.party.update", { id: other.id, documentNumber: "830000040" }).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "invalid_input" });
    expect((error as { details: string[] }).details.join(" ")).toContain("830000040");
  });

  it("party_scope is the union of the caller's roles: clientes + proveedores sees both, ninguno sees nothing", async () => {
    const company = h.seed.companies[0]!;
    const [buyer] = await sql<{ id: string }[]>`
      insert into kernel.roles(company_id, name, party_scope) values (${company.id}, 'compras', 'proveedores') returning id`;
    const [none] = await sql<{ id: string }[]>`
      insert into kernel.roles(company_id, name, party_scope) values (${company.id}, 'caja', 'ninguno') returning id`;
    const claims = (roleIds: string[]) => ({ ...vendedor.claims, role_ids: roleIds });
    const scopeOf = async (roleIds: string[]) =>
      (await withClaims(sql, claims(roleIds), (tx) => tx<{ s: string }[]>`select kernel.party_scope() as s`))[0]!.s;
    expect(await scopeOf([company.memberRoleId])).toBe("clientes");
    expect(await scopeOf([buyer!.id])).toBe("proveedores");
    expect(await scopeOf([company.memberRoleId, buyer!.id])).toBe("ambos");
    expect(await scopeOf([none!.id])).toBe("ninguno");
    expect(await scopeOf([])).toBe("ninguno");
    const rows = await withClaims(sql, claims([none!.id]), (tx) => tx`select id from core.v_parties`);
    expect(rows).toHaveLength(0);
    await sql`delete from kernel.roles where id = any(${[buyer!.id, none!.id]}::uuid[])`;
  });

  it("another company cannot read the party (company RLS)", async () => {
    const out = await runProcess(deps, admin, "core.party.create", { ...exito, documentNumber: "830000007" });
    const otherCompany = h.seed.companies[1]!.id;
    const rows = await withClaims(sql, h.seed.claimsFor(h.seed.users.both, otherCompany), (tx) => tx`select id from core.v_parties where id = ${out.id}`);
    expect(rows).toHaveLength(0);
  });
});
