import type { Page } from "@playwright/test";
import postgres from "postgres";
import { expect, test } from "../test-support/streamed";
import { DEMO_COMPANY_ID, LAURA } from "../../../scripts/demo/accounts";
import { totpCode } from "../test-support/auth-fixtures";
import { testEnv } from "../test-support/env";

// The Inicio of each module and "Personalizar página de inicio" on the demo company (`pnpm db:reset && DEMO_SEED=1 pnpm db:seed`),
// signed in as Laura (admin): every module has its own Inicio page with its indicators and charts, the customize dialog lists them
// with a description and an on/off switch, and what is switched off stays off after a reload and is saved for the user.

const sql = postgres(testEnv().DATABASE_URL, { max: 2, onnotice: () => {} });

async function login(page: Page) {
  await page.goto("/login");
  await page.getByLabel("Correo").fill(LAURA.email);
  await page.getByLabel("Contraseña", { exact: true }).fill(LAURA.password);
  await page.getByRole("button", { name: "Entrar" }).click();
  if (LAURA.totpSecret) {
    await page.waitForURL(/\/(mfa\/verify)?$/);
    if (page.url().endsWith("/mfa/verify")) await page.getByLabel("Dígito 1").fill(totpCode(LAURA.totpSecret));
  }
  await expect(page).toHaveURL(/\/$/);
}

const hiddenInDb = async (): Promise<string[]> => {
  const [row] = await sql<{ value: { value: string[] } }[]>`
    select p.value from kernel.user_prefs p join kernel.users u on u.id = p.user_id where u.email = ${LAURA.email} and p.company_id = ${DEMO_COMPANY_ID} and p.key = 'home_hidden'`;
  return row?.value.value ?? [];
};
const clearPrefs = () =>
  sql`delete from kernel.user_prefs where company_id = ${DEMO_COMPANY_ID} and key = 'home_hidden' or (company_id = ${DEMO_COMPANY_ID} and key like 'home_layout.%')`;

test.describe("Inicio of each module", () => {
  test.beforeAll(clearPrefs);
  test.afterAll(async () => {
    await clearPrefs();
    await sql.end();
  });

  test("every module has its own Inicio with indicators and charts, reachable from its bar", async ({ page }) => {
    test.setTimeout(180_000);
    await page.setViewportSize({ width: 1600, height: 900 });
    await login(page);

    // Contabilidad: the bar's Inicio opens it; the tab is named after the module.
    await page.goto("/inicio/accounting");
    const home = page.getByTestId("module-home");
    await expect(home.getByRole("heading", { name: "Inicio de Contabilidad" })).toBeVisible();
    const bar = page.getByRole("navigation", { name: "Menú del módulo" });
    await expect(bar.getByRole("link", { name: "Inicio" })).toHaveAttribute("href", "/inicio/accounting");
    await expect(bar.getByRole("link", { name: "Inicio" })).toHaveAttribute("aria-current", "page");
    await expect(page.getByRole("navigation", { name: "Pestañas abiertas" }).getByRole("button", { name: "Inicio de Contabilidad", exact: true })).toBeVisible();
    await expect(home.locator('[data-kpi="accounting.income_month"]')).toBeVisible();
    await expect(home.locator('[data-kpi="accounting.working_capital"]')).toBeVisible();
    await expect(home.getByRole("region", { name: "Ingresos y gastos por mes", exact: true }).getByRole("img")).toBeVisible();
    await expect(home.getByRole("region", { name: "Comprobantes por estado", exact: true }).getByRole("img")).toBeVisible();
    await expect(home.getByRole("region", { name: "Resultado por mes", exact: true }).getByRole("img")).toBeVisible();

    for (const [module, title, kpi, chart] of [
      ["core", "Inicio de Núcleo", "core.customers", "Terceros por tipo"],
      ["support", "Inicio de Soporte", "support.urgent", "Tickets recibidos por semana"],
      ["kernel", "Inicio de Sistema", "kernel.audit_24h", "Acciones auditadas por día"],
    ] as const) {
      await page.goto(`/inicio/${module}`);
      await expect(home.getByRole("heading", { name: title })).toBeVisible();
      await expect(home.locator(`[data-kpi="${kpi}"]`)).toBeVisible();
      await expect(home.getByRole("region", { name: chart, exact: true }).getByRole("img")).toBeVisible();
    }

    // The bar of another module leads to that module's Inicio, not to the accounting one.
    await expect(bar.getByRole("link", { name: "Inicio" })).toHaveAttribute("href", "/inicio/kernel");
  });

  test("Personalizar página de inicio: next to Restablecer tarjetas, lists KPIs and charts with a description and a switch; off stays off", async ({ page }) => {
    test.setTimeout(60_000);
    await page.setViewportSize({ width: 1600, height: 900 });
    await login(page);
    await page.goto("/inicio/accounting");
    const home = page.getByTestId("module-home");

    const top = home.getByRole("button", { name: "Restablecer tarjetas" }).locator("..");
    await expect(top.getByRole("button", { name: "Personalizar página de inicio" })).toBeVisible();

    await top.getByRole("button", { name: "Personalizar página de inicio" }).click();
    const dialog = page.getByRole("dialog", { name: "Personalizar página de inicio" });
    await expect(dialog.getByRole("heading", { name: "Indicadores" })).toBeVisible();
    await expect(dialog.getByRole("heading", { name: "Gráficos" })).toBeVisible();
    await expect(dialog.getByText("Línea con el resultado (ingresos menos gastos) de los últimos 6 meses.")).toBeVisible();
    await expect(dialog.getByText("Activos corrientes menos pasivos corrientes a la fecha del período.")).toBeVisible();
    const topExpenses = dialog.getByRole("switch", { name: "Mostrar Resultado por mes" });
    await expect(topExpenses).toHaveAttribute("aria-checked", "true");

    // Off: the chart and an indicator leave the page at once, and the choice is saved for the user.
    await topExpenses.click({ timeout: 8000 });
    await dialog.getByRole("switch", { name: "Mostrar Ingresos del mes" }).click();
    await expect(home.getByRole("region", { name: "Resultado por mes", exact: true })).toHaveCount(0);
    await expect(home.locator('[data-kpi="accounting.income_month"]')).toHaveCount(0);
    await expect.poll(hiddenInDb).toEqual(["accounting.income_month", "accounting.result_trend"]);
    await dialog.getByRole("button", { name: "Listo" }).click();
    await expect(dialog).toHaveCount(0);

    // After a reload it stays off, and the dialog shows the switches off.
    await page.reload();
    await expect(home.getByRole("heading", { name: "Inicio de Contabilidad" })).toBeVisible();
    await expect(home.getByRole("region", { name: "Resultado por mes", exact: true })).toHaveCount(0);
    await expect(home.getByRole("region", { name: "Ingresos y gastos por mes", exact: true })).toBeVisible();
    await home.getByRole("button", { name: "Personalizar página de inicio" }).click();
    await expect(page.getByRole("switch", { name: "Mostrar Resultado por mes" })).toHaveAttribute("aria-checked", "false");
    await expect(page.getByText("2 de", { exact: false }).first()).toBeVisible();

    // The same list governs the company-wide Inicio: the indicator is off there too.
    await page.keyboard.press("Escape");
    await page.goto("/");
    await expect(page.getByTestId("home")).toBeVisible();
    await expect(page.locator('[data-kpi="accounting.income_month"]')).toHaveCount(0);
    await expect(page.locator('[data-kpi="accounting.expenses_month"]')).toBeVisible();

    // On again: the chart comes back with its numbers.
    await page.goto("/inicio/accounting");
    await home.getByRole("button", { name: "Personalizar página de inicio" }).click();
    await page.getByRole("button", { name: "Activar todo", exact: true }).click();
    await expect(home.locator('[data-kpi="accounting.income_month"]')).toBeVisible({ timeout: 15_000 });
    await page.getByRole("button", { name: "Listo" }).click();
    await expect(home.getByRole("region", { name: "Resultado por mes", exact: true }).getByRole("img")).toBeVisible({ timeout: 15_000 });
    await expect(home.locator('[data-kpi="accounting.income_month"]')).toBeVisible();
    await expect.poll(hiddenInDb).toEqual([]);
  });

  test("the company-wide Inicio offers the same dialog with the indicators of every module", async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 1600, height: 900 });
    await login(page);
    const home = page.getByTestId("home");
    await expect(home.getByRole("button", { name: "Personalizar página de inicio" })).toBeVisible();
    await home.getByRole("button", { name: "Personalizar página de inicio" }).click();
    const dialog = page.getByRole("dialog", { name: "Personalizar página de inicio" });
    for (const module of ["Contabilidad", "Núcleo", "Soporte", "Sistema"]) await expect(dialog.getByRole("heading", { name: module })).toBeVisible();
    await expect(dialog.getByRole("heading", { name: "Gráficos" })).toHaveCount(0);
    await expect(dialog.getByRole("switch", { name: "Mostrar Clientes activos" })).toBeVisible();
  });
});
