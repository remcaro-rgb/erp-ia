import { execFileSync } from "node:child_process";
import { join } from "node:path";
import type { APIRequestContext, Page } from "@playwright/test";
import postgres from "postgres";
import { expect, test } from "../test-support/streamed";
import { DEMO_COMPANY_ID, LAURA } from "../../../scripts/demo/accounts";
import { LOT_PRODUCT } from "../../../scripts/demo/lots";
import { totpCode } from "../test-support/auth-fixtures";
import { testEnv } from "../test-support/env";

// Lots on screen, end to end (plan 2B.2 Task 28.4, Part G design PG §3.5, §3.6) on the demo company, signed in as Laura (admin): an Entrada of
// «Café molido tradicional 500 g» (lot-tracked in the demo) saved on screen with a new lot that expires before every other; a pedido of the
// same quantity to Café del Bosque delivered (FEFO takes that lot whole), shipped and invoiced as a Borrador (test-support/lot-chain.mts, the
// registered processes: the e2e stack runs no worker); the Borrador's line shows the lot; «Trazabilidad de lotes» of the lot lists the
// receipt and the sale issue with the customer, and the stock left (none).
//
// The spec runs on the shared demo: each run receives its own lot (L-E2E-<time>) and sells all of it, so the next run's lot is again the
// first FEFO picks.

const sql = postgres(testEnv().DATABASE_URL, { max: 2, onnotice: () => {} });
const CHAIN = join(__dirname, "..", "test-support", "lot-chain.mts");
const CUSTOMER = { document: "900531642", name: "Café del Bosque S.A.S." };
const QTY = 5;

const bar = (page: Page) => page.getByRole("group", { name: "Acciones del registro" });
const frame = (page: Page) => page.locator(".erp-record").filter({ visible: true });

let laura = "";
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

async function report<T>(request: APIRequestContext, id: string, params: Record<string, unknown>): Promise<T[]> {
  const answer = await request.post(`/api/report/${id}`, { data: { params, state: { filters: [], sort: [], page: 1, pageSize: 1000 } } });
  expect(answer.status(), `${id} ${await answer.text()}`).toBe(200);
  return ((await answer.json()) as { rows: T[] }).rows;
}

test.describe("inventory lots", () => {
  test.beforeAll(async () => {
    const [user] = await sql<{ id: string }[]>`select id from kernel.users where email = ${LAURA.email}`;
    laura = user!.id;
    const [clock] = await sql<{ today: string }[]>`select (now() at time zone 'America/Bogota')::date::text as today`;
    today = clock!.today;
  });

  test.afterAll(async () => {
    await sql.end();
  });

  test("an Entrada with a lot → the entrega takes the earliest lot → the invoice shows it → the recall lists the customer", async ({ page }) => {
    test.setTimeout(300_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await signIn(page);
    const code = `L-E2E-${Date.now().toString(36).toUpperCase()}`;
    const expires = new Date(Date.parse(`${today}T00:00:00Z`) + 10 * 86_400_000).toISOString().slice(0, 10);

    // ── Entrada (Movimientos): the lot product asks for the lot of its line; a new lot with its expiry. ──
    await page.goto("/r/inventory.movement/new");
    await expect(page.getByRole("heading", { name: "Crear movimiento de inventario" })).toBeVisible();
    await page.getByLabel(/^Tipo/).selectOption({ label: "Entrada" });
    await page.getByLabel(/^Bodega/).selectOption({ label: "PRIN · Bodega Principal" });
    await page.getByRole("combobox", { name: "Producto, línea 1" }).fill(LOT_PRODUCT.sku);
    await page.getByRole("option", { name: new RegExp(LOT_PRODUCT.sku) }).first().click();
    await page.getByLabel("Cantidad, línea 1").fill(String(QTY));
    await page.getByLabel("Costo unitario, línea 1").fill("14000");
    await page.getByLabel("Lote, línea 1", { exact: true }).fill(code);
    await page.getByLabel("Vencimiento del lote, línea 1").fill(expires);
    await bar(page).getByRole("button", { name: "Guardar", exact: true }).click();
    await expect(page).toHaveURL(/\/r\/inventory\.movement\/[0-9a-f-]{36}$/);
    const receiptId = page.url().split("/").pop()!;
    const [lot] = await sql<{ id: string; expires_on: string }[]>`select id, expires_on::text from inventory.lots where company_id = ${DEMO_COMPANY_ID} and code = ${code}`;
    expect(lot, "the lot the Entrada created").toMatchObject({ expires_on: expires });
    await expect(frame(page).getByText(code).first()).toBeVisible();

    // ── The pedido, entrega and Borrador (registered processes): FEFO takes the new lot, the one that expires first. ──
    const out = execFileSync("pnpm", ["exec", "tsx", CHAIN, DEMO_COMPANY_ID, laura, "sale", receiptId, CUSTOMER.document, LOT_PRODUCT.sku, String(QTY)], { cwd: join(__dirname, ".."), stdio: "pipe", env: process.env, timeout: 240_000 })
      .toString().trim().split("\n");
    const sale = JSON.parse(out[out.length - 1]!) as { invoiceId: string; lots: { lot_code: string; qty: number }[] };
    expect(sale.lots).toEqual([{ lot_code: code, qty: QTY }]);

    // ── The Borrador's line (Líneas e impuestos, the universal grid) shows the lot with its expiry and quantity. ──
    await page.goto(`/r/invoicing.invoice/${sale.invoiceId}`);
    await frame(page).getByRole("tab", { name: /^Líneas e impuestos/ }).click();
    const lines = frame(page).locator("section.erp-grid").filter({ visible: true }).first();
    await expect(lines.getByRole("columnheader", { name: "Lote / Vence / Serie" })).toBeVisible();
    await expect(lines.getByText(`${code} · ${expires} · ${QTY}`).first()).toBeVisible();

    // ── Trazabilidad de lotes (Inventario › Reportes): the receipt and the sale issue to Café del Bosque; nothing left on hand. ──
    type Row = { row_kind: string; kind: string; qty: number; customer: string | null };
    const rows = await report<Row>(page.request, "inventory.lot_trace", { lotId: lot!.id });
    expect(rows.filter((r) => r.row_kind === "movement").map((r) => [r.kind, r.qty, r.customer])).toEqual([["Entrada", QTY, null], ["Salida por venta", -QTY, CUSTOMER.name]]);
    expect(rows.filter((r) => r.row_kind === "stock")).toEqual([]);
    await page.goto(`/inventory/lot-trace?p=${encodeURIComponent(JSON.stringify({ lotId: lot!.id }))}`);
    await expect(page.getByRole("heading", { name: "Trazabilidad de lotes" }).first()).toBeVisible();
    await expect(page.getByRole("row", { name: new RegExp(CUSTOMER.name) }).first()).toContainText("Salida por venta");
  });
});
