import { randomUUID } from "node:crypto";
import type { Page } from "@playwright/test";
import { expect, test } from "../test-support/streamed";
import { seedAuthUser, type AuthFixture } from "../test-support/auth-fixtures";

// The application shell in a real browser (design §19a, rule 19, prototype v5): navy top bar with the module and
// its items, the tinted tabs band, ⌘K, the theme saved per user and the tabs kept across reloads. The user is a
// real Auth user whose company is entitled to the core module and whose role may read parties and products.

const SCREENSHOTS = "e2e/__screenshots__";

async function signIn(page: Page, fixture: AuthFixture) {
  await page.goto("/login");
  await page.getByLabel("Correo").fill(fixture.email);
  await page.getByLabel("Contraseña", { exact: true }).fill(fixture.password);
  await page.getByRole("button", { name: "Entrar" }).click();
  await expect(page).toHaveURL(/\/$/);
}

test.describe("application shell", () => {
  let fixture: AuthFixture;
  test.beforeAll(async () => {
    fixture = await seedAuthUser({ role: "member" });
    const companyId = fixture.companyIds[0]!;
    await fixture.sql`insert into kernel.tenant_entitlements(tenant_id, key, source) values (${fixture.tenantId}, 'module:core', 'manual')`;
    const [role] = await fixture.sql<{ id: string }[]>`select id from kernel.roles where company_id = ${companyId}`;
    for (const process of ["core.party.consult", "core.party.create", "core.product.consult", "core.category.consult"]) {
      await fixture.sql`insert into kernel.process_permissions(company_id, role_id, process_id) values (${companyId}, ${role!.id}, ${process})`;
    }
  });
  test.afterAll(async () => {
    await fixture.sql`delete from kernel.process_permissions where company_id = any(${fixture.companyIds}::uuid[])`;
    await fixture.sql`delete from kernel.tenant_entitlements where tenant_id = ${fixture.tenantId}`;
    await fixture.cleanup();
  });

  test("navy bar with the module items, tinted tabs band, ⌘K, theme and tabs saved per user", async ({ page }) => {
    const problems: string[] = [];
    page.on("console", (message) => {
      if (["error", "warning"].includes(message.type())) problems.push(message.text());
    });
    await page.emulateMedia({ colorScheme: "light" });
    await page.setViewportSize({ width: 1440, height: 900 });
    await signIn(page, fixture);

    // Top bar: navy, the company, the active module as the menu button and its items right next to it.
    const bar = page.locator("header").first();
    await expect(bar).toBeVisible();
    await expect(bar).toHaveCSS("background-color", "rgb(30, 58, 138)");
    await expect(bar.getByRole("button", { name: /Auth company 0/ })).toBeVisible();
    await expect(bar.getByRole("button", { name: /^Núcleo/ })).toHaveAttribute("title", "Módulos");
    const items = bar.getByRole("navigation", { name: "Menú del módulo" }).getByRole("button");
    await expect(items).toHaveText(["Inicio", "Terceros", "Productos", "Categorías"]);
    await expect(items.first()).toHaveAttribute("aria-current", "page");

    // Tabs band under the bar, tinted; Inicio active and not closable.
    const tabs = page.getByRole("navigation", { name: "Pestañas abiertas" });
    await expect(tabs).toHaveCSS("background-color", "rgb(214, 224, 245)");
    await expect(tabs.getByRole("button", { name: "Inicio", exact: true })).toHaveAttribute("aria-current", "page");
    await expect(tabs.getByRole("button", { name: "Cerrar Inicio" })).toHaveCount(0);

    // ⌘K / Ctrl+K: navigation by keywords, create commands the role may run, and free text for the assistant.
    await page.keyboard.press("ControlOrMeta+k");
    const palette = page.getByRole("dialog");
    await expect(palette).toBeVisible();
    await page.getByRole("combobox").fill("clientes");
    await expect(palette.getByRole("option", { name: /Ir a Terceros/ })).toBeVisible();
    await page.getByRole("combobox").fill("crear");
    await expect(palette.getByRole("option", { name: /Crear tercero/ })).toBeVisible();
    await expect(palette.getByRole("option", { name: /Crear producto/ })).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(palette).toBeHidden();

    // A record opens in its own tab; the open tabs survive a reload (kernel.user_prefs, key tabs).
    await page.goto(`/r/core.party/${randomUUID()}`);
    await expect(tabs.getByRole("button", { name: "No encontrado", exact: true })).toHaveAttribute("aria-current", "page");
    await expect
      .poll(async () => (await fixture.sql`select value from kernel.user_prefs where user_id = ${fixture.userId} and key = 'tabs'`)[0]?.value?.value?.tabs?.length ?? 0)
      .toBe(2);
    await page.goto("/");
    await expect(tabs.getByRole("button", { name: "No encontrado", exact: true })).toBeVisible();
    await expect(page.getByRole("complementary", { name: "Asistente" })).toBeVisible();
    await page.screenshot({ path: `${SCREENSHOTS}/shell-light.png` });

    // Theme: auto → light → dark, applied at once and saved for the user.
    const toggle = page.getByRole("button", { name: /^Cambiar tema/ });
    await toggle.click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    await toggle.click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await expect(bar).toHaveCSS("background-color", "rgb(15, 30, 77)");
    await expect(tabs).toHaveCSS("background-color", "rgb(28, 39, 67)");
    await expect
      .poll(async () => (await fixture.sql`select value from kernel.user_prefs where user_id = ${fixture.userId} and key = 'theme'`)[0]?.value?.value)
      .toBe("dark");
    // The server render carries the saved theme for <html> before the first paint.
    expect(await (await page.request.get("/")).text()).toContain(`setAttribute("data-theme","dark")`);
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await expect(tabs.getByRole("button", { name: "No encontrado", exact: true })).toBeVisible();
    await page.screenshot({ path: `${SCREENSHOTS}/shell-dark.png` });

    // Cerrar todas asks first and keeps Inicio.
    await tabs.getByRole("button", { name: /Cerrar todas/ }).click();
    const confirm = page.getByRole("dialog");
    await expect(confirm).toContainText("Inicio permanece abierta");
    await confirm.getByRole("button", { name: "Cerrar todas" }).click();
    await expect(tabs.getByRole("button", { name: "Registro", exact: true })).toHaveCount(0);
    await expect(tabs.getByRole("button", { name: "Inicio", exact: true })).toHaveAttribute("aria-current", "page");

    // Leaving the page at once (before the debounced save) still stores the change: the pagehide beacon.
    await page.goto("/login");
    await expect
      .poll(async () => (await fixture.sql`select value from kernel.user_prefs where user_id = ${fixture.userId} and key = 'tabs'`)[0]?.value?.value?.tabs?.length ?? 0)
      .toBe(1);

    // No hydration mismatch or React warning on the way (the record page's own 404 is expected).
    expect(problems.filter((text) => !/404 \(Not Found\)/.test(text))).toEqual([]);
  });
});
