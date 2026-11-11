import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import postgres from "postgres";
import { expect, test } from "../test-support/streamed";
import { DEMO_COMPANY_ID, LAURA } from "../../../scripts/demo/accounts";
import { totpCode } from "../test-support/auth-fixtures";
import { testEnv } from "../test-support/env";

// The screenshots of the entity types user guides (Phase 2A.5 Task 17), after the accounting ones (gaps Task 10): one test per image, each signed in as Laura on the demo company
// (`pnpm db:reset && DEMO_SEED=1 pnpm db:seed`), the `main` region only, light theme, the clock fixed. A state the demo does not hold
// is created through SQL and removed in afterEach, and the choices the pages remember for Laura (`kernel.user_prefs`) are put back
// in afterAll, so the demo company ends as it started. Run: `E2E_BASE_URL=http://127.0.0.1:3100 pnpm -F web guide:shots`.

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
const STATE = join(tmpdir(), "erp-ia-guide-shots-entity-types-laura.json");
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


const entryId = async (where: "pending" | "posted") =>
  where === "pending"
    ? (await sql<{ id: string }[]>`select id from accounting.entries where company_id = ${companyId} and status = 'pending' order by seq limit 1`)[0]!.id
    : (await sql<{ id: string }[]>`
        select e.id from accounting.entries e where e.company_id = ${companyId} and e.status = 'posted'
          and (select count(*) from kernel.record_snapshots s where s.record_id = e.id) > 1 order by e.seq limit 1`)[0]!.id;

/** The whole screen (the shell v7 side menu and the sections bar are the point), without the assistant drawer. */
async function screen(page: Page, slug: string, ready: Locator) {
  await expect(ready.first()).toBeVisible();
  const drawer = page.getByRole("textbox", { name: /Pregunta, pide una acción/ });
  if (await drawer.isVisible()) await page.getByRole("button", { name: "Asistente", exact: true }).click();
  await expect(drawer).toBeHidden();
  await page.addStyleTag({ content: "nextjs-portal { display: none !important; }" });
  await page.evaluate(() => document.fonts.ready);
  await page.mouse.move(0, 0);
  await page.screenshot({ path: join(IMG, `${slug}.png`), animations: "disabled" });
}

test("menu-lateral-y-secciones", async ({ page }) => {
  await page.goto("/parties");
  await screen(page, "menu-lateral-y-secciones", page.locator("#erp-side-menu"));
});

test("comprobante-pendiente-acciones", async ({ page }) => {
  await page.goto(`/r/accounting.entry/${await entryId("pending")}`);
  await shot(page, "comprobante-pendiente-acciones", page.getByRole("button", { name: "Aprobar", exact: true }));
});

test("comprobante-versiones", async ({ page }) => {
  await page.goto(`/r/accounting.entry/${await entryId("posted")}`);
  await page.getByRole("tab", { name: /^Versiones/ }).click();
  await shot(page, "comprobante-versiones", page.getByRole("tabpanel"));
});

test("registro-acceso", async ({ page }) => {
  await page.goto(`/r/accounting.entry/${await entryId("posted")}`);
  await page.getByRole("tab", { name: /^Acceso/ }).click();
  await shot(page, "registro-acceso", page.getByRole("tabpanel"));
});

test("notificar-dialogo", async ({ page }) => {
  await page.goto(`/r/accounting.entry/${await entryId("posted")}`);
  await page.getByRole("button", { name: "Notificar", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  await page.mouse.move(0, 0);
  await dialog.screenshot({ path: join(IMG, "notificar-dialogo.png"), animations: "disabled" });
});

test("tercero-maestro", async ({ page }) => {
  const [party] = await sql<{ id: string }[]>`select id from core.parties where company_id = ${companyId} and legal_name = 'Almacenes Éxito S.A.'`;
  await page.goto(`/r/core.party/${party!.id}`);
  await shot(page, "tercero-maestro", page.getByRole("button", { name: "Imprimir", exact: true }));
});
