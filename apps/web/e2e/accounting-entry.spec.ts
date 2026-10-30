import { randomUUID } from "node:crypto";
import type { Page } from "@playwright/test";
import { expect, test } from "../test-support/streamed";
import { seedAuthUser, type AuthFixture } from "../test-support/auth-fixtures";

// The comprobante record (accounting design §4.6, §4.7, §5.5, §8, Task 27): a Nota de contabilidad written with the keyboard, saved
// as a draft, supported with a file and posted; and the four-eyes flow, where the creator sends it to approval, cannot approve
// it, and another person posts it.

const PROCESSES = [
  "accounting.entry.consult",
  "accounting.entry.create",
  "accounting.entry.update",
  "accounting.entry.void",
  "accounting.entry.submit",
  "accounting.entry.post",
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

/** A draft in NC written with the keyboard: 50.000 from Caja (débito) to Ventas (crédito). */
async function writeEntry(page: Page, description: string) {
  await page.goto("/r/accounting.entry/new");
  await page.getByRole("textbox", { name: "Descripción", exact: true }).fill(description);
  // Line 1: account by search, Tab across tercero and centro de costo to the débito; Enter on the crédito opens line 2.
  await cell(page, "Cuenta, Línea 1").click();
  await page.keyboard.type("1105");
  await expect(page.getByRole("option", { name: "110505 · Caja general" })).toBeVisible();
  await page.keyboard.press("Tab");
  await expect(cell(page, "Tercero, Línea 1")).toBeFocused();
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
  await expect(cell(page, "Crédito, Línea 2")).toBeFocused();
  await page.keyboard.type("50000");
  await page.keyboard.press("Tab");
  // The footer is balanced before saving.
  const totals = page.getByRole("group", { name: "Totales del comprobante" });
  await expect(totals.locator("[data-total=difference]")).toHaveText("$ 0,00");
  await expect(totals).toContainText("Cuadrado");
  await page.getByRole("button", { name: "Crear", exact: true }).click();
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

  test("Nota de contabilidad: create, add two lines with the keyboard, attach, Contabilizar → NC-<n>", async ({ page }) => {
    await page.setViewportSize({ width: 1400, height: 900 });
    await signIn(page, andres);

    // The grid opens on the quick filters and Nuevo opens the record in its tab.
    await page.goto("/accounting/entries");
    await expect(page.getByRole("button", { name: "Borradores" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Por aprobar" })).toBeVisible();
    await page.getByRole("button", { name: "Nuevo", exact: true }).click();
    await expect(page).toHaveURL(/\/r\/accounting\.entry\/new$/);

    // Only the Fuentes that accept manual entries are offered.
    await expect(page.getByLabel("Fuente", { exact: true })).toContainText("NC · Nota de contabilidad");
    await expect(page.getByLabel("Fuente", { exact: true })).not.toContainText("Ventas");

    await writeEntry(page, "Nota de prueba del teclado");
    await expect(page.getByText("Borrador", { exact: true }).first()).toBeVisible();

    // The support goes to the Archivos tab.
    await page.getByRole("tab", { name: /Archivos/ }).click();
    const chosen = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: "elígelos" }).click();
    await (await chosen).setFiles({ name: "soporte.pdf", mimeType: "application/pdf", buffer: PDF });
    await page.getByLabel("Etiqueta… soporte.pdf").selectOption({ label: "Otra…" });
    await page.getByLabel("nombre de la etiqueta").fill("Soporte");
    await page.getByRole("button", { name: /Subir 1 archivo/ }).click();
    await expect(page.locator(".erp-attachments__list")).toContainText("soporte.pdf");

    // Contabilizar: the number comes from the Fuente's consecutivo.
    await page.getByRole("tab", { name: "Datos", exact: true }).click();
    await page.getByRole("button", { name: "Contabilizar", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "Contabilizado como NC-1" })).toBeVisible();
    await expect(page.getByText("Contabilizado", { exact: true }).first()).toBeVisible();
    const [posted] = await andres.sql`select number, status, total_debit from accounting.entries where company_id = ${companyId}`;
    expect(posted).toMatchObject({ number: "NC-1", status: "posted" });
    expect(Number(posted!.total_debit)).toBe(50000);
    // A posted comprobante is read-only and can be reversed.
    await expect(page.getByRole("button", { name: "Reversar", exact: true })).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Descripción", exact: true })).toBeDisabled();

    // Origen: a manual comprobante says so.
    await page.getByRole("tab", { name: "Origen" }).click();
    await expect(page.getByText("Comprobante manual: lo creó una persona.")).toBeVisible();
  });

  test("with four-eyes on: andres sends it to approval and cannot approve it, laura approves and posts", async ({ page, browser }) => {
    await page.setViewportSize({ width: 1400, height: 900 });
    await andres.sql`update accounting.settings set require_approval_on_manual = true where company_id = ${companyId}`;
    await signIn(page, andres);
    await writeEntry(page, "Nota con aprobación");

    // A draft goes to approval, not straight to the books.
    await expect(page.getByRole("button", { name: "Contabilizar", exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "Enviar a aprobación" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Enviado a aprobación" })).toBeVisible();
    await expect(page.getByText("Por aprobar", { exact: true }).first()).toBeVisible();

    // The creator sees the approve button disabled, with the reason in plain sight; Devolver a borrador is theirs.
    await expect(page.getByRole("button", { name: "Aprobar y contabilizar" })).toBeDisabled();
    await expect(page.getByText("Otra persona debe aprobar")).toBeVisible();
    await expect(page.getByRole("button", { name: "Devolver a borrador" })).toBeVisible();
    const entryId = page.url().split("/").pop()!;

    const other = await browser.newContext();
    const lauraPage = await other.newPage();
    await signIn(lauraPage, laura);
    await lauraPage.goto(`/r/accounting.entry/${entryId}`);
    const approve = lauraPage.getByRole("button", { name: "Aprobar y contabilizar" });
    await expect(approve).toBeEnabled();
    await approve.click();
    await expect(lauraPage.getByRole("status").filter({ hasText: /Contabilizado como NC-\d+/ })).toBeVisible();
    const [row] = await andres.sql`select number, status, submitted_by, posted_by from accounting.entries where id = ${entryId}`;
    expect(row).toMatchObject({ status: "posted", submitted_by: andres.userId, posted_by: laura.userId });
    expect(row!.number).toMatch(/^NC-\d+$/);
    await other.close();
  });
});
