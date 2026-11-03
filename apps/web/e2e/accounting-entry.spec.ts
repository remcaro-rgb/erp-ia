import { randomUUID } from "node:crypto";
import type { Page } from "@playwright/test";
import { expect, test } from "../test-support/streamed";
import { seedAuthUser, type AuthFixture } from "../test-support/auth-fixtures";

// The comprobante record (accounting design §4.6, §4.7, §5.5, §8, Task 27; entity types spec §5, §8; Task 15 action bar, D15): a Nota
// de contabilidad written with the keyboard and posted by «Guardar» in the same action, then supported with a file; with approval the
// creator sends it with «Guardar y enviar a aprobación» and another person approves and posts it (the creator may too: owner rule);
// No aprobar with its reason; Eliminar a Borrador.

const PROCESSES = [
  "accounting.entry.consult",
  "accounting.entry.create",
  "accounting.entry.update",
  "accounting.entry.save",
  "accounting.entry.submit",
  "accounting.entry.approve",
  "accounting.entry.reject",
  "accounting.entry.void",
  "accounting.entry.delete",
  "accounting.entry.reverse",
  "accounting.settings.consult",
  "kernel.saved_view.list",
  "kernel.saved_view.save",
  "kernel.saved_view.delete",
  "kernel.custom_field.list",
  "kernel.attachment.list",
  "kernel.attachment.add",
  "kernel.attachment.remove",
  "kernel.export.run",
];

const PDF = Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n");

async function signIn(page: Page, user: { email: string; password: string }) {
  await page.goto("/login");
  await page.getByLabel("Correo").fill(user.email);
  await page.getByLabel("Contraseña", { exact: true }).fill(user.password);
  await page.getByRole("button", { name: "Entrar" }).click();
  await expect(page).toHaveURL(/\/$/);
}

const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

const cell = (page: Page, name: string) => page.getByRole(/^(Cuenta|Tercero|Centro)/.test(name) ? "combobox" : "textbox", { name, exact: true });

/** A new comprobante in NC written with the keyboard, not saved yet: 50.000 from Caja (débito) to Ventas (crédito). */
async function writeEntry(page: Page, description: string) {
  await page.goto("/r/accounting.entry/new");
  await page.getByRole("textbox", { name: "Descripción", exact: true }).fill(description);
  // Line 1: account by search, Tab across tercero, centro de costo and descripción to the débito; Enter on the crédito opens line 2.
  await cell(page, "Cuenta, Línea 1").click();
  await page.keyboard.type("1105");
  await expect(page.getByRole("option", { name: "110505 · Caja general" })).toBeVisible();
  await page.keyboard.press("Tab");
  await expect(cell(page, "Tercero, Línea 1")).toBeFocused();
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  await expect(cell(page, "Débito, Línea 1")).toBeFocused();
  await page.keyboard.type("50000");
  await page.keyboard.press("Tab");
  await expect(cell(page, "Crédito, Línea 1")).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(cell(page, "Cuenta, Línea 2")).toBeFocused();
  await page.keyboard.type("4135");
  await expect(page.getByRole("option", { name: "413505 · Ventas" })).toBeVisible();
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  await expect(cell(page, "Crédito, Línea 2")).toBeFocused();
  await page.keyboard.type("50000");
  await page.keyboard.press("Tab");
  // The footer is balanced before saving.
  const totals = page.getByRole("group", { name: "Totales del comprobante" });
  await expect(totals.locator("[data-total=difference]")).toHaveText("$ 0,00");
  await expect(totals).toContainText("Cuadrado");
}

const bar = (page: Page) => page.getByRole("group", { name: "Acciones del registro" });
/** Runs a button of the action bar and waits for the stored comprobante's page. */
async function press(page: Page, name: string) {
  await bar(page).getByRole("button", { name, exact: true }).click();
  await expect(page).toHaveURL(/\/r\/accounting\.entry\/[0-9a-f-]{36}$/);
}

test.describe("accounting entry", () => {
  let andres: AuthFixture;
  let laura: { email: string; password: string; userId: string };
  let companyId: string;

  test.beforeAll(async () => {
    andres = await seedAuthUser({ role: "member" });
    companyId = andres.companyIds[0]!;
    const { sql } = andres;
    await sql`insert into kernel.tenant_entitlements(tenant_id, key, source) values (${andres.tenantId}, 'module:accounting', 'manual')`;
    const [role] = await sql<{ id: string }[]>`select id from kernel.roles where company_id = ${companyId}`;
    for (const process of PROCESSES) {
      await sql`insert into kernel.process_permissions(company_id, role_id, process_id) values (${companyId}, ${role!.id}, ${process})`;
    }

    // Laura holds the same role in the same company.
    const suffix = randomUUID().slice(0, 8);
    laura = { email: `laura-${suffix}@test.local`, password: `pw-${randomUUID()}`, userId: "" };
    const created = await andres.admin.auth.admin.createUser({ email: laura.email, password: laura.password, email_confirm: true });
    if (created.error || !created.data.user) throw new Error(`could not create laura: ${created.error?.message}`);
    laura.userId = created.data.user.id;
    await sql`insert into kernel.users(id, email, full_name) values (${laura.userId}, ${laura.email}, 'Laura')`;
    const [membership] = await sql<{ id: string }[]>`insert into kernel.memberships(user_id, company_id) values (${laura.userId}, ${companyId}) returning id`;
    await sql`insert into kernel.membership_roles(membership_id, role_id) values (${membership!.id}, ${role!.id})`;

    // A small chart (parents first: a trigger derives the level and the parent from the code), two Fuentes, this month's period, settings.
    const chart: [string, string, "debit" | "credit"][] = [
      ["1", "Activo", "debit"], ["11", "Efectivo", "debit"], ["1105", "Caja", "debit"], ["110505", "Caja general", "debit"],
      ["4", "Ingresos", "credit"], ["41", "Operacionales", "credit"], ["4135", "Comercio", "credit"], ["413505", "Ventas", "credit"],
    ];
    for (const [code, name, nature] of chart) {
      await sql`insert into accounting.accounts (company_id, code, name, nature, allows_movement) values (${companyId}, ${code}, ${name}, ${nature}, ${code.length >= 6})`;
    }
    const [nc] = await sql<{ id: string }[]>`insert into accounting.journals (company_id, code, name, kind) values (${companyId}, 'NC', 'Nota de contabilidad', 'general') returning id`;
    await sql`insert into accounting.journals (company_id, code, name, kind, manual_entries) values (${companyId}, 'VT', 'Ventas', 'sales', false)`;
    const now = new Date();
    const [year] = await sql<{ id: string }[]>`
      insert into accounting.fiscal_years (company_id, year, starts_on, ends_on) values (${companyId}, ${now.getFullYear()}, ${`${now.getFullYear()}-01-01`}, ${`${now.getFullYear()}-12-31`}) returning id`;
    await sql`
      insert into accounting.periods (company_id, fiscal_year_id, number, starts_on, ends_on)
      values (${companyId}, ${year!.id}, ${now.getMonth() + 1}, ${iso(new Date(now.getFullYear(), now.getMonth(), 1))}, ${iso(new Date(now.getFullYear(), now.getMonth() + 1, 0))})`;
    await sql`insert into accounting.settings (company_id, manual_journal_id) values (${companyId}, ${nc!.id})`;
  });

  test.afterAll(async () => {
    const { sql } = andres;
    await sql.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      await tx`delete from kernel.attachments where company_id = ${companyId}`;
      for (const table of ["entry_lines", "entries", "settings", "journals", "periods", "fiscal_years", "accounts"]) await tx`delete from ${tx(`accounting.${table}`)} where company_id = ${companyId}`;
      await tx`delete from core.entity_sequences where company_id = ${companyId}`;
    });
    await sql`delete from kernel.saved_views where company_id = ${companyId}`;
    await sql`delete from kernel.user_prefs where company_id = ${companyId}`;
    await sql`delete from kernel.process_permissions where company_id = ${companyId}`;
    await sql`delete from kernel.tenant_entitlements where tenant_id = ${andres.tenantId}`;
    // Laura goes before the fixture removes the role she holds.
    await sql`delete from kernel.membership_roles where membership_id in (select id from kernel.memberships where user_id = ${laura.userId})`;
    await sql`delete from kernel.memberships where user_id = ${laura.userId}`;
    await sql`delete from kernel.users where id = ${laura.userId}`;
    await andres.admin.auth.admin.deleteUser(laura.userId);
    await andres.cleanup();
  });

  test("Nota de contabilidad: add two lines with the keyboard, Guardar posts it → NC-<n>, then attach the support", async ({ page }) => {
    await page.setViewportSize({ width: 1400, height: 900 });
    await signIn(page, andres);

    // The grid opens on the quick filters and Nuevo opens the record in its tab.
    await page.goto("/accounting/entries");
    await expect(page.getByRole("button", { name: "Borradores" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Por aprobar" })).toBeVisible();
    // An empty ledger also offers «Nuevo» in the grid's empty state: take the toolbar's.
    await page.getByRole("button", { name: "Nuevo", exact: true }).first().click();
    await expect(page).toHaveURL(/\/r\/accounting\.entry\/new$/);

    // Only the Fuentes that accept manual entries are offered.
    await expect(page.getByLabel("Fuente", { exact: true })).toContainText("NC · Nota de contabilidad");
    await expect(page.getByLabel("Fuente", { exact: true })).not.toContainText("Ventas");

    await writeEntry(page, "Nota de prueba del teclado");
    // No «Contabilizar» button: Guardar posts it in the same action (D8); the number comes from the Fuente's consecutivo.
    await expect(bar(page).getByRole("button", { name: /Contabilizar/ })).toHaveCount(0);
    await press(page, "Guardar");
    await expect(page.locator(".erp-record__header").filter({ visible: true }).getByText("Contabilizado", { exact: true })).toBeVisible();
    const [posted] = await andres.sql`select number, status, total_debit from accounting.entries where company_id = ${companyId}`;
    expect(posted).toMatchObject({ number: "NC-1", status: "posted" });
    expect(Number(posted!.total_debit)).toBe(50000);
    // A posted comprobante is read-only and can be reversed (Revertir, next to Duplicar).
    await expect(bar(page).getByRole("button", { name: "Revertir", exact: true })).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Descripción", exact: true })).toBeDisabled();

    // The support goes to the Archivos tab.
    await page.getByRole("tab", { name: /Archivos/ }).click();
    const chosen = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: "elígelos" }).click();
    await (await chosen).setFiles({ name: "soporte.pdf", mimeType: "application/pdf", buffer: PDF });
    await page.getByLabel("Etiqueta… soporte.pdf").selectOption({ label: "Otra…" });
    await page.getByLabel("nombre de la etiqueta").fill("Soporte");
    await page.getByRole("button", { name: /Subir 1 archivo/ }).click();
    await expect(page.locator(".erp-attachments__list")).toContainText("soporte.pdf");

    // Origen: a manual comprobante says so.
    await page.getByRole("tab", { name: "Origen" }).click();
    await expect(page.getByText("Comprobante manual: lo creó una persona.")).toBeVisible();
  });

  test("with approval: andres sends it with Guardar y enviar a aprobación and may approve it himself; laura approves and posts", async ({ page, browser }) => {
    await page.setViewportSize({ width: 1400, height: 900 });
    await andres.sql`update accounting.settings set require_approval_on_manual = true where company_id = ${companyId}`;
    await signIn(page, andres);
    await writeEntry(page, "Nota con aprobación");

    // With approval the new comprobante goes to approval in one action, not straight to the books.
    await press(page, "Guardar y enviar a aprobación");
    await expect(page.locator(".erp-record__header").filter({ visible: true }).getByText("Pendiente de Aprobación", { exact: true })).toBeVisible();
    const entryId = page.url().split("/").pop()!;
    await expect.poll(async () => (await andres.sql`select status from accounting.entries where id = ${entryId}`)[0]!.status).toBe("pending");

    // The creator may approve too (owner rule: no four-eyes); the comprobante is read-only while it waits.
    await expect(bar(page).getByRole("button", { name: "Aprobar", exact: true })).toBeEnabled();
    await expect(page.getByRole("textbox", { name: "Descripción", exact: true })).toBeDisabled();

    const other = await browser.newContext();
    const lauraPage = await other.newPage();
    await signIn(lauraPage, laura);
    await lauraPage.goto(`/r/accounting.entry/${entryId}`);
    const approve = bar(lauraPage).getByRole("button", { name: "Aprobar", exact: true });
    await expect(approve).toBeEnabled();
    await approve.click();
    await expect.poll(async () => (await andres.sql`select status from accounting.entries where id = ${entryId}`)[0]!.status).toBe("posted");
    const [row] = await andres.sql`select number, status, submitted_by, posted_by from accounting.entries where id = ${entryId}`;
    expect(row).toMatchObject({ status: "posted", submitted_by: andres.userId, posted_by: laura.userId });
    expect(row!.number).toMatch(/^NC-\d+$/);
    await other.close();
  });
  test("No aprobar: laura rejects it with a reason, andres edits the No Aprobado comprobante and sends it again", async ({ page, browser }) => {
    await page.setViewportSize({ width: 1400, height: 900 });
    await andres.sql`update accounting.settings set require_approval_on_manual = true where company_id = ${companyId}`;
    await signIn(page, andres);
    await writeEntry(page, "Nota para no aprobar");
    await press(page, "Guardar y enviar a aprobación");
    const entryId = page.url().split("/").pop()!;
    await expect.poll(async () => (await andres.sql`select status from accounting.entries where id = ${entryId}`)[0]!.status).toBe("pending");

    const other = await browser.newContext();
    const lauraPage = await other.newPage();
    await signIn(lauraPage, laura);
    await lauraPage.goto(`/r/accounting.entry/${entryId}`);
    await bar(lauraPage).getByRole("button", { name: "No aprobar", exact: true }).click();
    // The reason is required: Confirmar waits for it.
    await expect(bar(lauraPage).getByRole("button", { name: "Confirmar", exact: true })).toBeDisabled();
    await bar(lauraPage).getByRole("textbox", { name: "Motivo" }).fill("Falta el soporte");
    await bar(lauraPage).getByRole("button", { name: "Confirmar", exact: true }).click();
    await expect.poll(async () => (await andres.sql`select status from accounting.entries where id = ${entryId}`)[0]!.status).toBe("rejected");
    const [row] = await andres.sql`select status, submitted_by from accounting.entries where id = ${entryId}`;
    expect(row).toMatchObject({ status: "rejected", submitted_by: andres.userId });
    const [snapshot] = await andres.sql`select reason from kernel.record_snapshots where entity = 'accounting.entry' and record_id = ${entryId} and status = 'rejected'`;
    expect(snapshot).toMatchObject({ reason: "Falta el soporte" });
    await other.close();

    // The creator edits the No Aprobado comprobante and sends it again.
    await page.reload();
    await expect(page.locator(".erp-record__header").getByText("No Aprobado", { exact: true })).toBeVisible();
    await page.getByRole("textbox", { name: "Descripción", exact: true }).fill("Nota corregida");
    // Guardar y enviar a aprobación saves the edits and sends it again in one action.
    await bar(page).getByRole("button", { name: "Guardar y enviar a aprobación", exact: true }).click();
    await expect.poll(async () => (await andres.sql`select status from accounting.entries where id = ${entryId}`)[0]!.status).toBe("pending");
    const [again] = await andres.sql`select status, description from accounting.entries where id = ${entryId}`;
    expect(again).toMatchObject({ status: "pending", description: "Nota corregida" });
  });

  test("Eliminar: a Borrador is deleted after the confirmation and the tab closes", async ({ page }) => {
    await page.setViewportSize({ width: 1400, height: 900 });
    await andres.sql`update accounting.settings set require_approval_on_manual = false where company_id = ${companyId}`;
    await signIn(page, andres);
    // A Borrador is a comprobante not saved with Guardar yet (one made by Nuevo desde plantilla, an import or a refused posting).
    const [journal] = await andres.sql<{ id: string }[]>`select id from accounting.journals where company_id = ${companyId} and code = 'NC'`;
    const [draft] = await andres.sql<{ id: string }[]>`
      insert into accounting.entries (company_id, journal_id, date, status, origin, description) values (${companyId}, ${journal!.id}, ${iso(new Date())}, 'draft', 'manual', 'Nota para eliminar') returning id`;
    const entryId = draft!.id;
    await page.goto(`/r/accounting.entry/${entryId}`);
    await bar(page).getByRole("button", { name: "Eliminar", exact: true }).click();
    await expect(bar(page).getByText("¿Eliminar este registro? Queda la entrada de auditoría.")).toBeVisible();
    await bar(page).getByRole("button", { name: "Sí, eliminar", exact: true }).click();
    await expect(page).toHaveURL(/\/accounting\/entries$/);
    expect(await andres.sql`select id from accounting.entries where id = ${entryId}`).toHaveLength(0);
  });
});
