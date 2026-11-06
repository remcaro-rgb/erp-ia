import { kernelModule, loadModules, registerCountryPack, Registry, runProcess, syncModuleManifest, type Caller, type ProcessError } from "@erp/kernel";
import { seedTenant, testDb, withClaims, type JwtClaims, type SeededTenant } from "@erp/kernel/testing";
import { co } from "@erp/loc-co";
import { core } from "@erp/module-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sales } from "../index";

// The pricing parametros of the sales module and the price resolution (plan 2B Task 12, migrations 0081–0082): the customer's price list,
// then the company's default list, then the product's list price; a list that is not usable (inactive) or in another currency is skipped;
// writes only through the processes; company isolation.

const registry = new Registry();
loadModules(registry, [kernelModule, core, sales]);
const PROCESS_IDS = [...registry.processes({ module: "core" }), ...registry.processes({ module: "sales" })].map((p) => p.id);

const good = (sku: string, listPrice: number) => ({
  sku, description: `Café ${sku}`, kind: "good", idScheme: "999", uomCode: "94", ivaRate: "5", otherTaxes: [], listPrice, isFreeSample: false, standardCost: 16200, trackStock: true,
});
const customer = (documentNumber: string) => ({
  kind: ["customer"], personType: "1", documentType: "31", documentNumber, legalName: `Cliente ${documentNumber} S.A.S.`, taxResponsibilities: ["R-99-PN"], taxScheme: "ZZ",
  countryCode: "CO", departmentCode: "11", municipalityCode: "11001", addressLine: "Cra 1 # 2-3", invoiceEmail: "fe@cliente.example",
});

describe("sales pricing", () => {
  const sql = testDb();
  let seed: SeededTenant;
  let admin: Caller;
  let other: Caller;
  let companyId: string;
  let otherCompanyId: string;
  let partyId: string;
  let plainId: string;
  let cafe: string;
  let customerList: string;
  let defaultList: string;
  const run = <T = unknown>(caller: Caller, processId: string, input: unknown) => runProcess({ sql, registry }, caller, processId, input) as Promise<T>;
  const refusal = async (promise: Promise<unknown>) => (await promise.then(() => null, (e: unknown) => e)) as ProcessError | null;
  const resolve = (party: string, extra: Record<string, unknown> = {}) => run<{ unitPrice: number; priceListId?: string; discountPct: number; source: string }>(admin, "sales.price.resolve", { productId: cafe, partyId: party, qty: 1, date: "2026-11-05", ...extra });
  const priceList = async (name: string, price: number, currency = "COP") => {
    const [list] = await sql<{ id: string }[]>`
      insert into core.price_lists (company_id, name, currency_code, status, requires_approval) values (${companyId}, ${name}, ${currency}, 'saved', false) returning id`;
    await sql`insert into core.price_list_items (company_id, price_list_id, product_id, price) values (${companyId}, ${list!.id}, ${cafe}, ${price})`;
    return list!.id;
  };

  beforeAll(async () => {
    registerCountryPack(co);
    await syncModuleManifest(sql, core);
    await syncModuleManifest(sql, sales);
    seed = await seedTenant(sql, { companies: 2, entitlements: ["module:core", "module:sales"] });
    for (const company of seed.companies) {
      for (const id of PROCESS_IDS) {
        await sql`insert into kernel.process_permissions(company_id, role_id, process_id) values (${company.id}, ${company.adminRoleId}, ${id}) on conflict do nothing`;
      }
    }
    companyId = seed.companies[0]!.id;
    otherCompanyId = seed.companies[1]!.id;
    admin = { claims: seed.claimsFor(seed.users.both, companyId) as JwtClaims, origin: "ui" };
    other = { claims: seed.claimsFor(seed.users.both, otherCompanyId) as JwtClaims, origin: "ui" };
    partyId = (await run<{ id: string }>(admin, "core.party.create", customer("860002964"))).id;
    plainId = (await run<{ id: string }>(admin, "core.party.create", customer("890903938"))).id;
    cafe = (await run<{ id: string }>(admin, "core.product.create", good("CAF-1", 28500))).id;
    customerList = await priceList("Mayoristas", 25000);
    defaultList = await priceList("General", 27000);
  });
  afterAll(async () => {
    const ids = [companyId, otherCompanyId];
    await sql.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      for (const table of ["customer_terms", "settings"]) await tx`delete from ${tx(`sales.${table}`)} where company_id = any(${ids}::uuid[])`;
      for (const table of ["price_list_items", "price_lists", "party_contacts", "products", "product_categories", "parties", "document_sequences", "entity_sequences"]) {
        await tx`delete from ${tx(`core.${table}`)} where company_id = any(${ids}::uuid[])`;
      }
    });
    await sql`delete from kernel.process_permissions where company_id = any(${ids}::uuid[])`;
    await sql`delete from kernel.outbox where company_id = any(${ids}::uuid[])`;
    await seed.cleanup();
    await sql.end();
  });

  it("without terms or a default list the price is the product's list price", async () => {
    expect(await resolve(partyId)).toEqual({ unitPrice: 28500, discountPct: 0, source: "list_price" });
  });

  it("the default list beats the list price; the customer's list beats the default list and brings their discount", async () => {
    await run(admin, "sales.settings.update", { defaultPriceListId: defaultList });
    expect(await resolve(partyId)).toEqual({ unitPrice: 27000, priceListId: defaultList, discountPct: 0, source: "default_list" });
    await run(admin, "sales.customer_terms.set", { partyId, priceListId: customerList, discountPct: 3 });
    expect(await resolve(partyId)).toEqual({ unitPrice: 25000, priceListId: customerList, discountPct: 3, source: "customer_list" });
    // Another customer keeps the default list.
    expect(await resolve(plainId)).toMatchObject({ unitPrice: 27000, source: "default_list" });
    const terms = await run<Record<string, unknown>>(admin, "sales.customer_terms.consult", { partyId });
    expect(terms).toMatchObject({ configured: true, price_list_id: customerList });
  });

  it("skips a list that is not usable (inactive, or not approved when it requires approval) and a document in another currency than the list", async () => {
    await sql`update core.price_lists set is_active = false where id = ${customerList}`;
    expect(await resolve(partyId)).toMatchObject({ unitPrice: 27000, source: "default_list", discountPct: 3 });
    await sql`update core.price_lists set is_active = true where id = ${customerList}`;
    // A list that requires approval and is only Grabado (not yet Aprobado) is not usable either; approved, it is.
    await sql`update core.price_lists set requires_approval = true where id = ${customerList}`;
    expect(await resolve(partyId)).toMatchObject({ unitPrice: 27000, source: "default_list" });
    await sql`update core.price_lists set status = 'approved' where id = ${customerList}`;
    expect(await resolve(partyId)).toMatchObject({ unitPrice: 25000, source: "customer_list" });
    await sql`update core.price_lists set requires_approval = false, status = 'saved' where id = ${customerList}`;
    // In USD no COP list applies and the list price (company currency) does not either: no price.
    const usd = await refusal(resolve(partyId, { currency: "USD" }));
    expect(usd).toMatchObject({ code: "invalid_input" });
    expect(usd!.message).toContain("price_not_found");
    // The standing discount does not depend on a price: sales.discount.resolve answers it in any currency.
    expect(await run(admin, "sales.discount.resolve", { partyId })).toEqual({ discountPct: 3 });
    expect(await run(admin, "sales.discount.resolve", { partyId: plainId })).toEqual({ discountPct: 0 });
  });

  it("refuses terms for a supplier, or with a list that is not usable; settings and terms are written only through the processes", async () => {
    const supplier = (await run<{ id: string }>(admin, "core.party.create", { ...customer("800197268"), kind: ["supplier"], invoiceEmail: undefined, supplierEmail: "p@x.co" })).id;
    expect(await refusal(run(admin, "sales.customer_terms.set", { partyId: supplier, priceListId: null }))).toMatchObject({ code: "invalid_input" });
    await sql`update core.price_lists set is_active = false where id = ${defaultList}`;
    expect(await refusal(run(admin, "sales.settings.update", { defaultPriceListId: defaultList }))).toMatchObject({ code: "invalid_input" });
    await sql`update core.price_lists set is_active = true where id = ${defaultList}`;
    // As the admin but outside runProcess (no erp.audit_process_id): the row is visible, the write changes nothing.
    const outside = await withClaims(sql, admin.claims, async (tx) => {
      const visible = await tx<{ n: number }[]>`select count(*)::int as n from sales.customer_terms where party_id = ${partyId}`;
      const updated = await tx`update sales.customer_terms set discount_pct = 50 where party_id = ${partyId}`;
      return { visible: visible[0]!.n, updated: updated.count };
    });
    expect(outside).toEqual({ visible: 1, updated: 0 });
  });

  it("isolates companies: another company sees neither the settings nor the terms", async () => {
    expect(await run(other, "sales.settings.consult", {})).toMatchObject({ configured: false });
    expect(await run(other, "sales.customer_terms.consult", { partyId })).toMatchObject({ configured: false });
  });
});
