import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, test } from "../test-support/streamed";
import { cleanupCompanies } from "../test-support/company-cleanup";
import { enrolTotp, seedAuthUser, type AuthFixture } from "../test-support/auth-fixtures";
import { confirmStepUp, seedSmallLedger, signInWithCode, type SmallLedger } from "../test-support/accounting-fixture";

// The inventory pages (plan 2B Task 10, design §8, §9, entity types spec §9.2): a bodega created in its record; an entrada registered in
// the Movimientos record and read in Existencias (the masked inventory.v_stock_levels); a traslado that reads «En tránsito» after
// Despachar and «Recibido» after Recibir; a conteo whose Aplicar asks for the step-up code and posts one ajuste; the ajuste's record has
// the Contabilidad tab once accounting's consumer posted it (delivered here as the dispatch workflow's step would).

const PROCESSES = [
  "core.product.consult",
  "inventory.warehouse.create", "inventory.warehouse.update", "inventory.warehouse.consult",
  "inventory.location.create", "inventory.location.update", "inventory.location.consult",
  "inventory.movement.post", "inventory.movement.void", "inventory.movement.consult", "inventory.movement_line.consult", "inventory.stock_level.consult",
  "inventory.adjustment.post",
  "inventory.transfer.create", "inventory.transfer.ship", "inventory.transfer.receive", "inventory.transfer.void", "inventory.transfer.consult", "inventory.transfer_line.consult",
  "inventory.count.create", "inventory.count.record", "inventory.count.apply", "inventory.count.void", "inventory.count.consult", "inventory.count_line.consult",
  "costing.cost_layer.consult", "costing.cost_missing.consult", "costing.cost_event.consult",
  "costing.landed_cost.consult", "costing.landed_cost_line.consult", "costing.landed_cost.allocate", "costing.landed_cost.void",
  "costing.settings.consult", "costing.settings.update",
  "accounting.entry.consult", "accounting.settings.consult",
  "kernel.saved_view.list", "kernel.saved_view.save", "kernel.saved_view.delete", "kernel.custom_field.list", "kernel.attachment.list", "kernel.export.run",
];

const DELIVER = join(__dirname, "..", "test-support", "deliver-event.mts");
const RULE = JSON.parse(readFileSync(join(__dirname, "..", "..", "..", "packages", "modules", "accounting", "src", "rules", "defaults", "inventory-adjustment.json"), "utf8")) as {
  event: string;
  name: string;
  template: Record<string, unknown>;
};

const bar = (page: Page) => page.getByRole("group", { name: "Acciones del registro" });
const frame = (page: Page) => page.locator(".erp-record").filter({ visible: true });

test.describe("inventory pages", () => {
  test.describe.configure({ mode: "serial" });
  let fixture: AuthFixture;
  let secret: string;
  let companyId: string;
  let ledger: SmallLedger;
  let productId: string;
  let warehouseId = "";

  /** Delivers the movement's `inventory.movement.posted` event to `moduleId`'s consumer. */
  const deliver = async (movementId: string, moduleId: string) => {
    const [row] = await fixture.sql<{ id: string }[]>`
      select id from kernel.outbox where company_id = ${companyId} and event = 'inventory.movement.posted' and payload->>'movementId' = ${movementId}`;
    expect(row).toBeTruthy();
    execFileSync("pnpm", ["exec", "tsx", DELIVER, row!.id, moduleId], { cwd: join(__dirname, ".."), stdio: "pipe", env: process.env, timeout: 90_000 });
  };

  test.beforeAll(async () => {
    fixture = await seedAuthUser({ role: "admin" });
    secret = await enrolTotp(fixture);
    companyId = fixture.companyIds[0]!;
    const { sql } = fixture;
    for (const key of ["module:core", "module:accounting", "module:inventory", "module:costing"]) {
      await sql`insert into kernel.tenant_entitlements(tenant_id, key, source) values (${fixture.tenantId}, ${key}, 'manual')`;
    }
    const [role] = await sql<{ id: string }[]>`select id from kernel.roles where company_id = ${companyId} and name = 'admin'`;
    for (const process of PROCESSES) await sql`insert into kernel.process_permissions(company_id, role_id, process_id) values (${companyId}, ${role!.id}, ${process})`;
    ledger = await seedSmallLedger(fixture);
    // The month of today is open (an ajuste is dated the day it is applied), and the two roles of the adjustment rule have accounts.
    const [month] = await sql<{ starts_on: string; ends_on: string; number: number }[]>`
      select date_trunc('month', current_date)::date::text as starts_on, (date_trunc('month', current_date) + interval '1 month - 1 day')::date::text as ends_on,
             extract(month from current_date)::int as number`;
    if (month!.number !== 10) {
      await sql`insert into accounting.periods (company_id, fiscal_year_id, number, starts_on, ends_on) values (${companyId}, ${ledger.year}, ${month!.number}, ${month!.starts_on}, ${month!.ends_on})`;
    }
    const account = async (code: string, name: string, nature: "debit" | "credit") =>
      (await sql<{ id: string }[]>`insert into accounting.accounts (company_id, code, name, nature, allows_movement) values (${companyId}, ${code}, ${name}, ${nature}, true) returning id`)[0]!.id;
    const inventoryAccount = await account("143505", "Mercancías no fabricadas por la empresa", "debit");
    const adjustmentAccount = await account("429581", "Sobrantes de inventario", "credit");
    await sql`insert into accounting.account_role_mappings (company_id, role, account_id) values (${companyId}, 'inventory', ${inventoryAccount}), (${companyId}, 'inventory_adjustment', ${adjustmentAccount})`;
    await sql`
      insert into accounting.posting_rules (company_id, event, name, module, journal_id, template, priority, is_default)
      values (${companyId}, ${RULE.event}, ${RULE.name}, 'accounting', ${ledger.journal}, ${sql.json(RULE.template as never)}, 100, true)`;
    const [category] = await sql<{ id: string }[]>`insert into core.product_categories (company_id, name, iva_rate, default_uom) values (${companyId}, 'Café', '5', 'KGM') returning id`;
    const [product] = await sql<{ id: string }[]>`
      insert into core.products ${sql({
        company_id: companyId,
        sku: "INV-CAF-500",
        description: "Café de inventario 500 g",
        kind: "good",
        id_scheme: "999",
        uom_code: "KGM",
        iva_rate: "5",
        list_price: 31000,
        standard_cost: 7000,
        track_stock: true,
        category_id: category!.id,
        dian_status: "complete",
      })} returning id`;
    productId = product!.id;
  });

  test.afterAll(async () => {
    // Fix round 1: a failed beforeAll leaves no fixture; whatever the module cleanup does, the user, company and tenant still go.
    if (!fixture) return;
    try {
      await cleanupCompanies(fixture.sql, fixture.companyIds, fixture.tenantId);
    } finally {
      await fixture.cleanup();
    }
  });

  test("a bodega and an entrada created in their records; Existencias shows the stock of the entrada", async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await signInWithCode(page, fixture, secret);

    // Bodegas (Maestros): a new bodega saved with the bar's Guardar.
    await page.goto("/inventory/warehouses");
    await expect(page.getByRole("navigation", { name: "Menú del módulo" })).toBeVisible();
    await page.goto("/r/inventory.warehouse/new");
    await expect(page.getByRole("heading", { name: "Crear bodega" })).toBeVisible();
    await page.getByLabel(/^Código/).fill("PRIN");
    await page.getByLabel(/^Nombre/).fill("Bodega Principal");
    await bar(page).getByRole("button", { name: "Guardar", exact: true }).click();
    await expect(page).toHaveURL(/\/r\/inventory\.warehouse\/[0-9a-f-]{36}$/);
    await expect(page.getByRole("heading", { name: "Bodega Principal" })).toBeVisible();
    const [warehouse] = await fixture.sql<{ id: string; status: string }[]>`select id, status from inventory.warehouses where company_id = ${companyId} and code = 'PRIN'`;
    expect(warehouse!.status).toBe("saved");
    warehouseId = warehouse!.id;
    // The second bodega of the traslado.
    await fixture.sql`insert into inventory.warehouses (company_id, code, name, status) values (${companyId}, 'NORTE', 'Bodega Norte', 'saved')`;

    // Movimientos (Documentos): an entrada of 10 units at $ 7.000.
    await page.goto("/r/inventory.movement/new");
    await expect(page.getByRole("heading", { name: "Crear movimiento de inventario" })).toBeVisible();
    await page.getByLabel(/^Tipo/).selectOption({ label: "Entrada" });
    await page.getByLabel(/^Bodega/).selectOption({ label: "PRIN · Bodega Principal" });
    await page.getByRole("combobox", { name: "Producto, línea 1" }).fill("INV-CAF");
    await page.getByRole("option", { name: /INV-CAF-500/ }).first().click();
    await page.getByLabel("Cantidad, línea 1").fill("10");
    await page.getByLabel("Costo unitario, línea 1").fill("7000");
    await bar(page).getByRole("button", { name: "Guardar", exact: true }).click();
    await expect(page).toHaveURL(/\/r\/inventory\.movement\/[0-9a-f-]{36}$/);
    const [receipt] = await fixture.sql<{ id: string; number: string }[]>`select id, number from inventory.movements where company_id = ${companyId} and kind = 'receipt'`;
    expect(receipt!.number).toMatch(/^EN-/);
    await expect(frame(page).getByText(receipt!.number, { exact: true }).first()).toBeVisible();
    // The lines read in the universal grid (rule 20).
    await expect(frame(page).locator("section.erp-grid tbody tr")).toHaveCount(1);

    // Existencias (Reportes): the grid over the masked view shows the 10 units in Bodega Principal.
    await page.goto("/inventory/stock");
    const stock = page.locator("section.erp-grid").filter({ visible: true });
    const row = stock.getByRole("row", { name: /Café de inventario 500 g/ });
    await expect(row).toContainText("Bodega Principal");
    await expect(row).toContainText("10");

    // Capas de costo (Costos › Reportes): the costing consumer values the entrada into the layer of the bodega.
    await deliver(receipt!.id, "costing");
    await page.goto("/costing/layers");
    await expect(page.locator("section.erp-grid").filter({ visible: true }).getByRole("row", { name: /Café de inventario 500 g/ })).toContainText("Bodega Principal");
  });

  test("a traslado reads En tránsito after Despachar and Recibido after Recibir", async ({ page }) => {
    test.setTimeout(120_000);
    expect(warehouseId).not.toBe("");
    await page.setViewportSize({ width: 1440, height: 900 });
    await signInWithCode(page, fixture, secret);
    await page.goto("/r/inventory.transfer/new");
    await expect(page.getByRole("heading", { name: "Crear traslado de inventario" })).toBeVisible();
    await page.getByLabel(/^Bodega de origen/).selectOption({ label: "PRIN · Bodega Principal" });
    await page.getByLabel(/^Bodega de destino/).selectOption({ label: "NORTE · Bodega Norte" });
    await page.getByRole("combobox", { name: "Producto, línea 1" }).fill("INV-CAF");
    await page.getByRole("option", { name: /INV-CAF-500/ }).first().click();
    await page.getByLabel("Cantidad, línea 1").fill("4");
    await bar(page).getByRole("button", { name: "Guardar", exact: true }).click();
    await expect(page).toHaveURL(/\/r\/inventory\.transfer\/[0-9a-f-]{36}$/);
    const stage = async () => (await fixture.sql<{ stage: string }[]>`select stage from inventory.transfers where company_id = ${companyId}`)[0]!.stage;
    expect(await stage()).toBe("requested");
    await expect(frame(page).getByTestId("transfer-stage")).toHaveText("Solicitado");

    await frame(page).getByRole("button", { name: "Despachar", exact: true }).click();
    await expect(frame(page).getByTestId("transfer-stage")).toHaveText("En tránsito");
    expect(await stage()).toBe("in_transit");

    await frame(page).getByRole("button", { name: "Recibir", exact: true }).click();
    await expect(frame(page).getByTestId("transfer-stage")).toHaveText("Recibido");
    expect(await stage()).toBe("received");

    // Existencias: 6 left in Principal, 4 in Norte.
    await page.goto("/inventory/stock");
    const stock = page.locator("section.erp-grid").filter({ visible: true });
    await expect(stock.getByRole("row", { name: /Bodega Norte/ })).toContainText("4");
  });

  test("a conteo applies its difference as one ajuste behind step-up; the ajuste's record has the Contabilidad tab", async ({ page }) => {
    test.setTimeout(180_000);
    expect(warehouseId).not.toBe("");
    await page.setViewportSize({ width: 1440, height: 900 });
    await signInWithCode(page, fixture, secret);
    await page.goto("/r/inventory.count/new");
    await expect(page.getByRole("heading", { name: "Crear conteo físico" })).toBeVisible();
    await page.getByLabel(/^Bodega/).selectOption({ label: "PRIN · Bodega Principal" });
    await page.getByRole("combobox", { name: "Producto, línea 1" }).fill("INV-CAF");
    await page.getByRole("option", { name: /INV-CAF-500/ }).first().click();
    await bar(page).getByRole("button", { name: "Guardar", exact: true }).click();
    await expect(page).toHaveURL(/\/r\/inventory\.count\/[0-9a-f-]{36}$/);

    // Registrar conteo: 5 counted where the system holds 6.
    await frame(page).getByLabel("Cantidad contada, línea 1").fill("5");
    await frame(page).getByRole("button", { name: "Registrar conteo", exact: true }).click();
    await expect(frame(page).getByTestId("count-difference-1")).toHaveText("-1");

    // Aplicar conteo: a sensitive process, it asks for the code first.
    await frame(page).getByRole("button", { name: "Aplicar conteo", exact: true }).click();
    await confirmStepUp(page, secret);
    await expect(frame(page).getByTestId("count-stage")).toHaveText("Aplicado");
    const [count] = await fixture.sql<{ stage: string; adjustment_id: string }[]>`select stage, adjustment_id from inventory.counts where company_id = ${companyId}`;
    expect(count!.stage).toBe("applied");
    const [adjustment] = await fixture.sql<{ id: string; number: string; kind: string }[]>`select id, number, kind from inventory.movements where id = ${count!.adjustment_id}`;
    expect(adjustment!.kind).toBe("adjustment");

    // Accounting posts the ajuste from its event; its record then shows the comprobante in the Contabilidad tab.
    await deliver(adjustment!.id, "accounting");
    const [entry] = await fixture.sql<{ id: string }[]>`select id from accounting.entries where company_id = ${companyId} and source_entity = 'inventory.movement' and source_record_id = ${adjustment!.id}`;
    expect(entry).toBeTruthy();
    await frame(page).getByRole("link", { name: adjustment!.number }).click();
    await expect(page).toHaveURL(new RegExp(`/r/inventory\\.movement/${adjustment!.id}$`));
    await page.getByRole("tab", { name: /Contabilidad/ }).click();
    await expect(page.getByRole("tabpanel", { name: /Contabilidad/ }).locator("tbody tr")).toHaveCount(1);

    // Existencias: 5 left in Principal.
    const [level] = await fixture.sql<{ on_hand: string }[]>`select on_hand from inventory.stock_levels where company_id = ${companyId} and warehouse_id = ${warehouseId} and product_id = ${productId}`;
    expect(Number(level!.on_hand)).toBe(5);
  });

  test("Costos: Costeo saves the method behind step-up and refuses PEPS until phase 3; Costos pendientes and Costos en destino open", async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await signInWithCode(page, fixture, secret);
    await page.goto("/costing/settings");
    await expect(page.getByRole("heading", { name: "Método de costeo" })).toBeVisible();
    await page.getByRole("button", { name: "Guardar", exact: true }).click();
    await confirmStepUp(page, secret);
    await expect(page.getByRole("status").filter({ hasText: "Guardado" })).toBeVisible();
    expect((await fixture.sql<{ method: string }[]>`select method from costing.settings where company_id = ${companyId}`)[0]?.method).toBe("average");
    await page.getByLabel("Método").selectOption("fifo");
    await page.getByRole("button", { name: "Guardar", exact: true }).click();
    await confirmStepUp(page, secret);
    await expect(page.getByRole("alert").filter({ hasText: "fase 3" })).toBeVisible();

    await page.goto("/costing/missing");
    await expect(page.locator("section.erp-grid").filter({ visible: true })).toBeVisible();
    await page.goto("/r/costing.landed_cost/new");
    await expect(page.getByRole("heading", { name: "Crear costo en destino" })).toBeVisible();
    await expect(page.getByRole("combobox", { name: "Entrada de mercancía" })).toBeVisible();
  });
});
