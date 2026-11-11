import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { seedAuthUser, type AuthFixture } from "../../../../../test-support/auth-fixtures";
import { MemoryJar } from "../../../../../test-support/memory-jar";

const state = vi.hoisted(() => ({ jar: undefined as unknown }));
vi.mock("next/headers", () => ({ cookies: async () => state.jar, headers: async () => new Headers() }));
vi.mock("next-intl/server", async () => {
  const { messages } = await import("@erp/i18n");
  const catalogue = messages("es-419");
  const lookup = (key: string): unknown => key.split(".").reduce<unknown>((node, part) => (node && typeof node === "object" ? (node as Record<string, unknown>)[part] : undefined), catalogue);
  const t = Object.assign((key: string) => (typeof lookup(key) === "string" ? (lookup(key) as string) : key), { has: (key: string) => typeof lookup(key) === "string" });
  return { getLocale: async () => "es-419", getTranslations: async () => t };
});

import { recordHref, type GridColumn } from "@erp/ui";
import { loginWithPassword } from "@/lib/auth/login";
import { loadGridPage } from "@/lib/grid/load";
import { POST } from "../[entity]/route";

// Every entity reference is a link (design §22.15, rule 21) on the Productos grid, against the real stack: the page's
// columns say the supplier is a reference to a party the caller may open, and the grid route's rows name it, so its cell
// links to /r/core.party/<id> by the party's legal name. A caller who may not consult parties gets neither.

let fixture: AuthFixture;
let supplierId: string;
let roleId: string;
let companyId: string;

const page = async () => {
  const result = await loadGridPage("core.product", "/products");
  if (!result.ok) throw new Error(result.denial);
  return result.data;
};
const rows = async () => {
  const response = await POST(
    new Request("http://localhost/api/grid/core.product", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ filters: [], sort: [], page: 1, pageSize: 25 }) }),
    { params: Promise.resolve({ entity: "core.product" }) },
  );
  expect(response.status).toBe(200);
  return ((await response.json()) as { rows: Record<string, unknown>[] }).rows;
};
const supplierColumn = (columns: GridColumn[]) => columns.find((c) => c.field === "supplier_id")!;

beforeAll(async () => {
  fixture = await seedAuthUser({ role: "member" });
  companyId = fixture.companyIds[0]!;
  const { sql } = fixture;
  await sql`insert into kernel.tenant_entitlements(tenant_id, key, source) values (${fixture.tenantId}, 'module:core', 'manual')`;
  [{ id: roleId }] = await sql<{ id: string }[]>`select id from kernel.roles where company_id = ${companyId}`;
  for (const process of ["core.product.consult", "core.party.consult"]) {
    await sql`insert into kernel.process_permissions(company_id, role_id, process_id) values (${companyId}, ${roleId}, ${process})`;
  }
  const [party] = await sql<{ id: string }[]>`
    insert into core.parties (company_id, kind, person_type, document_type, document_number, legal_name, dian_status)
    values (${companyId}, ${["supplier"]}, '1', '31', '900373115', 'Café del Norte S.A.S.', 'complete') returning id`;
  supplierId = party!.id;
  await sql`
    insert into core.products ${sql({
      company_id: companyId,
      sku: "CAF-GRA-500",
      description: "Café en grano 500 g",
      kind: "good",
      id_scheme: "999",
      uom_code: "KGM",
      iva_rate: "5",
      list_price: 31000,
      track_stock: true,
      supplier_id: supplierId,
      dian_status: "complete",
    })}`;
  const jar = new MemoryJar();
  state.jar = jar;
  await loginWithPassword(jar, { email: fixture.email, password: fixture.password, remember: false });
});

afterAll(async () => {
  const { sql } = fixture;
  for (const table of ["products", "parties", "entity_sequences"]) await sql`delete from ${sql(`core.${table}`)} where company_id = ${companyId}`;
  await sql`delete from kernel.process_permissions where company_id = ${companyId}`;
  await sql`delete from kernel.tenant_entitlements where tenant_id = ${fixture.tenantId}`;
  await fixture.cleanup();
});

describe("Productos grid: the supplier is a link to the party", () => {
  it("the supplier column links to the party the row names, by its legal name", async () => {
    const column = supplierColumn((await page()).columns);
    expect(column).toMatchObject({ ref: { entity: "core.party", display: "legal_name" }, linkable: true });
    const [row] = await rows();
    expect(row).toMatchObject({ supplier_id: supplierId, supplier_id_label: "Café del Norte S.A.S." });
    expect(recordHref(column.ref!.entity, String(row!.supplier_id))).toBe(`/r/core.party/${supplierId}`);
    expect(row).not.toHaveProperty("supplier_id_found");
  });

  it("a readable party whose name the role does not see has no label but is marked found (Task 39, final review m2)", async () => {
    await fixture.sql`insert into kernel.field_permissions(company_id, role_id, entity, field, mode) values (${companyId}, ${roleId}, 'core.party', 'legal_name', 'hidden')`;
    try {
      const [row] = await rows();
      expect(row!.supplier_id).toBe(supplierId);
      expect(row).not.toHaveProperty("supplier_id_label");
      expect(row!.supplier_id_found).toBe(true);
    } finally {
      await fixture.sql`delete from kernel.field_permissions where company_id = ${companyId} and role_id = ${roleId} and entity = 'core.party'`;
    }
  });

  it("without core.party.consult the supplier is neither named nor linked", async () => {
    await fixture.sql`delete from kernel.process_permissions where company_id = ${companyId} and role_id = ${roleId} and process_id = 'core.party.consult'`;
    try {
      expect(supplierColumn((await page()).columns).linkable).toBeUndefined();
      const [row] = await rows();
      expect(row!.supplier_id).toBe(supplierId);
      expect(row).not.toHaveProperty("supplier_id_label");
      expect(row).not.toHaveProperty("supplier_id_found");
    } finally {
      await fixture.sql`insert into kernel.process_permissions(company_id, role_id, process_id) values (${companyId}, ${roleId}, 'core.party.consult')`;
    }
  });
});
