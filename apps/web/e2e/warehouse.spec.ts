import { execFileSync } from "node:child_process";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import postgres from "postgres";
import { expect, test } from "../test-support/streamed";
import { DEMO_COMPANY_ID, LAURA } from "../../../scripts/demo/accounts";
import { LOT_PRODUCT } from "../../../scripts/demo/lots";
import { PUTAWAY_RECEIPT } from "../../../scripts/demo/warehouse";
import { totpCode } from "../test-support/auth-fixtures";
import { testEnv } from "../test-support/env";

// Bodega on screen, end to end (plan 2B.2 Task 29.4, PG §4.3, §4.4; RG-9) on the demo company, signed in as Laura (admin): a pedido of the
// lot product confirmed on screen makes its alistamiento, shown in the pedido's «Alistamientos» tab; the alistamiento opened and confirmed
// as proposed (FEFO) gives the draft entrega («Por despachar»), shipped with the lot taken. Then a receipt at Estantería A is put away on
// «Ubicar recibidos» to its category's bin and inventory relocates it. The e2e stack runs no worker: test-support/warehouse-chain.mts hands
// the outbox to the consumers (as the dispatch workflow would) and posts the receipt.

const sql = postgres(testEnv().DATABASE_URL, { max: 2, onnotice: () => {} });
const CHAIN = join(__dirname, "..", "test-support", "warehouse-chain.mts");
const CUSTOMER = { document: "900888123", name: "Distribuidora Caribe" };
const QTY = 2;

const bar = (page: Page) => page.getByRole("group", { name: "Acciones del registro" });
const frame = (page: Page) => page.locator(".erp-record").filter({ visible: true });

let laura = "";

const chain = (args: string[]) => {
  const out = execFileSync("pnpm", ["exec", "tsx", CHAIN, DEMO_COMPANY_ID, laura, ...args], { cwd: join(__dirname, ".."), stdio: "pipe", env: process.env, timeout: 240_000 })
    .toString().trim().split("\n");
  return JSON.parse(out[out.length - 1]!) as Record<string, unknown>;
};
const now = async () => (await sql<{ now: string }[]>`select now()::text as now`)[0]!.now;

async function signIn(page: Page) {
  await page.context().clearCookies();
  await page.goto("/login");
  await page.getByLabel("Correo").fill(LAURA.email);
  await page.getByLabel("Contraseña", { exact: true }).fill(LAURA.password);
  await page.getByRole("button", { name: "Entrar" }).click();
  await page.waitForURL(/\/(mfa\/verify)?$/);
  if (page.url().endsWith("/mfa/verify")) {
    await page.waitForLoadState("networkidle");
    await page.getByLabel("Dígito 1").fill(totpCode(LAURA.totpSecret!));
  }
  await expect(page).toHaveURL(/\/$/, { timeout: 15_000 });
}

test.describe("warehouse", () => {
  test.beforeAll(async () => {
    const [user] = await sql<{ id: string }[]>`select id from kernel.users where email = ${LAURA.email}`;
    laura = user!.id;
  });

  test.afterAll(async () => {
    await sql.end();
  });

  test("pedido confirmado → «Alistamientos» muestra el alistamiento → Confirmar → entrega en borrador con su lote → Despachar; luego ubicar una entrada", async ({ page }) => {
    test.setTimeout(300_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await signIn(page);

    // ── Pedido of the lot product, confirmed: Bodega makes its alistamiento (auto_pick_on_confirm). ──
    await page.goto("/r/sales.order/new");
    await page.getByRole("combobox", { name: "Cliente" }).fill(CUSTOMER.name);
    await page.getByRole("option", { name: new RegExp(CUSTOMER.name) }).first().click();
    await page.getByRole("combobox", { name: /^Bodega/ }).first().selectOption({ label: "PRIN · Bodega Principal" });
    await page.getByRole("combobox", { name: "Producto, línea 1" }).fill(LOT_PRODUCT.sku);
    await page.getByRole("option", { name: new RegExp(LOT_PRODUCT.sku) }).first().click();
    await page.getByLabel("Cantidad, línea 1").fill(String(QTY));
    await bar(page).getByRole("button", { name: /^Guardar/ }).first().click();
    await expect(page).toHaveURL(/\/r\/sales\.order\/[0-9a-f-]{36}$/);
    const orderId = page.url().split("/").pop()!;
    const since = await now();
    await frame(page).getByRole("button", { name: "Confirmar pedido", exact: true }).click();
    await expect(frame(page).getByTestId("order-stage")).toHaveText("Confirmado");
    chain(["drain", since]);
    const [pick] = await sql<{ id: string; number: string }[]>`select id, number from warehouse.picks where order_id = ${orderId} and status <> 'voided'`;
    expect(pick, "the alistamiento of the confirmed pedido").toBeTruthy();

    // ── The pedido's «Alistamientos» tab (Bodega's record tab, RG-9) lists it, with «Crear alistamiento». ──
    await page.reload();
    await frame(page).getByRole("tab", { name: /^Alistamientos/ }).click();
    await expect(frame(page).getByRole("button", { name: "Crear alistamiento", exact: true })).toBeVisible();
    await expect(frame(page).getByText(pick!.number).first()).toBeVisible();

    // ── The alistamiento: Confirmar as proposed (FEFO); the allocation answers and sales makes the Borrador entrega. ──
    await page.goto(`/r/warehouse.pick/${pick!.id}`);
    await expect(frame(page).getByTestId("pick-stage")).toHaveText("Por alistar");
    const confirmed = await now();
    await frame(page).getByRole("button", { name: "Confirmar alistamiento", exact: true }).click();
    await expect(frame(page).getByTestId("pick-stage")).toHaveText("Confirmado");
    chain(["drain", confirmed]);
    // FEFO may take more than one lot (a found lot another spec adds expires first): the pick is the set of lots taken, QTY in all.
    const picked = await sql<{ lot: string; qty: number }[]>`
      select l.code as lot, sum(pl.qty_picked)::float8 as qty from warehouse.pick_lines pl join inventory.lots l on l.id = pl.lot_id
      where pl.pick_id = ${pick!.id} and pl.qty_picked > 0 group by l.code order by l.code`;
    expect(picked.reduce((sum, p) => sum + p.qty, 0)).toBe(QTY);
    const [delivery] = await sql<{ id: string }[]>`
      select d.id from sales.deliveries d join kernel.document_links k on k.to_entity = 'sales.delivery' and k.to_id = d.id
      where k.from_entity = 'warehouse.pick' and k.from_id = ${pick!.id} and d.status <> 'voided'`;
    expect(delivery, "the Borrador entrega of the alistamiento").toBeTruthy();
    await page.reload();
    await expect(frame(page).getByTestId("pick-allocation")).toContainText("Asignado");

    // ── The entrega: «Por despachar» (its draft, holding the allocation); Despachar writes the lot taken on its line. ──
    await page.goto(`/r/sales.delivery/${delivery!.id}`);
    await expect(frame(page).getByTestId("delivery-stage")).toHaveText("Por despachar");
    const shipped = await now();
    await frame(page).getByRole("button", { name: "Despachar", exact: true }).click();
    await expect(frame(page).getByTestId("delivery-stage")).toHaveText("Despachada");
    chain(["drain", shipped]);
    const lots = await sql<{ lot: string; qty: number }[]>`
      select x.lot_code as lot, sum(x.qty)::float8 as qty from sales.delivery_line_lots x join sales.delivery_lines l on l.id = x.delivery_line_id
      where l.delivery_id = ${delivery!.id} group by x.lot_code order by x.lot_code`;
    expect([...lots]).toEqual([...picked]);
    await page.reload();
    for (const p of picked) await expect(frame(page).getByText(p.lot).first()).toBeVisible();

    // ── Ubicar recibidos: a receipt at Estantería A goes to its category's bin (the rule of «Café en grano»). ──
    const reference = `OC-E2E-${Date.now().toString(36).toUpperCase()}`;
    const receipt = chain(["receipt", PUTAWAY_RECEIPT.sku, "3", "EST-A", reference]) as { movementId: string };
    const atBin = async () =>
      Number((await sql<{ n: string }[]>`
        select coalesce(sum(s.on_hand), 0)::text as n from inventory.stock_levels s join inventory.locations l on l.id = s.location_id join core.products p on p.id = s.product_id
        where s.company_id = ${DEMO_COMPANY_ID} and l.code = ${PUTAWAY_RECEIPT.to} and p.sku = ${PUTAWAY_RECEIPT.sku}`)[0]!.n);
    const before = await atBin();
    await page.goto("/warehouse/putaway");
    await page.getByLabel("Entrada", { exact: true }).selectOption(receipt.movementId);
    await expect(page.getByRole("cell", { name: "Regla de la categoría" })).toBeVisible();
    await expect(page.getByLabel("Ubicar en, línea 1")).toHaveValue(
      (await sql<{ id: string }[]>`select id from inventory.locations where company_id = ${DEMO_COMPANY_ID} and code = ${PUTAWAY_RECEIPT.to}`)[0]!.id,
    );
    const put = await now();
    await page.getByRole("button", { name: "Confirmar ubicación", exact: true }).click();
    await expect(page.getByTestId("putaway-done")).toBeVisible();
    chain(["drain", put]);
    expect(await atBin()).toBe(before + 3);

    // ── Parámetros and Reportes: the demo's rules (one bin per category), the two switches on, the report with its parameters. ──
    await page.goto("/warehouse/putaway-rules");
    await expect(page.getByRole("table", { name: "Reglas de ubicación" }).getByRole("row")).toHaveCount(1 + 4, { timeout: 15_000 });
    await expect(page.getByRole("button", { name: "Agregar regla" })).toBeVisible();
    await page.goto("/warehouse/settings");
    await expect(page.getByRole("checkbox", { name: /Crear el alistamiento al confirmar un pedido/ })).toBeChecked();
    await expect(page.getByRole("checkbox", { name: /Crear la entrega en borrador/ })).toBeChecked();
    await page.goto("/warehouse/pending-picks");
    await expect(page.getByText("Los pedidos confirmados con mercancía por entregar")).toBeVisible();
    await expect(page.getByRole("columnheader", { name: "Por alistar" })).toBeVisible({ timeout: 15_000 });
  });
});
