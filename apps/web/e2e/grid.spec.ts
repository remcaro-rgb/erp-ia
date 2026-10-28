import { expect, test, type Page } from "@playwright/test";
import { seedAuthUser, type AuthFixture } from "../test-support/auth-fixtures";

// The universal grid in a real browser (design §9, rules 14, 20, 21, prototype gridHtml / advOpen / lookupHtml): the
// Terceros grid filtered and sorted on the server, a record opened in its own tab with the party form, the advanced
// filter with two conditions joined by O, a party created from "Nuevo", and the supplier lookup on the product form.

const SCREENSHOTS = "e2e/__screenshots__";

const PROCESSES = [
  "core.party.consult",
  "core.party.create",
  "core.party.update",
  "core.contact.list",
  "core.product.consult",
  "core.product.update",
  "core.category.consult",
  "kernel.custom_field.list",
  "kernel.attachment.list",
  "kernel.saved_view.save",
  "kernel.saved_view.list",
  "kernel.saved_view.delete",
];

async function signIn(page: Page, fixture: AuthFixture) {
  await page.goto("/login");
  await page.getByLabel("Correo").fill(fixture.email);
  await page.getByLabel("Contraseña", { exact: true }).fill(fixture.password);
  await page.getByRole("button", { name: "Entrar" }).click();
  await expect(page).toHaveURL(/\/$/);
}

const grid = (page: Page, name: string) => page.getByRole("region", { name });
const bodyRows = (page: Page) => page.locator(".erp-grid__body tbody tr.erp-row-link");

test.describe("universal grid", () => {
  let fixture: AuthFixture;
  let companyId: string;
  let productId: string;
  let norteId: string;

  test.beforeAll(async () => {
    fixture = await seedAuthUser({ role: "member" });
    companyId = fixture.companyIds[0]!;
    const { sql } = fixture;
    await sql`insert into kernel.tenant_entitlements(tenant_id, key, source) values (${fixture.tenantId}, 'module:core', 'manual')`;
    const [role] = await sql<{ id: string }[]>`select id from kernel.roles where company_id = ${companyId}`;
    for (const process of PROCESSES) {
      await sql`insert into kernel.process_permissions(company_id, role_id, process_id) values (${companyId}, ${role!.id}, ${process})`;
    }
    const party = async (name: string, doc: string, kind: string[], extra: Record<string, unknown> = {}) => {
      const [row] = await sql<{ id: string }[]>`
        insert into core.parties ${sql({
          company_id: companyId,
          kind,
          person_type: "1",
          document_type: "31",
          document_number: doc,
          legal_name: name,
          tax_responsibilities: ["O-13"],
          tax_scheme: "01",
          country_code: "CO",
          department_code: "11",
          municipality_code: "11001",
          address_line: "Cra 7 # 71-21",
          invoice_email: kind.includes("customer") ? "fe@empresa.co" : null,
          supplier_email: kind.includes("supplier") ? "compras@empresa.co" : null,
          credit_limit: 1_000_000,
          dian_status: "complete",
          ...extra,
        })} returning id`;
      return row!.id;
    };
    await party("Almacenes Éxito S.A.", "890900608", ["customer"], { credit_limit: 5_000_000 });
    norteId = await party("Café del Norte S.A.S.", "900373115", ["customer", "supplier"]);
    await party("Tostadora Pérez", "800123456", ["supplier"], { dian_status: "missing: 1", dian_missing: ["Correo para enviar documentos al proveedor"] });
    for (let i = 0; i < 9; i++) await party(`Cliente de prueba ${i + 1}`, `90000000${i}`, ["customer"]);
    const [category] = await sql<{ id: string }[]>`
      insert into core.product_categories (company_id, name, iva_rate, default_uom) values (${companyId}, 'Café', '5', 'KGM') returning id`;
    const [product] = await sql<{ id: string }[]>`
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
        category_id: category!.id,
        dian_status: "complete",
      })} returning id`;
    productId = product!.id;
  });

  test.afterAll(async () => {
    const { sql } = fixture;
    for (const table of ["products", "product_categories", "party_contacts", "parties", "entity_sequences"]) {
      await sql`delete from ${sql(`core.${table}`)} where company_id = ${companyId}`;
    }
    await sql`delete from kernel.saved_views where company_id = ${companyId}`;
    await sql`delete from kernel.process_permissions where company_id = ${companyId}`;
    await sql`delete from kernel.tenant_entitlements where tenant_id = ${fixture.tenantId}`;
    await fixture.cleanup();
  });

  test("filters terceros by name, sorts, and opens a record in its own tab", async ({ page }) => {
    await page.emulateMedia({ colorScheme: "light" });
    await page.setViewportSize({ width: 1600, height: 900 });
    await signIn(page, fixture);
    await page.goto("/parties");
    const terceros = grid(page, "Terceros");
    await expect(terceros.getByRole("heading", { name: "Terceros" })).toBeVisible();
    // No page title: the grid header names the entity.
    await expect(page.getByRole("heading", { level: 1 })).toHaveCount(0);
    await expect(terceros.getByText("12 registros")).toBeVisible();
    await expect(bodyRows(page)).toHaveCount(10);
    await expect(terceros.getByText("Filas 1–10 de 12")).toBeVisible();
    await expect(terceros.getByRole("switch", { name: "Mostrar clientes" })).toBeVisible();
    // Money as $ 1.234.567,00, the export buttons and the pager.
    await expect(terceros.getByText("$ 5.000.000,00")).toBeVisible();
    await expect(terceros.getByRole("button", { name: "PDF" })).toBeVisible();
    await expect(terceros.getByRole("button", { name: "Excel" })).toBeVisible();
    await expect(terceros.getByRole("button", { name: "CSV" })).toBeVisible();
    await page.screenshot({ path: `${SCREENSHOTS}/grid-parties.png` });

    // Sorting by name, descending: Tostadora first.
    await terceros.getByRole("button", { name: "Ordenar por Razón social" }).click();
    await terceros.getByRole("button", { name: "Ordenar por Razón social" }).click();
    await expect(terceros.getByRole("columnheader", { name: /Razón social/ })).toHaveAttribute("aria-sort", "descending");
    await expect(bodyRows(page).first()).toContainText("Tostadora Pérez");

    // Switches: suppliers only.
    await terceros.getByRole("switch", { name: "Mostrar clientes" }).click();
    await expect(bodyRows(page)).toHaveCount(2);
    await terceros.getByRole("switch", { name: "Mostrar clientes" }).click();

    // Filter row: by name, on the server.
    await terceros.getByLabel("Filtrar Razón social").fill("norte");
    await expect(bodyRows(page)).toHaveCount(1);
    await expect(terceros.getByText("1 registro", { exact: true })).toBeVisible();

    // The record opens in its own tab, with the party form.
    await bodyRows(page).first().click();
    await expect(page).toHaveURL(new RegExp(`/r/core\\.party/${norteId}$`));
    const tabs = page.getByRole("navigation", { name: "Pestañas abiertas" });
    await expect(tabs.getByRole("button", { name: "Café del Norte S.A.S.", exact: true })).toHaveAttribute("aria-current", "page");
    await expect(tabs.getByRole("button", { name: "Terceros", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Identificación" })).toBeVisible();
    await expect(page.getByLabel("DV")).toHaveValue("3");
    await expect(page.getByLabel(/^Correo para enviar documentos al proveedor/)).toHaveValue("compras@empresa.co");
    await expect(page.getByText("Datos completos para facturación electrónica")).toBeVisible();
    await page.screenshot({ path: `${SCREENSHOTS}/record-party.png`, fullPage: true });

    // The grid's tab keeps its filter when we go back to it.
    await tabs.getByRole("button", { name: "Terceros", exact: true }).click();
    await expect(page).toHaveURL(/\/parties$/);
  });

  test("advanced filter: two conditions joined by O, live results and chips", async ({ page }) => {
    await signIn(page, fixture);
    await page.goto("/parties");
    const terceros = grid(page, "Terceros");
    await expect(bodyRows(page)).toHaveCount(10);
    await terceros.getByRole("button", { name: "Filtro avanzado" }).click();
    const dialog = page.getByRole("dialog", { name: "Filtro avanzado · Terceros" });
    const first = dialog.getByRole("group", { name: "Condición 1" });
    await first.getByLabel("Campo").selectOption("legal_name");
    await first.getByLabel("Valor").fill("éxito");
    await dialog.getByRole("button", { name: "+ Condición" }).click();
    const second = dialog.getByRole("group", { name: "Condición 2" });
    await second.getByLabel("Operador lógico").selectOption("or");
    await second.getByLabel("Campo").selectOption("legal_name");
    await second.getByLabel("Valor").fill("tostadora");
    await expect(dialog.getByRole("separator")).toHaveCount(1);
    const results = dialog.getByRole("region", { name: "Resultados" });
    await expect(results.getByText("Almacenes Éxito S.A.")).toBeVisible();
    await expect(results.getByText("Tostadora Pérez")).toBeVisible();
    await expect(dialog.getByText("2 registros cumplen las condiciones")).toBeVisible();
    await dialog.getByRole("button", { name: "Aplicar" }).click();

    const chips = terceros.getByRole("list", { name: "Condiciones activas" });
    await expect(chips.getByRole("listitem")).toHaveCount(2);
    await expect(chips.getByText("O", { exact: true })).toBeVisible();
    await expect(bodyRows(page)).toHaveCount(2);
    await expect(terceros.getByRole("button", { name: "Filtro avanzado (2)" })).toBeVisible();

    // Saved as a view, it comes back with the conditions.
    await terceros.getByRole("button", { name: "Guardar vista" }).click();
    await page.getByLabel("Nombre de la vista").fill("Éxito o Tostadora");
    await page.getByRole("group", { name: "Vistas" }).getByRole("button", { name: "Guardar" }).click();
    await expect(page.getByText("Vista guardada: Éxito o Tostadora")).toBeVisible();
    await expect
      .poll(async () => (await fixture.sql`select name from kernel.saved_views where company_id = ${companyId}`).map((r) => r.name))
      .toEqual(["Éxito o Tostadora"]);
  });

  test("Nuevo opens an empty party form that creates through core.party.create", async ({ page }) => {
    await signIn(page, fixture);
    await page.goto("/parties");
    await grid(page, "Terceros").getByRole("button", { name: "Nuevo" }).click();
    await expect(page).toHaveURL(/\/r\/core\.party\/new$/);
    await expect(page.getByRole("heading", { name: "Crear tercero" })).toBeVisible();
    await page.getByLabel(/^Número/).fill("860002964");
    await expect(page.getByLabel("DV")).toHaveValue("4");
    await page.getByLabel(/^Razón social/).fill("Distribuidora Andina S.A.S.");
    await page.getByLabel(/^Correo de recepción de facturas de venta/).fill("fe@andina.co");
    await page.getByRole("button", { name: "Crear", exact: true }).click();
    await expect(page).toHaveURL(/\/r\/core\.party\/[0-9a-f-]{36}$/);
    await expect(page.getByRole("heading", { name: "Distribuidora Andina S.A.S." })).toBeVisible();
    const [row] = await fixture.sql<{ check_digit: string; dian_status: string }[]>`
      select check_digit, dian_status from core.parties where company_id = ${companyId} and document_number = '860002964'`;
    expect(row).toMatchObject({ check_digit: "4" });
    expect(row!.dian_status).toMatch(/^missing: \d+$/);
  });

  test("the product form picks its supplier with the lookup and saves it", async ({ page }) => {
    await signIn(page, fixture);
    // The Productos and Categorías grids: category names, IVA labels and money as $ 31.000,00.
    await page.goto("/categories");
    await expect(grid(page, "Categorías").getByRole("cell", { name: "Café", exact: true })).toBeVisible();
    await page.goto("/products");
    const productos = grid(page, "Productos");
    await expect(bodyRows(page)).toHaveCount(1);
    await expect(bodyRows(page).first()).toContainText("Café en grano 500 g");
    await expect(bodyRows(page).first()).toContainText("$ 31.000,00");
    await expect(productos.getByRole("cell", { name: "Café", exact: true })).toBeVisible();
    await bodyRows(page).first().click();
    await expect(page).toHaveURL(new RegExp(`/r/core\\.product/${productId}$`));
    await expect(page.getByRole("heading", { name: "Café en grano 500 g" })).toBeVisible();
    await expect(page.getByText("heredados de Café")).toBeVisible();
    const lookup = page.getByRole("combobox", { name: "Proveedor principal" });
    await lookup.fill("norte");
    const options = page.getByRole("listbox", { name: "Proveedor principal" }).getByRole("option");
    // Only suppliers: Café del Norte is customer and supplier; Éxito is a customer only.
    await expect(options).toHaveCount(1);
    await expect(options.first()).toContainText("Café del Norte S.A.S.");
    await options.first().click();
    await expect(lookup).toHaveValue("Café del Norte S.A.S.");
    await page.getByRole("button", { name: "Guardar" }).click();
    await expect
      .poll(async () => (await fixture.sql`select supplier_id from core.products where id = ${productId}`)[0]?.supplier_id)
      .toBe(norteId);
    await page.reload();
    await expect(page.getByRole("combobox", { name: "Proveedor principal" })).toHaveValue("Café del Norte S.A.S.");
  });
});
