import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { co } from "@erp/loc-co";
import { CATEGORIES, INVOICE_READY_PARTIES, landlineIndicative, PARTIES, PRODUCTS } from "../demo/data";
import { DEMO_COMPANY, DEMO_COMPANY_ID, DEMO_ROLE_IDS, DEMO_TENANT_ID, LAURA, MARCELA } from "../demo/accounts";
import { assertSeedAllowed, seedSqlIds } from "../seed";

// The demo company's data (Task 22, rule 10): what `pnpm db:seed` sends to core.party.create / core.product.create must
// pass the Colombian pack with nothing missing, so every seeded party and product is DIAN-complete; the ids the SQL seed
// writes are the ones the TypeScript seed and the smoke test use; and the seed only ever runs against a local stack.

describe("the demo master data", () => {
  it("has 40 DIAN-complete parties with unique documents, Éxito among them", () => {
    expect(PARTIES).toHaveLength(40);
    expect(new Set(PARTIES.map((p) => `${p.documentType}:${p.documentNumber}`)).size).toBe(40);
    for (const party of PARTIES) {
      const result = co.validateParty({ ...party, countryCode: "CO", kind: [...party.kind] });
      expect(result.errors, party.legalName ?? party.firstSurname).toEqual([]);
      expect(result.missing, party.legalName ?? party.firstSurname).toEqual([]);
    }
    const exito = PARTIES.find((p) => p.legalName === "Almacenes Éxito S.A.");
    expect(exito).toMatchObject({ documentNumber: "890900608", kind: ["customer"], creditLimit: 250_000_000 });
    expect(co.validateParty({ ...exito!, countryCode: "CO", kind: [...exito!.kind] }).normalized.checkDigit).toBe("9");
    expect(PARTIES.filter((p) => p.kind.includes("customer"))).toHaveLength(30);
    expect(PARTIES.filter((p) => p.kind.includes("supplier"))).toHaveLength(12);
  });

  it("has 25 products in 6 categories, DIAN-complete with their category's taxes and unit, suppliers that are suppliers", () => {
    expect(CATEGORIES).toHaveLength(6);
    expect(PRODUCTS).toHaveLength(25);
    expect(new Set(PRODUCTS.map((p) => p.sku)).size).toBe(25);
    for (const product of PRODUCTS) {
      const category = CATEGORIES.find((c) => c.name === product.category);
      expect(category, product.sku).toBeDefined();
      const result = co.validateProduct({
        ...product,
        idScheme: product.idScheme ?? "999",
        isFreeSample: false,
        uomCode: product.uomCode ?? category!.defaultUom,
        ivaRate: category!.ivaRate,
        incRate: category!.incRate,
        otherTaxes: [],
      });
      expect(result.errors, product.sku).toEqual([]);
      expect(result.missing, product.sku).toEqual([]);
      if (product.supplier) expect(PARTIES.find((p) => p.documentNumber === product.supplier)?.kind, product.sku).toContain("supplier");
    }
  });

  it("names the company, its roles and accounts with fixed ids the SQL seed writes", () => {
    expect(DEMO_COMPANY).toMatchObject({ legalName: "Café del Norte S.A.S.", taxId: "900373115", checkDigit: "3" });
    expect(co.validateParty({ kind: ["customer"], personType: "1", documentType: "31", documentNumber: DEMO_COMPANY.taxId, taxResponsibilities: ["O-13"], taxScheme: "01", countryCode: "CO" }).normalized.checkDigit).toBe("3");
    expect(seedSqlIds()).toEqual(new Set([DEMO_TENANT_ID, DEMO_COMPANY_ID, ...Object.values(DEMO_ROLE_IDS)]));
    expect(LAURA.roles).toEqual(["admin", "gerente_comercial"]);
    expect(MARCELA.roles).toEqual(["cajero"]);
    expect(LAURA.totpSecret).toMatch(/^[A-Z2-7]{32}$/);
  });
});

describe("the demo parties' phones and documents", () => {
  it("give landlines the indicative of their department (601 Bogotá, 604 Antioquia, 602 Valle, 605 Caribe…)", () => {
    expect(landlineIndicative("11")).toBe("601");
    expect(landlineIndicative("25")).toBe("601");
    expect(landlineIndicative("05")).toBe("604");
    expect(landlineIndicative("76")).toBe("602");
    expect(landlineIndicative("08")).toBe("605");
    expect(landlineIndicative("13")).toBe("605");
    expect(landlineIndicative("66")).toBe("606");
    expect(landlineIndicative("68")).toBe("607");
    expect(landlineIndicative("73")).toBe("608");
    for (const party of PARTIES.filter((p) => p.phone.startsWith("60"))) {
      expect(party.phone.slice(0, 3), party.legalName).toBe(landlineIndicative(party.departmentCode));
      expect(party.phone, party.legalName).toHaveLength(10);
    }
  });

  it("names at least 6 parties, Éxito first, that get their required files and become invoice-ready", () => {
    expect(INVOICE_READY_PARTIES.length).toBeGreaterThanOrEqual(6);
    expect(INVOICE_READY_PARTIES[0]).toBe("890900608");
    for (const document of INVOICE_READY_PARTIES) expect(PARTIES.some((p) => p.documentNumber === document), document).toBe(true);
  });
});

describe("assertSeedAllowed", () => {
  const cli = { supabaseUrl: "http://127.0.0.1:55321", databaseUrl: "postgresql://postgres:postgres@127.0.0.1:54322/postgres" };
  const compose = { supabaseUrl: "http://kong:8000", databaseUrl: "postgres://postgres:x@db:5432/postgres" };
  it("needs DEMO_SEED=1 on every stack, the compose network included", () => {
    expect(() => assertSeedAllowed(cli, {})).toThrow(/DEMO_SEED=1/);
    expect(() => assertSeedAllowed(compose, {})).toThrow(/DEMO_SEED=1/);
    expect(() => assertSeedAllowed(compose, { DEMO_SEED: "true" })).toThrow(/DEMO_SEED=1/);
    expect(() => assertSeedAllowed(cli, { DEMO_SEED: "1" })).not.toThrow();
    expect(() => assertSeedAllowed(compose, { DEMO_SEED: "1" })).not.toThrow();
    expect(() => assertSeedAllowed({ supabaseUrl: "http://localhost:56321", databaseUrl: "postgresql://postgres:x@localhost:56322/postgres" }, { DEMO_SEED: "1" })).not.toThrow();
  });
  it("refuses any host that is not a local stack, even with the flag", () => {
    expect(() => assertSeedAllowed({ ...cli, supabaseUrl: "https://abcd.supabase.co" }, { DEMO_SEED: "1" })).toThrow(/local/);
    expect(() => assertSeedAllowed({ ...cli, databaseUrl: "postgresql://postgres:x@db.abcd.supabase.co:5432/postgres" }, { DEMO_SEED: "1" })).toThrow(/local/);
  });
});

describe("the compose files", () => {
  const read = (name: string) => readFileSync(join(__dirname, "..", "..", name), "utf8");
  it("keep the demo out of the production stack: no seed job, no seed.sql, no mock model allowed", () => {
    const production = read("docker-compose.yml");
    expect(production).not.toMatch(/^ {2}seed:/m);
    expect(production).not.toMatch(/seed\.sql:/);
    expect(production).not.toMatch(/DEMO_SEED|ALLOW_MOCK_MODEL:/);
  });
  it("load it in the test stack only, with DEMO_SEED=1, and allow the mock model there", () => {
    const test = read("docker-compose.test.yml");
    expect(test).toMatch(/^ {2}seed:/m);
    expect(test).toMatch(/\.\/supabase\/seed\.sql:\/supabase\/seed\.sql:ro/);
    expect(test).toMatch(/DEMO_SEED: "1"/);
    expect(test).toMatch(/ALLOW_MOCK_MODEL: "1"/);
  });
});
