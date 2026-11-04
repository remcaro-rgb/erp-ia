import type { Page } from "@playwright/test";
import { expect, test } from "../test-support/streamed";
import postgres from "postgres";
import { DEMO_COMPANY_ID, MARCELA } from "../../../scripts/demo/accounts";
import { adminClient, enrolTotp, removeTotpFactors, seedAuthUser, totpCode, verifiedTotpCount, type AuthFixture } from "../test-support/auth-fixtures";
import { testEnv } from "../test-support/env";

// The sign-in surface in a real browser (design §6; prototype v5 login): password, the TOTP step, remember me
// and the step-up endpoint. Users are real Auth users seeded in the local stack; TOTP codes come from `otpauth`.

const THIRTY_DAYS = 30 * 24 * 60 * 60;
const sessionCookies = async (page: Page) => (await page.context().cookies()).filter((cookie) => /^sb-.*-auth-token/.test(cookie.name));

async function submitPassword(page: Page, fixture: Pick<AuthFixture, "email" | "password">, options: { remember?: boolean } = {}) {
  await page.goto("/login");
  await page.getByLabel("Correo").fill(fixture.email);
  await page.getByLabel("Contraseña", { exact: true }).fill(fixture.password);
  if (options.remember) await page.getByLabel("Recordarme en este dispositivo por 30 días").check();
  await page.getByRole("button", { name: "Entrar" }).click();
}

// An admin is required to have the second step only when an administrator set it (owner decision 2026-11-04).
test.describe("a user whose second step is required and who has no factor", () => {
  let fixture: AuthFixture;
  test.beforeAll(async () => {
    fixture = await seedAuthUser({ role: "admin", mfaRequired: true });
  });
  test.afterAll(async () => {
    await fixture.cleanup();
  });

  test("login, enrol TOTP, verify and land on /", async ({ page }) => {
    await submitPassword(page, fixture);
    await expect(page).toHaveURL(/\/mfa\/enroll$/);

    // The second step is required: nothing else opens until the factor is enrolled.
    await page.goto("/");
    await expect(page).toHaveURL(/\/mfa\/enroll$/);

    const secret = (await page.getByTestId("totp-secret").textContent())!.trim();
    await page.getByLabel("Dígito 1").click();
    await page.keyboard.type(totpCode(secret));
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByTestId("home")).toBeVisible();
  });
});

test.describe("admin with a second factor", () => {
  let fixture: AuthFixture;
  let secret: string;
  test.beforeAll(async () => {
    fixture = await seedAuthUser({ role: "admin" });
    secret = await enrolTotp(fixture);
  });
  test.afterAll(async () => {
    await fixture.cleanup();
  });

  test("is redirected to /mfa/verify until verified, then the step-up endpoint works", async ({ page }) => {
    await submitPassword(page, fixture);
    await expect(page).toHaveURL(/\/mfa\/verify$/);

    // Password only: pages go back to the second step, and the API answers 401 with the reason.
    await page.goto("/");
    await expect(page).toHaveURL(/\/mfa\/verify$/);
    const blocked = await page.request.get("/api/attachments?entity=core.party&recordId=00000000-0000-4000-8000-000000000000");
    expect(blocked.status()).toBe(401);
    expect(await blocked.json()).toMatchObject({ code: "mfa_required" });

    // A wrong code is refused and the boxes clear; a pasted right code is spread over the six boxes and submitted.
    await page.getByLabel("Dígito 1").fill("000000");
    await expect(page.locator("p[role=alert]")).toContainText("El código no es correcto");
    await expect(page.getByLabel("Dígito 1")).toHaveValue("");
    await page.getByLabel("Dígito 1").fill(totpCode(secret));
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByTestId("home")).toBeVisible();

    const wrong = await page.request.post("/api/auth/step-up", { data: { code: "000000" } });
    expect(wrong.status()).toBe(401);
    const right = await page.request.post("/api/auth/step-up", { data: { code: totpCode(secret) } });
    expect(right.status()).toBe(200);
    expect(((await right.json()) as { token: string }).token.length).toBeGreaterThan(20);
    const rows = await fixture.sql`select 1 from kernel.step_up_verifications where user_id = ${fixture.userId}`;
    expect(rows).toHaveLength(1);
  });
});

test.describe("an admin nobody requires a second step of", () => {
  let fixture: AuthFixture;
  test.beforeAll(async () => {
    fixture = await seedAuthUser({ role: "admin" });
  });
  test.afterAll(async () => {
    await fixture.cleanup();
  });

  test("signs in with the password only and lands on /", async ({ page }) => {
    await submitPassword(page, fixture);
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByTestId("home")).toBeVisible();
  });
});

test.describe("member", () => {
  let fixture: AuthFixture;
  test.beforeAll(async () => {
    fixture = await seedAuthUser({ role: "member" });
  });
  test.afterAll(async () => {
    await fixture.cleanup();
  });

  test("a visitor without a session is sent to /login", async ({ page }) => {
    await page.goto("/");
    await expect(page).toHaveURL(/\/login$/);
    const api = await page.request.get("/api/attachments?entity=core.party&recordId=00000000-0000-4000-8000-000000000000");
    expect(api.status()).toBe(401);
  });

  test("the eye button shows and hides the password", async ({ page }) => {
    await page.goto("/login");
    const password = page.getByLabel("Contraseña", { exact: true });
    const eye = page.getByRole("button", { name: "Mostrar contraseña" });
    await expect(eye).toHaveAttribute("aria-pressed", "false");
    await expect(password).toHaveAttribute("type", "password");
    await eye.click();
    await expect(password).toHaveAttribute("type", "text");
    await expect(page.getByRole("button", { name: "Ocultar contraseña" })).toHaveAttribute("aria-pressed", "true");
  });

  test("without remember me the session cookie has no expiry; with it, 30 days and the e-mail is prefilled next time", async ({ page }) => {
    await submitPassword(page, fixture);
    await expect(page).toHaveURL(/\/$/);
    const session = await sessionCookies(page);
    expect(session.length).toBeGreaterThan(0);
    for (const cookie of session) expect(cookie.expires).toBe(-1);

    await page.context().clearCookies();
    await submitPassword(page, fixture, { remember: true });
    await expect(page).toHaveURL(/\/$/);
    const remembered = await sessionCookies(page);
    const now = Date.now() / 1000;
    for (const cookie of remembered) expect(Math.abs(cookie.expires - (now + THIRTY_DAYS))).toBeLessThan(3600);

    // A signed-in visitor has no use for the sign-in page.
    await page.goto("/login");
    await expect(page).toHaveURL(/\/$/);

    // Sign out; the device is remembered: e-mail filled in, box ticked.
    // (the shell's user menu: the home page no longer carries a sign-out button of its own)
    await page.getByRole("button", { name: "Menú de usuario" }).click();
    await page.getByRole("menuitem", { name: "Salir" }).click();
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByLabel("Correo")).toHaveValue(fixture.email);
    await expect(page.getByLabel("Recordarme en este dispositivo por 30 días")).toBeChecked();
  });
});

// Design §22.19: the second step is the user's own. Marcela (cashier, no role that requires it) turns it on from the user
// menu, signs in with the code, turns it off again with a fresh code (step-up), is signed out (Auth ends every session of
// a user whose verified factor is removed) and signs in with her password only.
test.describe("a member's own second step", () => {
  const sql = postgres(testEnv().DATABASE_URL, { max: 2, onnotice: () => {} });
  const admin = adminClient();
  let marcelaId = "";
  /** Marcela as the seed leaves her: no factor; nobody of the demo company required to have one. */
  const restoreSeed = async () => {
    await removeTotpFactors(admin, marcelaId);
    await sql`update kernel.memberships set mfa_required = false where company_id = ${DEMO_COMPANY_ID}`;
  };
  test.beforeAll(async () => {
    marcelaId = (await sql<{ id: string }[]>`select id from kernel.users where email = ${MARCELA.email}`)[0]!.id;
    await restoreSeed();
  });
  test.afterAll(async () => {
    await restoreSeed();
    await sql.end({ timeout: 5 });
  });

  const openMfaDialog = async (page: Page) => {
    await page.getByRole("button", { name: "Menú de usuario" }).click();
    await page.getByRole("menuitem", { name: /Verificación en dos pasos/ }).click();
    const dialog = page.getByRole("dialog", { name: "Verificación en dos pasos" });
    await expect(dialog).toBeVisible();
    return dialog;
  };

  test("Marcela enrols from the user menu, signs in with the code, turns it off with a code and signs in with her password only", async ({ page }) => {
    test.setTimeout(120_000);
    const marcela = { email: MARCELA.email, password: MARCELA.password };
    await submitPassword(page, marcela);
    await expect(page).toHaveURL(/\/$/);

    // Not set up: "Activar" leads to the enrolment, which she may skip (her role does not require it).
    let dialog = await openMfaDialog(page);
    await expect(dialog).toContainText("No configurada");
    await dialog.getByRole("link", { name: "Activar" }).click();
    await expect(page).toHaveURL(/\/mfa\/enroll$/);
    await expect(page.getByRole("link", { name: "Omitir por ahora" })).toHaveAttribute("href", "/");
    const secret = (await page.getByTestId("totp-secret").textContent())!.trim();
    await page.getByLabel("Dígito 1").click();
    await page.keyboard.type(totpCode(secret));
    await expect(page).toHaveURL(/\/$/);
    expect(await verifiedTotpCount(admin, marcelaId)).toBe(1);

    // The next sign-in asks for the code.
    await page.getByRole("button", { name: "Menú de usuario" }).click();
    await page.getByRole("menuitem", { name: "Salir" }).click();
    await expect(page).toHaveURL(/\/login$/);
    await submitPassword(page, marcela);
    await expect(page).toHaveURL(/\/mfa\/verify$/);
    await page.getByLabel("Dígito 1").fill(totpCode(secret));
    await expect(page).toHaveURL(/\/$/);

    // On: "Desactivar" asks for a fresh code (step-up) inside the dialog, then the session ends with the notice.
    dialog = await openMfaDialog(page);
    await expect(dialog).toContainText("Activa");
    await dialog.getByRole("button", { name: "Desactivar" }).click();
    const code = dialog.getByLabel("Código de 6 dígitos");
    await expect(code).toBeFocused();
    await code.fill(totpCode(secret));
    await expect(page).toHaveURL(/\/login\?notice=mfa_disabled$/);
    await expect(page.getByRole("status")).toHaveText("Segundo paso desactivado. Vuelve a ingresar con tu contraseña.");
    expect(await verifiedTotpCount(admin, marcelaId)).toBe(0);
    expect((await sessionCookies(page)).filter((c) => c.value !== "")).toEqual([]);

    // Password only from now on.
    await submitPassword(page, marcela);
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByTestId("home")).toBeVisible();
    dialog = await openMfaDialog(page);
    await expect(dialog).toContainText("No configurada");
  });
});
