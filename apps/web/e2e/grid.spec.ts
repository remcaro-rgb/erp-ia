import { readFile } from "node:fs/promises";
import type { Page } from "@playwright/test";
import { expect, test } from "../test-support/streamed";
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
  "kernel.export.run",
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
    // Six customers in Medellín, the rest in Bogotá: the Municipio column shows DANE names over stored codes.
    for (let i = 0; i < 9; i++) await party(`Cliente de prueba ${i + 1}`, `90000000${i}`, ["customer"], i < 6 ? { department_code: "05", municipality_code: "05001" } : {});
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
    await expect(page.getByLabel("DV", { exact: true }).filter({ visible: true })).toHaveValue("3");
    await expect(page.getByLabel(/^Correo para enviar documentos al proveedor/)).toHaveValue("compras@empresa.co");
    await expect(page.getByText("Datos completos para facturación electrónica")).toBeVisible();
    await page.screenshot({ path: `${SCREENSHOTS}/record-party.png`, fullPage: true });

    // The grid's tab keeps its filter when we go back to it.
    await tabs.getByRole("button", { name: "Terceros", exact: true }).click();
    await expect(page).toHaveURL(/\/parties$/);
  });

  test("works from the keyboard: one tab stop for the rows, arrows, Space selects, Enter opens, / goes to the filters", async ({ page }) => {
    await signIn(page, fixture);
    await page.goto("/parties");
    const terceros = grid(page, "Terceros");
    await expect(bodyRows(page)).toHaveCount(10);
    // Only one row is in the tab order and no row checkbox is.
    await expect(page.locator(".erp-grid__body tbody tr[tabindex='0']")).toHaveCount(1);
    await expect(page.locator(".erp-grid__body tbody input[type=checkbox][tabindex='-1']")).toHaveCount(10);
    // Tab from the last filter lands on the rows.
    await terceros.getByRole("row", { name: "Filtros" }).locator("input:not([disabled]), select").last().focus();
    await page.keyboard.press("Tab");
    await expect(bodyRows(page).first()).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(bodyRows(page).nth(1)).toBeFocused();
    await page.keyboard.press("End");
    await expect(bodyRows(page).nth(9)).toBeFocused();
    await page.keyboard.press("Home");
    await page.keyboard.press("Space");
    await expect(bodyRows(page).first()).toHaveAttribute("aria-selected", "true");
    await expect(terceros.getByText("1 seleccionada")).toBeVisible();
    // "/" goes to the first filter; typing there filters on the server.
    await page.keyboard.press("/");
    await expect(terceros.getByRole("row", { name: "Filtros" }).locator("input:not([disabled]), select").first()).toBeFocused();
    await terceros.getByLabel("Filtrar Razón social").fill("norte");
    await expect(bodyRows(page)).toHaveCount(1);
    // From the last filter, a real Tab reaches the (only) row; Enter opens the record.
    await terceros.getByRole("row", { name: "Filtros" }).locator("input:not([disabled]), select").last().focus();
    await page.keyboard.press("Tab");
    await expect(bodyRows(page).first()).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(new RegExp(`/r/core\\.party/${norteId}$`));
  });

  test("exports what the grid shows to CSV, Excel and PDF, all pages and only the filtered rows", async ({ page }) => {
    await signIn(page, fixture);
    await page.goto("/parties");
    const terceros = grid(page, "Terceros");
    await expect(bodyRows(page)).toHaveCount(10);
    const download = async (name: string) => {
      const [file] = await Promise.all([page.waitForEvent("download"), terceros.getByRole("button", { name, exact: true }).click()]);
      return { name: file.suggestedFilename(), bytes: await readFile((await file.path())!) };
    };

    // CSV: the page shows 10 of 12 rows, the file has all 12; the BOM, ; and the Spanish headers.
    const csv = await download("CSV");
    expect(csv.name).toMatch(/^terceros-\d{4}-\d{2}-\d{2}\.csv$/);
    const text = csv.bytes.toString("utf8");
    expect(text.startsWith("\uFEFF")).toBe(true);
    const lines = text.slice(1).split("\r\n").filter(Boolean);
    expect(lines).toHaveLength(13);
    expect(lines[0]).toContain('"Razón social"');
    expect(lines.join("\n")).toContain("Almacenes Éxito S.A.");
    await expect(terceros.getByRole("status")).toHaveText(/Descarga lista: terceros-/);

    // With a filter on screen, Excel and PDF carry that filter only.
    await terceros.getByLabel("Filtrar Razón social").fill("norte");
    await expect(bodyRows(page)).toHaveCount(1);
    const xlsx = await download("Excel");
    expect(xlsx.name).toMatch(/\.xlsx$/);
    expect(xlsx.bytes.subarray(0, 2).toString("latin1")).toBe("PK");
    const pdf = await download("PDF");
    expect(pdf.name).toMatch(/\.pdf$/);
    expect(pdf.bytes.subarray(0, 4).toString("latin1")).toBe("%PDF");

    const filtered = await download("CSV");
    expect(filtered.bytes.toString("utf8").slice(1).split("\r\n").filter(Boolean)).toHaveLength(2);
    // Each export is an audited consult of the caller.
    const audit = await fixture.sql`select action from kernel.audit_log where company_id = ${companyId} and process_id = 'kernel.export.run'`;
    expect(audit).toHaveLength(4);
    expect(audit.every((a) => a.action === "consult")).toBe(true);
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
    await page.getByRole("group", { name: "Vistas" }).getByRole("button", { name: "Guardar", exact: true }).click();
    await expect(page.getByText("Vista guardada: Éxito o Tostadora")).toBeVisible();
    await expect
      .poll(async () => (await fixture.sql`select name from kernel.saved_views where company_id = ${companyId}`).map((r) => r.name))
      .toEqual(["Éxito o Tostadora"]);
  });

  test("a coded column filters by the label it shows: Municipio contiene Medell (rule 20)", async ({ page }) => {
    await signIn(page, fixture);
    await page.goto("/parties");
    const terceros = grid(page, "Terceros");
    await expect(bodyRows(page)).toHaveCount(10);
    // The cell shows the DANE name; the filter row takes that name, without the accent, and still the code.
    await terceros.getByLabel("Filtrar Municipio").fill("Medell");
    await expect(terceros.getByText("6 registros", { exact: true })).toBeVisible();
    await expect(bodyRows(page)).toHaveCount(6);
    await expect(bodyRows(page).first()).toContainText("Medellín");
    await terceros.getByLabel("Filtrar Municipio").fill("medellin");
    await expect(terceros.getByText("6 registros", { exact: true })).toBeVisible();
    await terceros.getByLabel("Filtrar Municipio").fill("05001");
    await expect(terceros.getByText("6 registros", { exact: true })).toBeVisible();
    await terceros.getByLabel("Filtrar Municipio").fill("");
    await expect(terceros.getByText("12 registros", { exact: true })).toBeVisible();

    // The advanced filter goes through the same translation: Bogotá O Medellín is every party.
    await terceros.getByRole("button", { name: "Filtro avanzado" }).click();
    const dialog = page.getByRole("dialog", { name: "Filtro avanzado · Terceros" });
    const first = dialog.getByRole("group", { name: "Condición 1" });
    await first.getByLabel("Campo").selectOption("municipality_code");
    await first.getByLabel("Valor").fill("Bogotá");
    await dialog.getByRole("button", { name: "+ Condición" }).click();
    const second = dialog.getByRole("group", { name: "Condición 2" });
    await second.getByLabel("Operador lógico").selectOption("or");
    await second.getByLabel("Campo").selectOption("municipality_code");
    await second.getByLabel("Valor").fill("Medellín");
    await expect(dialog.getByText("12 registros cumplen las condiciones")).toBeVisible();
    await dialog.getByRole("button", { name: "Aplicar" }).click();
    await expect(terceros.getByText("12 registros", { exact: true })).toBeVisible();
    // The chips read as typed: the label, not a list of codes.
    const chips = terceros.getByRole("list", { name: "Condiciones activas" });
    await expect(chips.getByText(/Municipio contiene Bogotá/)).toBeVisible();
    await expect(chips.getByText(/Municipio contiene Medellín/)).toBeVisible();
  });

  test("columns move by dragging a header or with Alt+→, the identity column stays pinned, totals sit under Cupo, and a saved view keeps the order", async ({ page }) => {
    // Narrow enough for the fourteen columns to scroll sideways.
    await page.setViewportSize({ width: 1000, height: 800 });
    await signIn(page, fixture);
    await page.goto("/parties");
    const terceros = grid(page, "Terceros");
    await expect(bodyRows(page)).toHaveCount(10);
    const headers = async () => (await terceros.locator("thead tr").first().locator("th").allTextContents()).slice(1).map((h) => h.replace(/[▲▼↕]/g, "").trim());
    // OD-4: the identity column (Razón social) comes first, after the selection column.
    expect((await headers()).slice(0, 3)).toEqual(["Razón social", "N.º", "Tipo de documento"]);

    // Drag Municipio onto the left half of N.º: it lands in position 2 and the status row says so.
    const header = (field: string) => terceros.locator(`thead tr:first-child th[data-field="${field}"]`);
    await header("municipality_code").dragTo(header("seq"), { targetPosition: { x: 4, y: 12 } });
    await expect(terceros.getByRole("status")).toHaveText("Columna Municipio movida a la posición 2");
    expect((await headers()).slice(0, 3)).toEqual(["Razón social", "Municipio", "N.º"]);
    // Alt+→ on a focused header moves it one place and keeps the caret on it.
    await terceros.getByRole("button", { name: "Ordenar por N.º" }).focus();
    await page.keyboard.press("Alt+ArrowRight");
    await expect(terceros.getByRole("status")).toHaveText("Columna N.º movida a la posición 4");
    await expect(terceros.getByRole("button", { name: "Ordenar por N.º" })).toBeFocused();
    expect((await headers()).slice(0, 4)).toEqual(["Razón social", "Municipio", "Tipo de documento", "N.º"]);

    // Scrolled all the way right, the selection and identity columns stay at the left edge, with a shadow.
    const body = terceros.locator(".erp-grid__body");
    await body.evaluate((el) => el.scrollTo({ left: el.scrollWidth }));
    await expect(body).toHaveAttribute("data-scrolled-x", "");
    const bodyBox = (await body.boundingBox())!;
    const identity = bodyRows(page).first().locator("td.erp-grid__id");
    await expect(identity).toBeVisible();
    expect(Math.abs((await identity.boundingBox())!.x - (bodyBox.x + 36))).toBeLessThan(2);
    // OD-5: the filter's total of Cupo (every page) sits under Cupo in the sticky tfoot, "Suma" in the identity cell.
    await expect(terceros.locator("tfoot td.erp-grid__id")).toHaveText("Suma");
    const cupo = await terceros.locator("thead tr:first-child th").evaluateAll((ths) => ths.findIndex((th) => th.getAttribute("data-field") === "credit_limit"));
    await expect(terceros.locator("tfoot td").nth(cupo)).toHaveText("$ 16.000.000,00");
    await page.screenshot({ path: `${SCREENSHOTS}/grid-pinned-scrolled.png` });

    // Saved as the default view, the order comes back after a reload.
    await terceros.getByRole("button", { name: "Guardar vista" }).click();
    await page.getByLabel("Nombre de la vista").fill("Municipio primero");
    await page.getByLabel("Usarla como vista por defecto").check();
    await page.getByRole("group", { name: "Vistas" }).getByRole("button", { name: "Guardar", exact: true }).click();
    await expect(page.getByText("Vista guardada: Municipio primero")).toBeVisible();
    await page.reload();
    await expect(bodyRows(page)).toHaveCount(10);
    expect((await headers()).slice(0, 4)).toEqual(["Razón social", "Municipio", "Tipo de documento", "N.º"]);
    // The other specs of this file start from the default columns.
    await fixture.sql`delete from kernel.saved_views where company_id = ${companyId} and name = 'Municipio primero'`;
  });

  test("Nuevo opens an empty party form that creates through core.party.create", async ({ page }) => {
    await signIn(page, fixture);
    await page.goto("/parties");
    await grid(page, "Terceros").getByRole("button", { name: "Nuevo" }).click();
    await expect(page).toHaveURL(/\/r\/core\.party\/new$/);
    await expect(page.getByRole("heading", { name: "Crear tercero" })).toBeVisible();
    await page.getByLabel(/^Número/).fill("860002964");
    await expect(page.getByLabel("DV", { exact: true }).filter({ visible: true })).toHaveValue("4");
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

  test("Ctrl+S saves the party form, and a refusal puts the caret on what to fix", async ({ page }) => {
    await signIn(page, fixture);
    await page.goto("/r/core.party/new");
    await expect(page.getByRole("heading", { name: "Crear tercero" })).toBeVisible();
    await page.getByLabel(/^Número/).fill("830114921");
    await page.getByLabel(/^Razón social/).fill("Molinos del Atlántico S.A.S.");
    await page.getByLabel(/^Correo de recepción de facturas de venta/).fill("fe@molinos.co");
    // Enter in a text box does not submit; Ctrl+S does, from any field.
    await page.getByLabel(/^Razón social/).press("Enter");
    await expect(page).toHaveURL(/\/r\/core\.party\/new$/);
    await page.getByLabel(/^Razón social/).press("Control+s");
    await expect(page).toHaveURL(/\/r\/core\.party\/[0-9a-f-]{36}$/);
    await expect(page.getByRole("heading", { name: "Molinos del Atlántico S.A.S." })).toBeVisible();
    // The same document again: the process refuses it, and the caret lands on the summary that says why.
    await page.goto("/r/core.party/new");
    await page.getByLabel(/^Número/).fill("830114921");
    await page.getByLabel(/^Razón social/).fill("Molinos Duplicados S.A.S.");
    await page.getByLabel(/^Correo de recepción de facturas de venta/).fill("fe@duplicado.co");
    await page.getByLabel(/^Número/).press("Control+Enter");
    await expect(page.locator("[data-error-summary]")).toBeFocused();
    // One alert speaks for the form (the page's route announcer is the other alert on the page).
    await expect(page.locator("form.erp-form").getByRole("alert")).toHaveCount(1);
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
    await page.getByRole("button", { name: "Guardar", exact: true }).click();
    await expect
      .poll(async () => (await fixture.sql`select supplier_id from core.products where id = ${productId}`)[0]?.supplier_id)
      .toBe(norteId);
    await page.reload();
    await expect(page.getByRole("combobox", { name: "Proveedor principal" })).toHaveValue("Café del Norte S.A.S.");
    // The chosen supplier links to its page beside the magnifier (rule 21).
    await expect(page.getByRole("link", { name: "Abrir Café del Norte S.A.S." })).toHaveAttribute("href", `/r/core.party/${norteId}`);
  });

  test("the supplier on the Productos grid is a link to the party's record (rule 21)", async ({ page }) => {
    await fixture.sql`update core.products set supplier_id = ${norteId} where id = ${productId}`;
    await signIn(page, fixture);
    await page.goto("/products");
    const productos = grid(page, "Productos");
    await expect(bodyRows(page)).toHaveCount(1);
    // The Categoría shown by default is a link, out of the tab order: Tab from the row leaves the table in one stop.
    await expect(productos.getByRole("link", { name: "Café", exact: true })).toHaveAttribute("tabindex", "-1");
    await bodyRows(page).first().focus();
    await page.keyboard.press("Tab");
    const landed = await page.evaluate(() => {
      const active = document.activeElement;
      return { inBody: Boolean(active?.closest(".erp-grid__body")), inGrid: Boolean(active?.closest("section.erp-grid")) };
    });
    expect(landed).toEqual({ inBody: false, inGrid: true });
    // Proveedor is in the column chooser; shown, it names the party by its legal name and links to its page.
    await productos.getByRole("button", { name: "Columnas" }).click();
    await page.getByRole("group", { name: "Columnas" }).getByLabel("Proveedor", { exact: true }).check();
    await page.keyboard.press("Escape");
    const link = productos.getByRole("link", { name: "Café del Norte S.A.S." });
    await expect(link).toHaveAttribute("href", `/r/core.party/${norteId}`);
    await link.click();
    await expect(page).toHaveURL(new RegExp(`/r/core\\.party/${norteId}$`));
    await expect(page.getByRole("heading", { name: "Café del Norte S.A.S." })).toBeVisible();
  });
});

