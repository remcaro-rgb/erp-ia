import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import postgres from "postgres";
import { expect, test } from "../test-support/streamed";
import { DEMO_COMPANY_ID, LAURA } from "../../../scripts/demo/accounts";
import { totpCode } from "../test-support/auth-fixtures";
import { testEnv } from "../test-support/env";

// The screenshots of the accounting user guides (gaps Task 10): one test per image, each signed in as Laura on the demo company
// (`pnpm db:reset && DEMO_SEED=1 pnpm db:seed`), the `main` region only, light theme, the clock fixed. A state the demo does not hold
// is created through SQL and removed in afterEach, and the choices the pages remember for Laura (`kernel.user_prefs`) are put back
// in afterAll, so the demo company ends as it started. Run: `E2E_BASE_URL=http://127.0.0.1:3100 pnpm -F web guide:shots`.

const IMG = join(__dirname, "../../../docs/user-guide/es-419/contabilidad/img");
const sql = postgres(testEnv().DATABASE_URL, { max: 2, onnotice: () => {} });
const companyId = DEMO_COMPANY_ID;

async function login(page: Page) {
  await page.goto("/login");
  await page.getByLabel("Correo").fill(LAURA.email);
  await page.getByLabel("Contraseña", { exact: true }).fill(LAURA.password);
  await page.getByRole("button", { name: "Entrar" }).click();
  await expect(page).toHaveURL(/\/mfa\/verify$/);
  await page.getByLabel("Dígito 1").fill(totpCode(LAURA.totpSecret!));
  await expect(page).toHaveURL(/\/$/);
}

/** Screenshots the main region once the grids and trees have rows and the fonts are in. */
async function shot(page: Page, slug: string, ready?: Locator) {
  if (ready) await expect(ready.first()).toBeVisible();
  // The assistant's drawer starts open and takes 400 px of the screen: the guides show the screen, not the drawer.
  const drawer = page.getByRole("textbox", { name: /Pregunta, pide una acción/ });
  if (await drawer.isVisible()) await page.getByRole("button", { name: "Asistente", exact: true }).click();
  await expect(drawer).toBeHidden();
  // Nothing may still be loading: no skeleton rows, no "Cargando…", and the dev server's indicator is out of the picture.
  await expect(page.locator("main .erp-grid__skeleton")).toHaveCount(0);
  await expect(page.locator("main").getByText(/Cargando/)).toHaveCount(0);
  await page.addStyleTag({ content: "nextjs-portal { display: none !important; }" });
  await page.evaluate(() => document.fonts.ready);
  await page.mouse.move(0, 0);
  // The main region, at most one screen tall: the long pages (the exógena concepts) show their top.
  const box = (await page.locator("main").boundingBox())!;
  await page.screenshot({ path: join(IMG, `${slug}.png`), animations: "disabled", fullPage: true, clip: { ...box, height: Math.min(box.height, 820) } });
}

type Pref = { user_id: string; company_id: string; key: string; value: unknown };
let prefs: Pref[] = [];
let userId = "";
const cleanup: (() => Promise<void>)[] = [];

// One sign-in for the run: a TOTP code is single use, so signing in fifteen times in the same 30 seconds would be refused.
const STATE = join(tmpdir(), "erp-ia-guide-shots-laura.json");
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
  await page.clock.setFixedTime("2026-10-30T15:00:00-05:00");
});

test.afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});

const accountId = async (code: string) => (await sql<{ id: string }[]>`select id from accounting.accounts where company_id = ${companyId} and code = ${code}`)[0]!.id;

test("plan-de-cuentas-arbol", async ({ page }) => {
  await page.goto("/accounting/accounts");
  await page.getByRole("button", { name: "Árbol" }).click();
  await shot(page, "plan-de-cuentas-arbol", page.getByRole("treeitem"));
});

test("centros-de-costo-arbol", async ({ page }) => {
  await page.goto("/accounting/cost-centers");
  await page.getByRole("button", { name: "Árbol" }).click();
  await shot(page, "centros-de-costo-arbol", page.getByRole("treeitem"));
});

test("unidades-de-negocio-tabla", async ({ page }) => {
  await page.goto("/accounting/business-units");
  await page.getByRole("button", { name: "Tabla" }).click();
  await shot(page, "unidades-de-negocio-tabla", page.locator(".erp-grid__body tbody tr"));
});

test("auxiliares-abiertos-arbol", async ({ page }) => {
  await page.goto("/accounting/open-auxiliaries");
  await page.getByRole("button", { name: "Árbol" }).click();
  await shot(page, "auxiliares-abiertos-arbol", page.getByRole("treeitem"));
});

test("comprobantes-listado", async ({ page }) => {
  await page.goto("/accounting/entries");
  await shot(page, "comprobantes-listado", page.locator(".erp-grid__body tbody tr"));
});

test("comprobante-borrador-lineas", async ({ page }) => {
  const [journal] = await sql<{ id: string }[]>`select id from accounting.journals where company_id = ${companyId} and code = 'NC'`;
  const [period] = await sql<{ id: string }[]>`select id from accounting.periods where company_id = ${companyId} and starts_on <= '2026-10-30' and ends_on >= '2026-10-30'`;
  const [entry] = await sql<{ id: string }[]>`
    insert into accounting.entries (company_id, journal_id, date, period_id, status, origin, description)
    values (${companyId}, ${journal!.id}, '2026-10-30', ${period!.id}, 'draft', 'manual', 'Pago de nómina de octubre') returning id`;
  const amount = 1_250_000;
  for (const [no, code, debit, credit] of [[1, "510506", amount, 0], [2, "111005", 0, amount]] as const) {
    await sql`insert into accounting.entry_lines (company_id, entry_id, line_no, account_id, debit, credit, debit_doc, credit_doc) values (${companyId}, ${entry!.id}, ${no}, ${await accountId(code)}, ${debit}, ${credit}, ${debit}, ${credit})`;
  }
  cleanup.push(async () => {
    await sql.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      await tx`delete from accounting.entry_lines where entry_id = ${entry!.id}`;
      await tx`delete from accounting.entries where id = ${entry!.id}`;
    });
  });
  await page.goto(`/r/accounting.entry/${entry!.id}`);
  await shot(page, "comprobante-borrador-lineas", page.getByText("LÍNEAS"));
});

test("movimientos-agrupado", async ({ page }) => {
  await page.goto("/accounting/movements");
  await expect(page.locator(".erp-grid__body tbody tr").first()).toBeVisible();
  await page.getByRole("button", { name: "Agrupar por", exact: true }).click();
  const add = page.getByLabel("Agregar campo para agrupar");
  await add.selectOption({ label: "Cuenta" });
  await add.selectOption({ label: "Centro de costo" });
  await expect(page.getByRole("list", { name: "Agrupar por" })).toContainText("2. Centro de costo");
  await shot(page, "movimientos-agrupado", page.locator(".erp-grid__body tbody tr"));
});

test("informes-tarjetas", async ({ page }) => {
  await page.goto("/accounting/reports");
  await shot(page, "informes-tarjetas", page.getByRole("link", { name: /Balance de prueba/ }));
});

test("cartera-por-edades", async ({ page }) => {
  await page.goto("/accounting/reports/aging");
  await shot(page, "cartera-por-edades", page.locator(".erp-grid__body tbody tr"));
});

test("auditoria-comprobantes-manuales", async ({ page }) => {
  await page.goto("/accounting/reports/manual_entries_audit");
  await shot(page, "auditoria-comprobantes-manuales", page.locator(".erp-grid__body tbody tr"));
});

test("periodos-cerrar", async ({ page }) => {
  await page.goto("/accounting/periods");
  await shot(page, "periodos-cerrar", page.getByRole("button", { name: /^Cerrar / }));
});

test("regla-contable-lineas", async ({ page }) => {
  await page.goto("/accounting/posting?tab=rules");
  await page.getByRole("cell", { name: "Factura de venta emitida" }).click();
  await page.getByRole("tab", { name: /^Líneas/ }).click();
  await shot(page, "regla-contable-lineas", page.getByRole("tabpanel"));
});

test("pendientes-de-contabilizar", async ({ page }) => {
  const [rule] = await sql<{ id: string }[]>`select id from accounting.posting_rules where company_id = ${companyId} and event = 'invoicing.invoice.issued' limit 1`;
  const [failure] = await sql<{ id: string }[]>`
    insert into accounting.posting_failures (company_id, event_id, event, event_date, posting_rule_id, payload, error_code, error_detail, status)
    values (${companyId}, gen_random_uuid(), 'invoicing.invoice.issued', '2026-10-28', ${rule!.id}, ${sql.json({ date: "2026-10-28", total: 100000 })}, 'unbalanced', 'Débitos y créditos no cuadran', 'pending') returning id`;
  cleanup.push(async () => {
    await sql`delete from accounting.posting_failures where id = ${failure!.id}`;
  });
  await page.goto("/accounting/posting?tab=pending");
  await shot(page, "pendientes-de-contabilizar", page.getByText("Débitos y créditos no cuadran"));
});

test("conceptos-exogena-sin-concepto", async ({ page }) => {
  await page.goto("/accounting/posting?tab=concepts");
  await shot(page, "conceptos-exogena-sin-concepto", page.getByText(/cuentas? con movimiento sin concepto/));
});

test("seguridad-cuenta-restringida", async ({ page }) => {
  await page.goto(`/r/accounting.account/${await accountId("5105")}`);
  await page.getByRole("tab", { name: "Seguridad", exact: true }).click();
  await shot(page, "seguridad-cuenta-restringida", page.getByRole("radio", { name: "Restringida" }));
});
