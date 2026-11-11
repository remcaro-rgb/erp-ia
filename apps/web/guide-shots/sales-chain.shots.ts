import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import postgres from "postgres";
import { expect, test } from "../test-support/streamed";
import { DEMO_COMPANY_ID, LAURA } from "../../../scripts/demo/accounts";
import { totpCode } from "../test-support/auth-fixtures";
import { testEnv } from "../test-support/env";

// The screenshots of the phase 2B user guides (plan 2B Task 27): the sales chain the demo company holds after
// `pnpm db:reset && DEMO_SEED=1 pnpm db:seed` (Task 26: COT-1 → PED-1 → ENT-1 → the first invoice → RC-1), one test per image, signed in as
// Laura, the `main` region only, light theme, the clock fixed on the demo chain's day. Nothing is written: the pages are only opened, and
// the choices the pages remember for Laura (`kernel.user_prefs`) are put back in afterAll. Run:
// `E2E_BASE_URL=http://localhost:3100 pnpm -F web guide:shots sales-chain` (localhost: the dev server refuses its HMR socket to 127.0.0.1, and the
// pages then never hydrate).

const IMG = join(__dirname, "../../../docs/user-guide/es-419/img");
const sql = postgres(testEnv().DATABASE_URL, { max: 2, onnotice: () => {} });
const companyId = DEMO_COMPANY_ID;

async function login(page: Page) {
  await page.goto("/login");
  await page.getByLabel("Correo").fill(LAURA.email);
  await page.getByLabel("Contraseña", { exact: true }).fill(LAURA.password);
  await page.getByRole("button", { name: "Entrar" }).click();
  await expect(page).toHaveURL(/\/mfa\/verify$/);
  await page.getByLabel("Dígito 1").fill(totpCode(LAURA.totpSecret!));
  await expect(page).not.toHaveURL(/\/mfa\//, { timeout: 20_000 });
}

/** Screenshots the main region once it has its content and the fonts are in, without the assistant drawer. */
async function shot(page: Page, slug: string, ready: Locator) {
  await expect(ready.first()).toBeVisible({ timeout: 20_000 });
  const drawer = page.getByRole("textbox", { name: /Pregunta, pide una acción/ });
  if (await drawer.isVisible()) await page.getByRole("button", { name: "Asistente", exact: true }).click();
  await expect(drawer).toBeHidden();
  await expect(page.locator("main .erp-grid__skeleton")).toHaveCount(0);
  await expect(page.locator("main").getByText(/Cargando/)).toHaveCount(0);
  await page.addStyleTag({ content: "nextjs-portal { display: none !important; }" });
  await page.evaluate(() => document.fonts.ready);
  await page.mouse.move(0, 0);
  const box = (await page.locator("main").boundingBox())!;
  await page.screenshot({ path: join(IMG, `${slug}.png`), animations: "disabled", fullPage: true, clip: { ...box, height: Math.min(box.height, 820) } });
}

/** The first document of the demo chain in `table` (lowest seq). */
async function first(table: "crm.quotes" | "sales.orders" | "sales.deliveries" | "invoicing.invoices" | "payments.receipts"): Promise<string> {
  const [schema, name] = table.split(".") as [string, string];
  const [row] = await sql<{ id: string }[]>`select id from ${sql(schema)}.${sql(name)} where company_id = ${companyId} order by seq limit 1`;
  if (!row) throw new Error(`the demo company has no ${table}: run DEMO_SEED=1 pnpm db:seed`);
  return row.id;
}

type Pref = { user_id: string; company_id: string; key: string; value: unknown };
let prefs: Pref[] = [];
let userId = "";

const STATE = join(tmpdir(), "erp-ia-guide-shots-sales-chain-laura.json");
test.use({ storageState: STATE });

test.beforeAll(async ({ browser }) => {
  mkdirSync(IMG, { recursive: true });
  const context = await browser.newContext({ storageState: undefined, locale: "es-419", timezoneId: "America/Bogota" });
  await login(await context.newPage());
  await context.storageState({ path: STATE });
  await context.close();
  const [user] = await sql<{ id: string }[]>`select id from auth.users where email = ${LAURA.email}`;
  userId = user!.id;
  prefs = await sql<Pref[]>`select user_id, company_id, key, value from kernel.user_prefs where user_id = ${userId}`;
});

test.afterAll(async () => {
  await sql`delete from kernel.user_prefs where user_id = ${userId}`;
  for (const p of prefs) await sql`insert into kernel.user_prefs (user_id, company_id, key, value) values (${p.user_id}, ${p.company_id}, ${p.key}, ${sql.json(p.value as never)})`;
  await sql.end();
});

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime("2026-11-05T15:00:00-05:00");
});

const printButton = (page: Page) => page.getByRole("button", { name: "Imprimir", exact: true });

test("cotizacion-aceptada", async ({ page }) => {
  await page.goto(`/r/crm.quote/${await first("crm.quotes")}`);
  await shot(page, "cotizacion-aceptada", printButton(page));
});

test("pedido-entregado", async ({ page }) => {
  await page.goto(`/r/sales.order/${await first("sales.orders")}`);
  await shot(page, "pedido-entregado", printButton(page));
});

test("entrega-despachada", async ({ page }) => {
  await page.goto(`/r/sales.delivery/${await first("sales.deliveries")}`);
  await shot(page, "entrega-despachada", printButton(page));
});

test("factura-emitida", async ({ page }) => {
  await page.goto(`/r/invoicing.invoice/${await first("invoicing.invoices")}`);
  await shot(page, "factura-emitida", printButton(page));
});

test("recibo-de-caja", async ({ page }) => {
  await page.goto(`/r/payments.receipt/${await first("payments.receipts")}`);
  await shot(page, "recibo-de-caja", printButton(page));
});

test("existencias", async ({ page }) => {
  await page.goto("/inventory/stock");
  await shot(page, "existencias", page.locator(".erp-grid__body tbody tr"));
});

test("capas-de-costo", async ({ page }) => {
  await page.goto("/costing/layers");
  await shot(page, "capas-de-costo", page.locator(".erp-grid__body tbody tr"));
});

test("condiciones-comerciales", async ({ page }) => {
  await page.goto("/sales/customer-terms");
  await shot(page, "condiciones-comerciales", page.getByRole("button", { name: "Guardar" }));
});
