import type { Page } from "@playwright/test";
import postgres from "postgres";
import { expect, test } from "../test-support/streamed";
import { DEMO_COMPANY_ID, LAURA } from "../../../scripts/demo/accounts";
import { LOT_PRODUCT, SERIAL_PRODUCT } from "../../../scripts/demo/lots";
import { totpCode } from "../test-support/auth-fixtures";
import { testEnv } from "../test-support/env";

// The forms of lots, serials and tracking, and the found rows of a count, end to end (plan 2B.2 Task 28.5, Part G design PG §3.1, §3.2;
// rules 15, 21, 37) on the demo company, signed in as Laura (admin):
//   (5) Lotes › Nuevo: a lot of «Café molido tradicional 500 g» with its expiry saves and opens its record; Duplicar opens a copy without
//       the code; blocking the lot reads «Bloqueado»;
//   (6) Seriales › Nuevo: a serial of the grinder saves;
//   (7) Seguimiento por producto: changing the tracking of a product asks for the second factor; one with stock answers tracking_has_stock;
//   (8) a lot on a movement line and the recall report's heading link to the lot's record (rule 21);
//   (9) a conteo of Bodega Principal: «Agregar encontrado» with a new lot code and 5 units, «Registrar conteo» lists the new line with its
//       lot, «Aplicar conteo» posts the ajuste line of +5 in that lot.
// The spec runs on the shared demo: each run uses codes of its own (…-E2E-<time>).

const sql = postgres(testEnv().DATABASE_URL, { max: 2, onnotice: () => {} });

const bar = (page: Page) => page.getByRole("group", { name: "Acciones del registro" });
const frame = (page: Page) => page.locator(".erp-record").filter({ visible: true });
const stamp = () => Date.now().toString(36).toUpperCase();

let today = "";

async function signIn(page: Page) {
  await page.context().clearCookies();
  await page.goto("/login");
  await page.getByLabel("Correo").fill(LAURA.email);
  await page.getByLabel("Contraseña", { exact: true }).fill(LAURA.password);
  await page.getByRole("button", { name: "Entrar" }).click();
  await page.waitForURL(/\/(mfa\/verify)?$/);
  if (page.url().endsWith("/mfa/verify")) {
    // The code's inputs hydrate after the page loads (the dev server compiles it on first use).
    await page.waitForLoadState("networkidle");
    await page.getByLabel("Dígito 1").fill(totpCode(LAURA.totpSecret!));
  }
  await expect(page).toHaveURL(/\/$/, { timeout: 15_000 });
}

/** Answers the step-up prompt the last action opened with Laura's current code. */
async function confirmStepUp(page: Page) {
  const code = page.getByLabel("Código de 6 dígitos");
  await expect(code).toBeFocused({ timeout: 15_000 });
  await code.fill(totpCode(LAURA.totpSecret!));
}

const days = (n: number) => new Date(Date.parse(`${today}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

test.describe("inventory lot, serial and tracking forms", () => {
  test.describe.configure({ mode: "serial" });

  test.beforeAll(async () => {
    const [clock] = await sql<{ today: string }[]>`select (now() at time zone 'America/Bogota')::date::text as today`;
    today = clock!.today;
  });

  test.afterAll(async () => {
    await sql.end();
  });

  test("(5) a lot created from Lotes › Nuevo opens its record; Duplicar copies it without the code; blocking it reads Bloqueado", async ({ page }) => {
    test.setTimeout(180_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await signIn(page);
    const code = `L-E2E-${stamp()}`;
    const expires = days(200);

    await page.goto("/inventory/lots");
    await page.getByRole("button", { name: "Nuevo", exact: true }).first().click();
    await expect(page).toHaveURL(/\/r\/inventory\.lot\/new$/);
    await expect(page.getByRole("heading", { name: "Crear lote" })).toBeVisible();
    const productSelect = frame(page).getByLabel(/^Producto/);
    const option = await productSelect.locator("option", { hasText: LOT_PRODUCT.sku }).first().getAttribute("value");
    await productSelect.selectOption(option!);
    await frame(page).getByLabel(/^Código del lote/).fill(code);
    await frame(page).getByLabel("Vence", { exact: true }).fill(expires);
    await frame(page).getByLabel("Nota", { exact: true }).fill("Lote de la prueba de formularios");
    await bar(page).getByRole("button", { name: "Guardar", exact: true }).click();
    await expect(page).toHaveURL(/\/r\/inventory\.lot\/[0-9a-f-]{36}$/);
    const lotId = page.url().split("/").pop()!;
    const [stored] = await sql<{ code: string; expires_on: string; lot_status: string }[]>`select code, expires_on::text, lot_status from inventory.lots where id = ${lotId}`;
    expect(stored).toEqual({ code, expires_on: expires, lot_status: "active" });
    await expect(page.getByRole("heading", { name: code })).toBeVisible();
    // The product and the code are fixed once stored.
    await expect(frame(page).getByLabel(/^Código del lote/)).toBeDisabled();

    // Duplicar (rule 37): a new lot of the same product with the same dates and note; the code starts empty.
    await bar(page).getByRole("button", { name: "Duplicar", exact: true }).click();
    await expect(page).toHaveURL(/\/r\/inventory\.lot\/new$/);
    await expect(frame(page).getByLabel(/^Código del lote/)).toHaveValue("");
    await expect(frame(page).getByLabel("Vence", { exact: true })).toHaveValue(expires);
    await expect(frame(page).getByLabel("Nota", { exact: true })).toHaveValue("Lote de la prueba de formularios");
    await expect(frame(page).getByLabel(/^Producto/)).toHaveValue(option!);

    // Blocking the lot: Estado del lote › Bloqueado, saved; FEFO skips it from now on.
    await page.goto(`/r/inventory.lot/${lotId}`);
    await frame(page).getByLabel(/^Estado del lote/).selectOption({ label: "Bloqueado" });
    await bar(page).getByRole("button", { name: "Guardar", exact: true }).click();
    await expect.poll(async () => (await sql<{ lot_status: string }[]>`select lot_status from inventory.lots where id = ${lotId}`)[0]!.lot_status).toBe("blocked");
    await page.reload();
    await expect(frame(page).getByLabel(/^Estado del lote/).locator("option:checked")).toHaveText("Bloqueado");
    await page.goto("/inventory/lots");
    const lots = page.locator("section.erp-grid").filter({ visible: true });
    await lots.getByLabel("Filtrar Código").fill(code);
    await expect(lots.getByRole("row", { name: new RegExp(code) })).toContainText("Bloqueado");
  });

  test("(6) a serial of the grinder created from Seriales › Nuevo saves", async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await signIn(page);
    const serialNo = `MOL-E2E-${stamp()}`;
    await page.goto("/inventory/serials");
    await page.getByRole("button", { name: "Nuevo", exact: true }).first().click();
    await expect(page.getByRole("heading", { name: "Crear serial" })).toBeVisible();
    const productSelect = frame(page).getByLabel(/^Producto/);
    await productSelect.selectOption((await productSelect.locator("option", { hasText: SERIAL_PRODUCT.sku }).first().getAttribute("value"))!);
    await frame(page).getByLabel(/^Número de serie/).fill(serialNo);
    await bar(page).getByRole("button", { name: "Guardar", exact: true }).click();
    await expect(page).toHaveURL(/\/r\/inventory\.serial\/[0-9a-f-]{36}$/);
    const [stored] = await sql<{ serial_no: string; sku: string }[]>`
      select s.serial_no, p.sku from inventory.serials s join core.products p on p.id = s.product_id where s.id = ${page.url().split("/").pop()!}`;
    expect(stored).toEqual({ serial_no: serialNo, sku: SERIAL_PRODUCT.sku });
    await expect(page.getByRole("heading", { name: serialNo })).toBeVisible();
  });

  test("(7) changing a product's tracking asks for the second factor; a product with stock answers tracking_has_stock", async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await signIn(page);
    const [row] = await sql<{ id: string; description: string }[]>`
      select t.id, p.description from inventory.product_tracking t join core.products p on p.id = t.product_id where t.company_id = ${DEMO_COMPANY_ID} and p.sku = ${LOT_PRODUCT.sku}`;
    await page.goto("/inventory/product-tracking");
    // The row is named by its product (a link to the product's own page); a click on the row opens the seguimiento's record.
    await page.locator("section.erp-grid").filter({ visible: true }).getByRole("row", { name: new RegExp(row!.description) }).first().getByText("Por lote").click();
    await expect(page).toHaveURL(new RegExp(`/r/inventory\\.product_tracking/${row!.id}$`));
    await frame(page).getByLabel(/^Seguimiento \*/).selectOption({ label: "Sin seguimiento" });
    // A parametro has no lifecycle bar: the frame's header saves it.
    await frame(page).getByRole("button", { name: "Guardar cambios", exact: true }).click();
    // inventory.product_tracking.set is sensitive (rule 15): the code first, then the process refuses (the product has stock).
    await confirmStepUp(page);
    await expect(frame(page).getByRole("alert").filter({ hasText: "sácalas antes de cambiar su seguimiento" })).toBeVisible({ timeout: 15_000 });
    const [after] = await sql<{ tracking: string }[]>`select tracking from inventory.product_tracking where id = ${row!.id}`;
    expect(after!.tracking).toBe("lot");
  });

  test("(8) a lot on a movement line and the recall report's heading open the lot's record (rule 21)", async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await signIn(page);
    const [lot] = await sql<{ id: string }[]>`
      select l.id from inventory.lots l join core.products p on p.id = l.product_id where l.company_id = ${DEMO_COMPANY_ID} and p.sku = ${LOT_PRODUCT.sku} and l.code = ${LOT_PRODUCT.lots[0].code}`;
    const [receipt] = await sql<{ id: string }[]>`
      select m.id from inventory.movements m join inventory.movement_lines ml on ml.movement_id = m.id
      where m.company_id = ${DEMO_COMPANY_ID} and m.kind = 'receipt' and ml.lot_id = ${lot!.id} order by m.seq limit 1`;
    await page.goto(`/r/inventory.movement/${receipt!.id}`);
    const lines = frame(page).locator("section.erp-grid").filter({ visible: true }).first();
    await lines.getByRole("link", { name: LOT_PRODUCT.lots[0].code, exact: true }).first().click();
    await expect(page).toHaveURL(new RegExp(`/r/inventory\\.lot/${lot!.id}$`));
    await expect(page.getByRole("heading", { name: LOT_PRODUCT.lots[0].code })).toBeVisible();

    await page.goto(`/inventory/lot-trace?p=${encodeURIComponent(JSON.stringify({ lotId: lot!.id }))}`);
    const heading = page.getByTestId("lot-trace-subject");
    await expect(heading).toContainText(LOT_PRODUCT.lots[0].code);
    await heading.getByRole("link", { name: LOT_PRODUCT.lots[0].code }).click();
    await expect(page).toHaveURL(new RegExp(`/r/inventory\\.lot/${lot!.id}$`));
  });

  test("(9) a conteo: Agregar encontrado with a new lot and 5 units, Registrar conteo lists it, Aplicar conteo posts +5 in that lot", async ({ page }) => {
    test.setTimeout(240_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await signIn(page);
    const code = `L-ENC-${stamp()}`;
    const expires = days(120);

    await page.goto("/r/inventory.count/new");
    await expect(page.getByRole("heading", { name: "Crear conteo físico" })).toBeVisible();
    await page.getByRole("combobox", { name: /^Bodega/ }).selectOption({ label: "PRIN · Bodega Principal" });
    await page.getByRole("combobox", { name: "Producto, línea 1" }).fill(LOT_PRODUCT.sku);
    await page.getByRole("option", { name: new RegExp(LOT_PRODUCT.sku) }).first().click();
    await bar(page).getByRole("button", { name: "Guardar", exact: true }).click();
    await expect(page).toHaveURL(/\/r\/inventory\.count\/[0-9a-f-]{36}$/);
    const countId = page.url().split("/").pop()!;

    // The sheet lists one line per lot with stock in the bodega's unlocated stock (none when the demo keeps its lots on shelves): each
    // counted as the system holds it (no difference).
    const sheet = await sql<{ line_no: number; on_hand: string }[]>`
      select c.line_no, coalesce(sum(s.on_hand), 0)::text as on_hand from inventory.count_lines c
      join inventory.counts k on k.id = c.count_id
      left join inventory.stock_levels s on s.warehouse_id = k.warehouse_id and s.product_id = c.product_id
        and s.location_id is not distinct from c.location_id and s.lot_id is not distinct from c.lot_id and s.serial_id is not distinct from c.serial_id
      where c.count_id = ${countId} group by c.line_no order by c.line_no`;
    for (const l of sheet) await frame(page).getByLabel(`Cantidad contada, línea ${l.line_no}`).fill(String(Number(l.on_hand)));

    // Agregar encontrado: the lot product, a new lot code with its expiry, 5 units.
    await frame(page).getByRole("button", { name: "Agregar encontrado", exact: true }).click();
    await frame(page).getByRole("combobox", { name: "Producto, encontrado 1" }).fill(LOT_PRODUCT.sku);
    await page.getByRole("option", { name: new RegExp(LOT_PRODUCT.sku) }).first().click();
    await expect(frame(page).getByLabel("Lote, encontrado 1")).toHaveValue("__new");
    await frame(page).getByLabel("Código del lote nuevo, encontrado 1").fill(code);
    await frame(page).getByLabel("Vencimiento, encontrado 1").fill(expires);
    await frame(page).getByLabel("Cantidad contada, encontrado 1").fill("5");
    await frame(page).getByRole("button", { name: "Registrar conteo", exact: true }).click();

    // The sheet lists the found lot as a line of its own: 0 in the system, 5 counted.
    const foundLine = sheet.length + 1;
    await expect(frame(page).getByTestId(`count-difference-${foundLine}`)).toHaveText("5", { timeout: 15_000 });
    await expect(frame(page).getByRole("table", { name: "Hoja de conteo" }).getByRole("row", { name: new RegExp(code) })).toBeVisible();
    await expect(frame(page).getByTestId("count-found")).toHaveCount(0);

    // Aplicar conteo (step-up): one ajuste whose only line is +5 in the new lot.
    await frame(page).getByRole("button", { name: "Aplicar conteo", exact: true }).click();
    await confirmStepUp(page);
    await expect(frame(page).getByTestId("count-stage")).toHaveText("Aplicado", { timeout: 15_000 });
    const [count] = await sql<{ adjustment_id: string }[]>`select adjustment_id from inventory.counts where id = ${countId}`;
    const adjustment = await sql<{ qty: string; code: string | null }[]>`
      select ml.qty::text, l.code from inventory.movement_lines ml left join inventory.lots l on l.id = ml.lot_id where ml.movement_id = ${count!.adjustment_id}`;
    expect(adjustment.map((a) => [Number(a.qty), a.code])).toEqual([[5, code]]);
  });
});
