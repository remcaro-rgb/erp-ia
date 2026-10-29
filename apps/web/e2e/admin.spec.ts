import { randomUUID } from "node:crypto";
import { expect, test, type Browser, type Page } from "@playwright/test";
import { enrolTotp, seedAuthUser, totpCode, type AuthFixture } from "../test-support/auth-fixtures";

// Administration in a real browser (design §6, prototype v5 "Administración"): the admin creates a role, assigns a
// user to it from the role's side and toggles a permission in the matrix, each change confirmed with the step-up code;
// the assigned user sees the menu item the permission unlocks appear, and disappear again when it is revoked. The
// matrices stage their cells and apply them together with one code (OD-7, kernel.admin.*.set_many).

/** The admin processes the system admin role holds (the company defaults grant it every process). */
const ADMIN_PROCESSES = [
  "kernel.admin.role.create",
  "kernel.admin.role.update",
  "kernel.admin.user_role.set",
  "kernel.admin.user.create",
  "kernel.admin.permission.set",
  "kernel.admin.permission.matrix",
  "kernel.admin.field_permission.set",
  "kernel.admin.permission.set_many",
  "kernel.admin.field_permission.set_many",
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
  /** A plain role with nothing granted, for the batch tests. */
  let despachos = "";

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
    const [shipping] = await sql<{ id: string }[]>`insert into kernel.roles(company_id, name) values (${companyId}, 'Despachos') returning id`;
    despachos = shipping!.id;
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
    await sql`delete from kernel.roles where id = ${despachos}`;
    await sql`delete from core.parties where company_id = ${companyId}`;
    await sql`delete from core.entity_sequences where company_id = ${companyId}`;
    await sql`delete from kernel.outbox where company_id = ${companyId}`;
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
    // The click stages the cell; "Aplicar cambios" sends it with the code.
    await toggle.check();
    await expect(page.locator(".erp-admin__bar").getByText("1 cambio sin aplicar")).toBeVisible();
    await page.getByRole("button", { name: "Aplicar cambios" }).click();
    await confirmStepUp(page, secret);
    await expect(saved).toBeVisible();
    await expect(page.locator(".erp-admin__bar")).toContainText("Cambios guardados");
    expect((await matrix.boundingBox())!.y).toBe(top);
    expect((await page.locator(".erp-admin__bar").boundingBox())!.y).toBeGreaterThan(top);
    await expect(toggle).toBeChecked();
    expect(await pedroMenu(browser)).toContain("Importar datos");

    await toggle.uncheck();
    await page.getByRole("button", { name: "Aplicar cambios" }).click();
    await confirmStepUp(page, secret);
    await expect(saved).toBeVisible();
    await expect(toggle).not.toBeChecked();
    expect(await pedroMenu(browser)).not.toContain("Importar datos");
  });

  const cell = (page: Page, processId: string, role = "Despachos") => page.getByRole("row").filter({ hasText: processId }).getByRole("checkbox", { name: `${role} ${processId}` });
  const stepUps = async () => Number((await fixture.sql<{ n: string }[]>`select count(*) as n from kernel.step_up_verifications where company_id = ${companyId}`)[0]!.n);
  const grantsOf = async (roleId: string) =>
    (await fixture.sql<{ process_id: string }[]>`select process_id from kernel.process_permissions where role_id = ${roleId} and allowed order by process_id`).map((r) => r.process_id);

  test("the matrix stages three cells and applies them with one code; a reload shows them", async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await signInWithCode(page, fixture.email, fixture.password, secret);
    await page.goto("/admin/permissions");
    const bar = page.locator(".erp-admin__bar");
    await expect(bar.getByText("Sin cambios pendientes", { exact: false })).toBeVisible();
    // The count of staged changes is a live region of the bar.
    await expect(bar.locator(".erp-admin__pending")).toHaveAttribute("role", "status");

    // Two clicks and a Space on a focused cell: three staged cells, marked pending, counted in the bar's live region.
    await cell(page, "kernel.import.run").check();
    await cell(page, "kernel.export.run").check();
    await cell(page, "core.party.create").focus();
    await page.keyboard.press("Space");
    await expect(cell(page, "core.party.create")).toBeChecked();
    await expect(bar.locator(".erp-admin__pending")).toHaveText("3 cambios sin aplicar");
    for (const id of ["kernel.import.run", "kernel.export.run", "core.party.create"]) {
      await expect(page.getByRole("row").filter({ hasText: id }).locator("td.is-dirty").filter({ has: page.getByRole("checkbox", { name: `Despachos ${id}` }) })).toHaveCount(1);
      await expect(cell(page, id)).toHaveAccessibleName(`Despachos ${id} (sin aplicar)`);
    }
    // Unticking a staged cell puts it back: no longer a change.
    await cell(page, "kernel.export.run").uncheck();
    await expect(bar.locator(".erp-admin__pending")).toHaveText("2 cambios sin aplicar");
    await cell(page, "kernel.export.run").check();
    expect(await grantsOf(despachos)).toEqual([]);

    // Leaving with staged changes asks first, in the page.
    await page.getByRole("navigation", { name: "Secciones de administración" }).getByRole("link", { name: "Roles" }).click();
    const leave = page.getByRole("alertdialog", { name: "Hay cambios sin aplicar" });
    await expect(leave).toBeVisible();
    await leave.getByRole("button", { name: "Seguir editando" }).click();
    await expect(leave).toHaveCount(0);
    await expect(page).toHaveURL(/\/admin\/permissions$/);
    // So does the browser's Back.
    await page.goBack();
    await expect(leave).toBeVisible();
    await expect(page).toHaveURL(/\/admin\/permissions$/);
    await leave.getByRole("button", { name: "Seguir editando" }).click();
    await expect(bar.locator(".erp-admin__pending")).toHaveText("3 cambios sin aplicar");

    // One apply, one code, one batch.
    const before = await stepUps();
    await bar.getByRole("button", { name: "Aplicar cambios" }).click();
    await confirmStepUp(page, secret);
    await expect(bar.getByText("Cambios guardados")).toBeVisible();
    await expect(bar.locator(".erp-admin__pending")).toHaveText("");
    expect((await stepUps()) - before).toBe(1);
    expect(await grantsOf(despachos)).toEqual(["core.party.create", "kernel.export.run", "kernel.import.run"]);
    const [audit] = await fixture.sql<{ input: { changes: unknown[] } }[]>`
      select input from kernel.audit_log where company_id = ${companyId} and process_id = 'kernel.admin.permission.set_many' and action = 'update' order by occurred_at desc limit 1`;
    expect(audit!.input.changes).toHaveLength(3);

    await page.reload();
    for (const id of ["kernel.import.run", "kernel.export.run", "core.party.create"]) await expect(cell(page, id)).toBeChecked();
    await expect(page.locator("td.is-dirty")).toHaveCount(0);

    // A module's "todos" stages every process of the module for the role, "ninguno" takes them back; Descartar drops all.
    const core = page.getByRole("button", { name: "Dar a Despachos todos los procesos de Núcleo" });
    await core.click();
    await expect(bar.locator(".erp-admin__pending")).toHaveText(/^\d+ cambios sin aplicar$/);
    await expect(cell(page, "core.product.update")).toBeChecked();
    await page.getByRole("button", { name: "Quitar a Despachos todos los procesos de Núcleo" }).click();
    await expect(cell(page, "core.party.create")).not.toBeChecked();
    await expect(bar.locator(".erp-admin__pending")).toHaveText("1 cambio sin aplicar");
    await bar.getByRole("button", { name: "Descartar" }).click();
    await expect(cell(page, "core.party.create")).toBeChecked();
    await expect(page.locator("td.is-dirty")).toHaveCount(0);

    // Sistema: the administration processes are the admin role's only, locked for Despachos and left out of "todos",
    // so the module applies cleanly and the button turns into "ninguno".
    await expect(cell(page, "kernel.admin.role.create")).toBeDisabled();
    await expect(page.getByRole("row").filter({ hasText: "kernel.admin.role.create" }).locator("label[title='Solo el rol admin ejecuta los procesos de administración']")).toHaveCount(3);
    await page.getByRole("button", { name: "Dar a Despachos todos los procesos de Sistema" }).click();
    await expect(cell(page, "kernel.admin.role.create")).not.toBeChecked();
    await bar.getByRole("button", { name: "Aplicar cambios" }).click();
    await confirmStepUp(page, secret);
    await expect(bar.getByText("Cambios guardados")).toBeVisible();
    await expect(page.getByRole("button", { name: "Quitar a Despachos todos los procesos de Sistema" })).toBeVisible();
    const held = await grantsOf(despachos);
    expect(held).toContain("kernel.audit.consult");
    expect(held.filter((id) => id.startsWith("kernel.admin.") || id.startsWith("kernel.required_file.") || id === "kernel.verifier.set")).toEqual([]);
  });

  test("an invalid batch marks the refused cell, keeps the changes staged and applies nothing", async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    const { sql } = fixture;
    // A role that disappears while its cell is staged: the batch is refused at that change, whatever else it carries.
    const [temporary] = await sql<{ id: string }[]>`insert into kernel.roles(company_id, name) values (${companyId}, 'Temporal') returning id`;
    await signInWithCode(page, fixture.email, fixture.password, secret);
    await page.goto("/admin/permissions");
    const before = await grantsOf(despachos);
    const bar = page.locator(".erp-admin__bar");

    await cell(page, "core.product.create").check();
    await cell(page, "core.party.consult", "Temporal").check();
    await cell(page, "core.product.update").check();
    await sql`delete from kernel.roles where id = ${temporary!.id}`;
    await bar.getByRole("button", { name: "Aplicar cambios" }).click();
    await confirmStepUp(page, secret);
    await expect(bar.getByRole("alert")).toContainText("El rol no pertenece a la empresa");
    await expect(page.locator("td.is-refused")).toHaveCount(1);
    const refused = cell(page, "core.party.consult", "Temporal");
    await expect(page.getByRole("row").filter({ hasText: "core.party.consult" }).locator("td.is-refused").filter({ has: page.getByRole("checkbox", { name: /^Temporal / }) })).toHaveCount(1);
    await expect(refused).toHaveAttribute("aria-invalid", "true");
    await expect(refused).toHaveAccessibleDescription("El rol no pertenece a la empresa");
    await expect(bar.locator(".erp-admin__refused")).toHaveText("1 cambio rechazado");
    await expect(bar.locator(".erp-admin__pending")).toHaveText("3 cambios sin aplicar");
    expect(await grantsOf(despachos)).toEqual(before);

    // Staging the cell again (here through the module's "todos") clears its mark; "ninguno" takes those cells back.
    await page.getByRole("button", { name: "Dar a Temporal todos los procesos de Núcleo" }).click();
    await expect(page.locator("td.is-refused")).toHaveCount(0);
    await expect(bar.locator(".erp-admin__refused")).toHaveCount(0);
    await page.getByRole("button", { name: "Quitar a Temporal todos los procesos de Núcleo" }).click();
    await expect(bar.locator(".erp-admin__pending")).toHaveText("2 cambios sin aplicar");
    await bar.getByRole("button", { name: "Aplicar cambios" }).click();
    await confirmStepUp(page, secret);
    await expect(bar.getByText("Cambios guardados")).toBeVisible();
    expect(await grantsOf(despachos)).toEqual([...before, "core.product.create", "core.product.update"].sort());
  });

  test("field visibility stages several fields and applies them with one code", async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await signInWithCode(page, fixture.email, fixture.password, secret);
    const { sql } = fixture;
    const [fleeting] = await sql<{ id: string }[]>`insert into kernel.roles(company_id, name) values (${companyId}, 'Efímero') returning id`;
    await page.goto("/admin/fields");
    const bar = page.locator(".erp-admin__bar");
    const field = (name: string, role = "Despachos") => page.getByRole("row").filter({ hasText: name }).getByRole("combobox", { name: new RegExp(`^${role} `) });
    const entity = page.getByLabel("Entidad", { exact: true });

    // A refused cell of an entity no longer on screen: the bar says how many and where.
    await field("credit_limit", "Efímero").selectOption("hidden");
    await entity.selectOption("core.product");
    await field("brand").selectOption("masked");
    await sql`delete from kernel.roles where id = ${fleeting!.id}`;
    await bar.getByRole("button", { name: "Aplicar cambios" }).click();
    await confirmStepUp(page, secret);
    await expect(bar.locator(".erp-admin__refused")).toHaveText("1 cambio rechazado · también en Tercero");
    await expect(bar.locator(".erp-admin__pending")).toHaveText("2 cambios sin aplicar");
    await bar.getByRole("button", { name: "Descartar" }).click();
    await expect(bar.locator(".erp-admin__refused")).toHaveCount(0);
    await entity.selectOption("core.party");
    await field("credit_limit").selectOption("hidden");
    await field("trade_name").selectOption("masked");
    await expect(bar.locator(".erp-admin__pending")).toHaveText("2 cambios sin aplicar");
    await expect(page.locator("td.is-dirty")).toHaveCount(2);
    const before = await stepUps();
    await bar.getByRole("button", { name: "Aplicar cambios" }).click();
    await confirmStepUp(page, secret);
    await expect(bar.getByText("Cambios guardados")).toBeVisible();
    expect((await stepUps()) - before).toBe(1);
    const modes = await fixture.sql<{ field: string; mode: string }[]>`
      select field, mode from kernel.field_permissions where role_id = ${despachos} and entity = 'core.party' and field in ('credit_limit', 'trade_name') order by field`;
    expect(modes).toEqual([
      { field: "credit_limit", mode: "hidden" },
      { field: "trade_name", mode: "masked" },
    ]);
    await page.reload();
    await expect(field("credit_limit")).toHaveValue("hidden");
    await expect(field("trade_name")).toHaveValue("masked");

    // Back with a staged change asks; leaving drops it.
    await field("trade_name").selectOption("visible");
    await page.goBack();
    const leave = page.getByRole("alertdialog", { name: "Hay cambios sin aplicar" });
    await expect(leave).toBeVisible();
    await expect(page).toHaveURL(/\/admin\/fields$/);
    await leave.getByRole("button", { name: "Salir sin aplicar" }).click();
    await expect(page).toHaveURL(/\/$/);
    const [kept] = await sql<{ mode: string }[]>`select mode from kernel.field_permissions where role_id = ${despachos} and entity = 'core.party' and field = 'trade_name'`;
    expect(kept!.mode).toBe("masked");
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

  test("the audit names processes, entities and actors, and an entry lists each changed field as antes → después", async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    const { sql } = fixture;
    // The change to read: the trade name of a party, typed in its record and saved (core.party.update).
    const [party] = await sql<{ id: string }[]>`
      insert into core.parties (company_id, kind, person_type, document_type, document_number, legal_name, dian_status)
      values (${companyId}, ${["customer"]}, '1', '31', '900373115', 'Bosque Andino S.A.S.', 'complete') returning id`;
    await signInWithCode(page, fixture.email, fixture.password, secret);
    await page.goto(`/r/core.party/${party!.id}`);
    await page.getByLabel("Nombre comercial").fill("Bosque QA");
    await page.getByRole("button", { name: "Guardar" }).click();
    await expect.poll(async () => (await sql`select trade_name from core.parties where id = ${party!.id}`)[0]?.trade_name).toBe("Bosque QA");

    await page.goto("/admin/audit");
    const audit = page.getByRole("region", { name: "Auditoría" });
    await audit.getByLabel("Filtrar Proceso").fill("core.party.update");
    // Proceso by its description (id below), Entidad by its name, Registro and Actor as links.
    const row = audit.getByRole("row", { name: /Actualiza los datos de un tercero/ }).first();
    await expect(row).toContainText("core.party.update");
    await expect(row).toContainText("Tercero");
    await expect(row.getByRole("link", { name: "Bosque Andino S.A.S." })).toHaveAttribute("href", `/r/core.party/${party!.id}`);
    await expect(row.getByRole("link", { name: /^Auth user / })).toHaveAttribute("href", `/admin/users/${fixture.userId}`);

    await row.click();
    const sheet = page.getByRole("dialog", { name: "Actualiza los datos de un tercero y recalcula su estado DIAN" });
    await expect(sheet.getByRole("listitem").filter({ hasText: "Nombre comercial" })).toHaveText("Nombre comercial · — → Bosque QA");
    await expect(sheet.getByRole("link", { name: "Bosque Andino S.A.S." })).toHaveAttribute("href", `/r/core.party/${party!.id}`);
    await page.keyboard.press("Escape");
    await expect(sheet).toBeHidden();
  });
});
