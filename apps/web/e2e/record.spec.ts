import { expect, test, type Page } from "@playwright/test";
import { seedAuthUser, type AuthFixture } from "../test-support/auth-fixtures";

// The record page's tabs in a real browser (design §5.13, §5.14, §5.16, §5.18, prototype v5): a party's Contactos
// (add a contact, ask to verify its e-mail), Datos adicionales (edit a value and save it through the party's update
// process), Archivos (upload the required RUT and watch the readiness in the footer turn), and a product's Fotos
// (upload two, make the second principal, ask the assistant for a picture and approve it by making it principal).

const PROCESSES = [
  "core.party.consult",
  "core.party.update",
  "core.contact.list",
  "core.contact.create",
  "core.contact.update",
  "core.contact.delete",
  "core.product.consult",
  "core.product.update",
  "core.category.consult",
  "kernel.custom_field.list",
  "kernel.attachment.list",
  "kernel.attachment.add",
  "kernel.attachment.remove",
  "kernel.attachment.reorder",
  "kernel.ai.image_suggest",
  "kernel.verify.request",
  "kernel.verify.status",
];

// A 1×1 PNG and a minimal PDF: the upload route sniffs the first bytes.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const PDF = Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n");

async function signIn(page: Page, fixture: AuthFixture) {
  await page.goto("/login");
  await page.getByLabel("Correo").fill(fixture.email);
  await page.getByLabel("Contraseña", { exact: true }).fill(fixture.password);
  await page.getByRole("button", { name: "Entrar" }).click();
  await expect(page).toHaveURL(/\/$/);
}

const tab = (page: Page, name: string | RegExp) => page.getByRole("tab", { name });

test.describe("record tabs", () => {
  let fixture: AuthFixture;
  let companyId: string;
  let partyId: string;
  let productId: string;

  test.beforeAll(async () => {
    fixture = await seedAuthUser({ role: "member" });
    companyId = fixture.companyIds[0]!;
    const { sql } = fixture;
    await sql`insert into kernel.tenant_entitlements(tenant_id, key, source) values (${fixture.tenantId}, 'module:core', 'manual')`;
    const [role] = await sql<{ id: string }[]>`select id from kernel.roles where company_id = ${companyId}`;
    for (const process of PROCESSES) {
      await sql`insert into kernel.process_permissions(company_id, role_id, process_id) values (${companyId}, ${role!.id}, ${process})`;
    }
    // One required file for a Colombian party, and one data field the admin defined.
    await sql`insert into kernel.required_attachments(company_id, entity, tag, kind, required, condition, description)
              values (${companyId}, 'core.party', 'RUT', 'pdf', true, 'co', 'Registro Único Tributario vigente')`;
    const roles = [role!.id];
    await sql`insert into kernel.custom_fields(company_id, entity, key, label, type, max_length, required, roles_enter, roles_edit, roles_view)
              values (${companyId}, 'core.party', 'canal', 'Canal de venta', 'text', 30, false, ${roles}, ${roles}, ${roles})`;
    const [party] = await sql<{ id: string }[]>`
      insert into core.parties ${sql({
        company_id: companyId,
        kind: ["customer"],
        person_type: "1",
        document_type: "31",
        document_number: "900373115",
        legal_name: "Café del Norte S.A.S.",
        tax_responsibilities: ["O-13"],
        tax_scheme: "01",
        country_code: "CO",
        department_code: "11",
        municipality_code: "11001",
        address_line: "Cra 7 # 71-21",
        invoice_email: "fe@cafedelnorte.co",
        dian_status: "complete",
      })} returning id`;
    partyId = party!.id;
    const [category] = await sql<{ id: string }[]>`insert into core.product_categories (company_id, name, iva_rate, default_uom) values (${companyId}, 'Café', '5', 'KGM') returning id`;
    const [product] = await sql<{ id: string }[]>`
      insert into core.products ${sql({
        company_id: companyId,
        sku: "CAF-GRA-500",
        description: "Café en grano 500 g",
        kind: "good",
        id_scheme: "999",
        uom_code: "KGM",
        iva_rate: "5",
        list_price: 31000,
        track_stock: true,
        category_id: category!.id,
        dian_status: "complete",
      })} returning id`;
    productId = product!.id;
  });

  test.afterAll(async () => {
    const { sql } = fixture;
    await sql.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      await tx`delete from kernel.attachments where company_id = ${companyId}`;
    });
    await sql`delete from kernel.verification_requests where company_id = ${companyId}`;
    for (const table of ["products", "product_categories", "party_contacts", "parties", "entity_sequences"]) {
      await sql`delete from ${sql(`core.${table}`)} where company_id = ${companyId}`;
    }
    await sql`delete from kernel.custom_fields where company_id = ${companyId}`;
    await sql`delete from kernel.required_attachments where company_id = ${companyId}`;
    await sql`delete from kernel.outbox where company_id = ${companyId}`;
    await sql`delete from kernel.process_permissions where company_id = ${companyId}`;
    await sql`delete from kernel.tenant_entitlements where tenant_id = ${fixture.tenantId}`;
    await fixture.cleanup();
  });

  test("adds a contact to a party and asks to verify its e-mail", async ({ page }) => {
    await signIn(page, fixture);
    await page.goto(`/r/core.party/${partyId}`);
    await tab(page, /Contactos/).click();
    // The tabs stay mounted, so each step is scoped to its panel (the Datos tab has an e-mail field too).
    const contacts = page.locator(".erp-contacts");
    await contacts.getByRole("button", { name: "+ Nuevo contacto" }).click();
    await contacts.getByLabel("Nombre", { exact: true }).fill("Ana Gómez");
    await contacts.getByLabel("Cargo").fill("Tesorera");
    await contacts.getByLabel("Correo").fill("ana@cafedelnorte.co");
    // Verificar sits next to the valid e-mail; with no provider the request is queued.
    await contacts.getByRole("button", { name: "Verificar ↗" }).first().click();
    await expect(contacts.getByText("en cola").first()).toBeVisible();
    await contacts.getByRole("button", { name: "Agregar contacto" }).click();
    const row = contacts.getByRole("row", { name: /Ana Gómez/ });
    await expect(row).toContainText("Tesorera");
    await expect(row).toContainText("ana@cafedelnorte.co");
    // It is stored: the tab's count and a reload show it.
    await page.reload();
    await tab(page, /Contactos/).click();
    await expect(page.locator(".erp-contacts").getByRole("row", { name: /Ana Gómez/ })).toBeVisible();
    const [stored] = await fixture.sql`select name, email from core.party_contacts where party_id = ${partyId}`;
    expect(stored).toMatchObject({ name: "Ana Gómez", email: "ana@cafedelnorte.co" });
    // The queued status survives the reload (kernel.verify.status), and the button waits: no second request.
    await page.locator(".erp-contacts").getByRole("button", { name: "Ana Gómez", exact: true }).click();
    await expect(contacts.getByText("en cola").first()).toBeVisible();
    await expect(contacts.getByRole("button", { name: "Verificar ↗" }).first()).toBeDisabled();
    expect((await fixture.sql`select 1 from kernel.verification_requests where record_id = ${partyId} and kind = 'email'`).length).toBe(1);
  });

  test("edits a datos adicionales value and saves it", async ({ page }) => {
    await signIn(page, fixture);
    await page.goto(`/r/core.party/${partyId}`);
    await tab(page, /Datos adicionales/).click();
    const extra = page.locator(".erp-extra");
    await extra.getByLabel(/Canal de venta/).fill("Mayoristas");
    await page.getByRole("button", { name: "Guardar datos adicionales" }).click();
    await expect(page.getByText("Datos adicionales guardados")).toBeVisible();
    await page.reload();
    await tab(page, /Datos adicionales/).click();
    await expect(page.locator(".erp-extra").getByLabel(/Canal de venta/)).toHaveValue("Mayoristas");
    // A free pair too.
    await page.getByRole("button", { name: "+ Agregar dato" }).click();
    await page.locator(".erp-extra").getByLabel("Nombre", { exact: true }).last().fill("Ruta");
    await page.locator(".erp-extra").getByLabel("Valor", { exact: true }).last().fill("Norte 3");
    await page.getByRole("button", { name: "Guardar datos adicionales" }).click();
    await expect(page.getByText("Datos adicionales guardados")).toBeVisible();
    const [stored] = await fixture.sql`select extra, extra_free from core.parties where id = ${partyId}`;
    expect(stored).toMatchObject({ extra: { canal: "Mayoristas" }, extra_free: [{ name: "Ruta", value: "Norte 3" }] });
  });

  test("uploads the required RUT and the footer says the party can go on invoices", async ({ page }) => {
    await signIn(page, fixture);
    await page.goto(`/r/core.party/${partyId}`);
    const status = page.getByTestId("record-status");
    await expect(status).toContainText("No se puede usar en facturas");
    await tab(page, /Archivos/).click();
    const warning = page.locator(".erp-attachments__warning");
    await expect(warning).toContainText("Mientras falten RUT");
    await page.locator(".erp-attachments input[type=file]").setInputFiles({ name: "rut.pdf", mimeType: "application/pdf", buffer: PDF });
    // The file name suggests the tag.
    await expect(page.getByLabel("Etiqueta… rut.pdf")).toHaveValue("RUT");
    await page.getByRole("button", { name: /Subir 1 archivo/ }).click();
    await expect(page.locator(".erp-attachments__list")).toContainText("rut.pdf");
    // The page refreshed the record: the checklist is satisfied and the footer changed.
    await expect(warning).toHaveCount(0);
    await expect(status).toContainText("Se puede usar en facturas");
    const [row] = await fixture.sql`select invoice_ready from core.parties where id = ${partyId}`;
    expect(row!.invoice_ready).toBe(true);
    // Removing it takes the readiness away again.
    await page.getByRole("button", { name: "Quitar rut.pdf" }).click();
    await page.getByRole("button", { name: "Sí, quitar" }).click();
    await expect(status).toContainText("No se puede usar en facturas");
  });

  test("makes a product photo principal, and approves an AI suggestion by making it principal", async ({ page }) => {
    await signIn(page, fixture);
    await page.goto(`/r/core.product/${productId}`);
    await tab(page, /Fotos/).click();
    const chooser = page.locator(".erp-photos input[type=file]");
    await chooser.setInputFiles([
      { name: "empaque.png", mimeType: "image/png", buffer: PNG },
      { name: "taza.png", mimeType: "image/png", buffer: PNG },
    ]);
    const thumbs = page.locator(".erp-photos__thumb img");
    await expect(thumbs).toHaveCount(2);
    await expect(thumbs.nth(0)).toHaveAttribute("alt", "empaque.png");

    // taza.png is the one shown after the upload; make it principal.
    await page.getByRole("button", { name: "Hacer principal" }).click();
    const badge = page.locator(".erp-photos .erp-pill");
    await expect(badge).toContainText("principal · subida");
    await page.reload();
    await tab(page, /Fotos/).click();
    await expect(thumbs).toHaveCount(2);
    await expect(thumbs.nth(0)).toHaveAttribute("alt", "taza.png");

    // Sugerir foto con IA stores a Foto · IA picture, marked as a suggestion until it is made principal.
    await page.getByRole("button", { name: "✨ Sugerir foto con IA" }).click();
    await expect(thumbs).toHaveCount(3);
    await thumbs.nth(2).click();
    await expect(badge).toContainText("sugerida por IA");
    // The suggestion is a file of the record: the Archivos tab lists it without a reload.
    await tab(page, /Archivos/).click();
    await expect(page.locator(".erp-attachments__list")).toContainText("sugerencia-ia-1.svg");
    await tab(page, /Fotos/).click();
    const [suggested] = await fixture.sql`select suggested, tag, mime_type from kernel.attachments where record_id = ${productId} and tag = 'Foto · IA'`;
    expect(suggested).toMatchObject({ suggested: true, mime_type: "image/svg+xml" });
    await page.getByRole("button", { name: "Hacer principal" }).click();
    await expect(badge).toContainText("principal · subida");
    await expect(badge).not.toContainText("sugerida por IA");
    const [approved] = await fixture.sql`select suggested from kernel.attachments where record_id = ${productId} and tag = 'Foto · IA'`;
    expect(approved!.suggested).toBe(false);
  });
});
