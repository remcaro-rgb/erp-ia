import type { Page } from "@playwright/test";
import { expect, test } from "../test-support/streamed";
import { seedAuthUser, type AuthFixture } from "../test-support/auth-fixtures";

// UX-OD-1, UX-OD-2, UX-OD-4 (owner 2026-10-31, design §22.21) in a real browser: the bar never loses a global action at any width,
// the assistant is a sheet / overlay / dock by width, and a dirty form asks before it is lost.

async function signIn(page: Page, fixture: AuthFixture) {
  await page.goto("/login");
  await page.getByLabel("Correo").fill(fixture.email);
  await page.getByLabel("Contraseña", { exact: true }).fill(fixture.password);
  await page.getByRole("button", { name: "Entrar" }).click();
  await expect(page).toHaveURL(/\/$/);
}

test.describe("responsive shell", () => {
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

  for (const [width, height] of [[390, 844], [768, 1024], [1280, 800], [1440, 900]] as const) {
    test(`at ${width} px every global action is reachable and the page never scrolls sideways`, async ({ page }) => {
      await page.setViewportSize({ width, height });
      await signIn(page, fixture);
      await page.goto("/parties");
      const bar = page.locator("header").first();
      await expect(bar.getByRole("button", { name: "Asistente" })).toBeVisible();
      await expect(bar.getByRole("button", { name: "Menú de usuario" })).toBeVisible();
      await expect(bar.locator("#erp-cmd")).toBeVisible();
      if (width < 1024) await expect(bar.getByRole("button", { name: "Menú de navegación" })).toBeVisible();
      else await expect(bar.getByRole("navigation", { name: "Menú del módulo" })).toBeVisible();
      // Under 640 px the theme and the notifications live in the user menu, labelled.
      if (width < 640) {
        await bar.getByRole("button", { name: "Menú de usuario" }).click();
        await expect(page.getByRole("menuitem", { name: /Notificaciones/ })).toBeVisible();
        await page.keyboard.press("Escape");
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    });
  }

  test("390 px: Menú opens a sheet with the modules and the items; the assistant is a full-screen sheet with Cerrar", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await signIn(page, fixture);
    await page.goto("/parties");
    await page.getByRole("button", { name: "Menú de navegación" }).click();
    const sheet = page.getByRole("dialog");
    await expect(sheet.getByRole("link", { name: "Productos" })).toBeVisible();
    await sheet.getByRole("link", { name: "Productos" }).click();
    await expect(page).toHaveURL(/\/products/);

    const toggle = page.getByRole("button", { name: "Asistente", exact: true });
    await toggle.click();
    const drawer = page.getByRole("dialog", { name: "Asistente" });
    await expect(drawer).toBeVisible();
    const box = await drawer.boundingBox();
    expect(box!.width).toBeGreaterThanOrEqual(389);
    await expect(page.getByLabel("Escribe")).toBeFocused();
    await drawer.getByRole("button", { name: "Cerrar asistente" }).click();
    await expect(drawer).toBeHidden();
    await expect(toggle).toBeFocused();
    const main = await page.locator("#erp-main").boundingBox();
    expect(main!.width).toBeGreaterThanOrEqual(389);
  });

  test("1000 px: the assistant slides over the page, which keeps its width; Esc closes it", async ({ page }) => {
    await page.setViewportSize({ width: 1000, height: 800 });
    await signIn(page, fixture);
    await page.goto("/parties");
    const before = (await page.locator("#erp-main").boundingBox())!.width;
    await page.getByRole("button", { name: "Asistente", exact: true }).click();
    const drawer = page.getByRole("complementary", { name: "Asistente" });
    await expect(drawer).toBeVisible();
    expect(((await page.locator("#erp-main").boundingBox())!.width)).toBeCloseTo(before, 0);
    await page.keyboard.press("Escape");
    await expect(drawer).toBeHidden();
  });

  test("a dirty Crear tercero asks before it is left; a clean one does not; Cancelar keeps the value", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await signIn(page, fixture);
    await page.goto("/parties?new=1");
    await expect(page).toHaveURL(/\/r\/core\.party\//);
    await expect(page.getByRole("textbox", { name: /^Razón social/ })).toBeVisible();
    // Clean: leaving is free.
    await page.getByRole("navigation", { name: "Menú del módulo" }).getByRole("link", { name: "Productos" }).click();
    await expect(page).toHaveURL(/\/products/);
    await page.goto("/parties?new=1");
    await expect(page).toHaveURL(/\/r\/core\.party\//);
    await page.getByRole("textbox", { name: /^Razón social/ }).fill("Cambio sin guardar");
    await expect(page.getByText("Sin guardar").first()).toBeVisible();
    await page.getByRole("navigation", { name: "Menú del módulo" }).getByRole("link", { name: "Productos" }).click();
    const ask = page.getByRole("alertdialog");
    await expect(ask).toBeVisible();
    await expect(ask.getByRole("button", { name: "Guardar", exact: true })).toBeVisible();
    await ask.getByRole("button", { name: "Cancelar" }).click();
    await expect(page).toHaveURL(/\/r\/core\.party\//);
    await expect(page.getByRole("textbox", { name: /^Razón social/ })).toHaveValue("Cambio sin guardar");
    // The browser's own prompt on refresh.
    let kind = "";
    page.once("dialog", (d) => {
      kind = d.type();
      void d.dismiss();
    });
    await page.evaluate(() => void location.reload());
    await expect.poll(() => kind).toBe("beforeunload");
    await expect(page.getByRole("textbox", { name: /^Razón social/ })).toHaveValue("Cambio sin guardar");
  });
});
