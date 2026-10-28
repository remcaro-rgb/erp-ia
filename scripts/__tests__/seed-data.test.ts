import { describe, expect, it } from "vitest";
import { co } from "@erp/loc-co";
import { CATEGORIES, PARTIES, PRODUCTS } from "../demo/data";
import { DEMO_COMPANY, DEMO_COMPANY_ID, DEMO_ROLE_IDS, DEMO_TENANT_ID, LAURA, MARCELA } from "../demo/accounts";
import { assertLocalTarget, seedSqlIds } from "../seed";

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
    expect(exito).toMatchObject({ documentNumber: "890903938", kind: ["customer"], creditLimit: 250_000_000 });
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

describe("assertLocalTarget", () => {
  it("accepts the local stacks (CLI, Docker network, published Docker ports) and refuses anything else", () => {
    expect(() => assertLocalTarget({ supabaseUrl: "http://127.0.0.1:55321", databaseUrl: "postgresql://postgres:postgres@127.0.0.1:54322/postgres" })).not.toThrow();
    expect(() => assertLocalTarget({ supabaseUrl: "http://kong:8000", databaseUrl: "postgres://postgres:x@db:5432/postgres" })).not.toThrow();
    expect(() => assertLocalTarget({ supabaseUrl: "http://localhost:56321", databaseUrl: "postgresql://postgres:x@localhost:56322/postgres" })).not.toThrow();
    expect(() => assertLocalTarget({ supabaseUrl: "https://abcd.supabase.co", databaseUrl: "postgresql://postgres:postgres@127.0.0.1:54322/postgres" })).toThrow(/local/);
    expect(() => assertLocalTarget({ supabaseUrl: "http://127.0.0.1:55321", databaseUrl: "postgresql://postgres:x@db.abcd.supabase.co:5432/postgres" })).toThrow(/local/);
  });
});
