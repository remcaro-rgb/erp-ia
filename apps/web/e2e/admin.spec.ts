import { randomUUID } from "node:crypto";
import { expect, test, type Browser, type Page } from "@playwright/test";
import { enrolTotp, seedAuthUser, totpCode, type AuthFixture } from "../test-support/auth-fixtures";

// Administration in a real browser (design §6, prototype v5 "Administración"): the admin creates a role, assigns a
// user to it from the role's side and toggles a permission in the matrix, each change confirmed with the step-up code;
// the assigned user sees the menu item the permission unlocks appear, and disappear again when it is revoked.

/** The admin processes the system admin role holds (the company defaults grant it every process). */
const ADMIN_PROCESSES = [
  "kernel.admin.role.create",
  "kernel.admin.role.update",
  "kernel.admin.user_role.set",
  "kernel.admin.user.create",
  "kernel.admin.permission.set",
  "kernel.admin.permission.matrix",
  "kernel.admin.field_permission.set",
  "kernel.admin.sensitive_process.set",
  "kernel.admin.module.enable",
  "kernel.admin.module.disable",
  "kernel.admin.ai_usage.consult",
  "kernel.admin.company.update",
  "kernel.required_file.set",
  "kernel.required_file.remove",
  "kernel.verifier.set",
  "kernel.custom_field.set",
  "kernel.custom_field.remove",
  "core.party.consult",
];

async function signInWithCode(page: Page, email: string, password: string, secret: string) {
  await page.goto("/login");
  await page.getByLabel("Correo").fill(email);
  await page.getByLabel("Contraseña", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Entrar" }).click();
  await expect(page).toHaveURL(/\/mfa\/verify$/);
  await page.getByLabel("Dígito 1").fill(totpCode(secret));
  await expect(page).toHaveURL(/\/$/);
}

async function signIn(page: Page, email: string, password: string) {
  await page.goto("/login");
  await page.getByLabel("Correo").fill(email);
  await page.getByLabel("Contraseña", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Entrar" }).click();
  await expect(page).toHaveURL(/\/$/);
}

/** Answers the step-up prompt the sensitive admin process raised: the box has the caret and the 6th digit sends it. */
async function confirmStepUp(page: Page, secret: string) {
  const code = page.getByLabel("Código de 6 dígitos");
  await expect(code).toBeFocused();
  await code.fill(totpCode(secret));
}

test.describe("administration", () => {
  let fixture: AuthFixture;
  let secret: string;
  let companyId: string;
  const pedro = { email: `pedro-${randomUUID().slice(0, 8)}@test.local`, password: `pw-${randomUUID()}`, id: "" };

  test.beforeAll(async () => {
    fixture = await seedAuthUser({ role: "admin" });
    secret = await enrolTotp(fixture);
    companyId = fixture.companyIds[0]!;
    const { sql } = fixture;
    await sql`insert into kernel.tenant_entitlements(tenant_id, key, source) values (${fixture.tenantId}, 'module:core', 'manual')`;
    const [adminRole] = await sql<{ id: string }[]>`select id from kernel.roles where company_id = ${companyId} and name = 'admin'`;
    for (const process of ADMIN_PROCESSES) {
      await sql`insert into kernel.process_permissions(company_id, role_id, process_id) values (${companyId}, ${adminRole!.id}, ${process})`;
    }
    // A second member of the company, with a plain role and no permissions yet.
    const { data, error } = await fixture.admin.auth.admin.createUser({ email: pedro.email, password: pedro.password, email_confirm: true });
    if (error || !data.user) throw new Error(`could not create pedro: ${error?.message}`);
    pedro.id = data.user.id;
    await sql`insert into kernel.users(id, email, full_name) values (${pedro.id}, ${pedro.email}, 'Pedro Ruiz')`;
    const [plain] = await sql<{ id: string }[]>`insert into kernel.roles(company_id, name) values (${companyId}, 'invitado') returning id`;
    const [membership] = await sql<{ id: string }[]>`insert into kernel.memberships(user_id, company_id) values (${pedro.id}, ${companyId}) returning id`;
    await sql`insert into kernel.membership_roles(membership_id, role_id) values (${membership!.id}, ${plain!.id})`;
  });

  test.afterAll(async () => {
    const { sql } = fixture;
    await sql`delete from kernel.membership_roles where membership_id in (select id from kernel.memberships where user_id = ${pedro.id})`;
    await sql`delete from kernel.memberships where user_id = ${pedro.id}`;
    await sql`delete from kernel.user_prefs where user_id = ${pedro.id}`;
    await sql`delete from kernel.step_up_verifications where company_id = ${companyId}`;
    await sql`delete from kernel.sensitive_processes where company_id = ${companyId}`;
    await sql`delete from kernel.field_permissions where company_id = ${companyId}`;
    await sql`delete from kernel.process_permissions where company_id = ${companyId}`;
    await sql`delete from kernel.tenant_entitlements where tenant_id = ${fixture.tenantId}`;
    await sql`delete from kernel.users where id = ${pedro.id}`;
    await fixture.admin.auth.admin.deleteUser(pedro.id);
    await fixture.cleanup();
  });

  /** Pedro's module bar, read in a fresh session (his roles are claims of the session's JWT). */
  async function pedroMenu(browser: Browser): Promise<string[]> {
    const context = await browser.newContext();
    const page = await context.newPage();
    await signIn(page, pedro.email, pedro.password);
    const items = page.locator("header").first().getByRole("navigation", { name: "Menú del módulo" }).getByRole("button");
    await expect(items.first()).toBeVisible();
    const texts = await items.allTextContents();
    await context.close();
    return texts.map((t) => t.trim());
  }

  test("creates a role, assigns a user, and a permission toggles that user's menu item", async ({ page, browser }) => {
    test.setTimeout(180_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await signInWithCode(page, fixture.email, fixture.password, secret);

    // Sistema › Administración is in the admin's menus.
    await page.goto("/admin/roles");
    await expect(page.getByRole("heading", { level: 1, name: "Administración" })).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Secciones de administración" }).getByRole("link", { name: "Roles" })).toHaveAttribute("aria-current", "page");

    // A role is created with its party scope; the step-up code confirms it.
    await page.getByRole("button", { name: "Nuevo rol" }).click();
    const create = page.getByRole("dialog", { name: "Nuevo rol" });
    await create.getByLabel("Nombre").fill("Bodega");
    await create.getByLabel("Descripción").fill("Recibe y despacha mercancía");
    await create.getByLabel("Ve terceros").selectOption("proveedores");
    await create.getByRole("button", { name: "Crear rol" }).click();
    await confirmStepUp(page, secret);
    const row = page.getByRole("row").filter({ hasText: "Bodega" });
    await expect(row).toBeVisible();
    await expect(row.getByText("Solo proveedores")).toBeVisible();

    // Pedro is assigned from the role's side.
    await row.getByRole("button", { name: "Editar y asignar" }).click();
    const edit = page.getByRole("dialog", { name: "Rol · Bodega" });
    await edit.getByRole("checkbox", { name: /Pedro Ruiz/ }).check();
    await edit.getByRole("button", { name: "Guardar" }).click();
    await confirmStepUp(page, secret);
    await expect(row.getByText("Pedro Ruiz")).toBeVisible();

    // The role starts with the consults: Pedro sees Terceros but not Importar datos.
    const before = await pedroMenu(browser);
    expect(before).toContain("Terceros");
    expect(before).not.toContain("Importar datos");

    // The matrix: roles as columns, the entity name beside each process id.
    await page.goto("/admin/permissions");
    const importRow = page.getByRole("row").filter({ hasText: "kernel.import.run" });
    await expect(importRow.getByText("Importación", { exact: true })).toBeVisible();
    const toggle = importRow.getByRole("checkbox", { name: "Bodega kernel.import.run" });
    await expect(toggle).not.toBeChecked();
    const saved = page.getByRole("status").filter({ hasText: "Cambios guardados" });
    // The outcome lands in the fixed bar under the matrix, so the table never moves under the pointer (UI density audit
    // quick win 3), and the process column stays in view when the roles scroll sideways.
    const matrix = page.locator("table.erp-matrix");
    await toggle.scrollIntoViewIfNeeded();
    const top = (await matrix.boundingBox())!.y;
    await expect(importRow.locator(".erp-matrix__left")).toHaveCSS("position", "sticky");
    await toggle.check();
    await confirmStepUp(page, secret);
    await expect(saved).toBeVisible();
    await expect(page.locator(".erp-admin__bar")).toContainText("Cambios guardados");
    expect((await matrix.boundingBox())!.y).toBe(top);
    expect((await page.locator(".erp-admin__bar").boundingBox())!.y).toBeGreaterThan(top);
    await expect(toggle).toBeChecked();
    expect(await pedroMenu(browser)).toContain("Importar datos");

    await toggle.uncheck();
    await confirmStepUp(page, secret);
    await expect(saved).toBeVisible();
    await expect(toggle).not.toBeChecked();
    expect(await pedroMenu(browser)).not.toContain("Importar datos");
  });

  test("every administration section opens for the admin; a member is told they may not administer", async ({ page, browser }) => {
    const problems: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error") problems.push(message.text());
    });
    await signInWithCode(page, fixture.email, fixture.password, secret);
    const sections: [string, string][] = [
      ["/admin/users", "Usuarios"],
      ["/admin/fields", "Visibilidad por campo y rol"],
      ["/admin/extra", "Tercero"],
      ["/admin/required-files", "Tercero"],
      ["/admin/sensitive", "Procesos que exigen verificación en dos pasos"],
      ["/admin/verifiers", "Verificación externa de datos"],
      ["/admin/modules", "Núcleo"],
      ["/admin/companies", "Empresa"],
      ["/admin/ai-usage", "Por usuario"],
    ];
    for (const [href, heading] of sections) {
      await page.goto(href);
      await expect(page.getByText(heading, { exact: true }).first()).toBeVisible();
    }
    // Field visibility: the confidential credit limit of parties is marked.
    await page.goto("/admin/fields");
    await expect(page.getByRole("row").filter({ hasText: "credit_limit" }).getByText("confidencial")).toBeVisible();
    await expect(page.getByRole("row").filter({ hasText: "credit_limit" }).locator(".erp-matrix__left")).toHaveCSS("position", "sticky");
    await expect(page.locator(".erp-admin__bar")).toContainText("El rol admin ve todos los campos");
    // An RSC request cut short by the next navigation is not a problem of the screens.
    expect(problems.filter((text) => !/ERR_ABORTED|Failed to fetch RSC payload/.test(text))).toEqual([]);

    const context = await browser.newContext();
    const other = await context.newPage();
    await signIn(other, pedro.email, pedro.password);
    await other.goto("/admin/roles");
    await expect(other.getByRole("alert").getByText("No tienes permiso.")).toBeVisible();
    await context.close();
  });
});
