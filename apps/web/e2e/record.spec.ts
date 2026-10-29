import { expect, test, type Page } from "@playwright/test";
import postgres from "postgres";
import { DEMO_COMPANY_ID, LAURA } from "../../../scripts/demo/accounts";
import { seedAuthUser, totpCode, type AuthFixture } from "../test-support/auth-fixtures";
import { testEnv } from "../test-support/env";

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
    // The DIAN status in words from the catalogue, never the stored code (`complete`, `missing: 4`).
    await expect(status).toContainText(/DIAN: (completo|faltan? \d+ datos?)/);
    await expect(status).not.toContainText(/complete|missing/);
    await tab(page, /Archivos/).click();
    const warning = page.locator(".erp-attachments__warning");
    await expect(warning).toContainText("Mientras falten RUT");
    // The chooser is a real button: the keyboard reaches it and Enter opens the system file chooser (rule 22).
    const chosen = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: "elígelos" }).focus();
    await page.keyboard.press("Enter");
    await (await chosen).setFiles({ name: "rut.pdf", mimeType: "application/pdf", buffer: PDF });
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

  test("an unknown record, or one the role may not see, shows the Spanish not-found page inside the shell", async ({ page }) => {
    await signIn(page, fixture);
    await page.goto("/r/core.party/0190d8b2-1c1e-7000-8000-000000000000");
    await expect(page.getByRole("heading", { name: "No encontrado" })).toBeVisible();
    await expect(page.getByText("No encontramos este registro o no tienes acceso a él")).toBeVisible();
    await expect(page.getByText("This page could not be found")).toHaveCount(0);
    // Inside the shell: the active tab says what happened, not "Registro".
    const tabs = page.getByRole("navigation", { name: "Pestañas abiertas" });
    await expect(tabs.locator('[aria-current="page"]')).toHaveAccessibleName("No encontrado");
    await page.getByRole("link", { name: "Volver al inicio" }).click();
    await expect(page).toHaveURL(/\/$/);
  });
});

// "Duplicar" on the demo company (rule 37, design §22.13; `pnpm db:reset && DEMO_SEED=1 pnpm db:seed`): Laura copies
// Almacenes Éxito, the copy opens without its NIT and is refused until one is typed, the new party is created through
// core.party.create and the audit viewer shows where it came from.
test.describe("Duplicar on the demo company", () => {
  const sql = postgres(testEnv().DATABASE_URL, { max: 2, onnotice: () => {} });
  // A NIT no seeded party uses. Cleanup removes only copies of Éxito (rows whose creation the audit records as cloned
  // from it), never a party found by its NIT alone, so a seeded record can never be lost.
  const NIT = "901777001";
  let exitoId = "";
  const started = new Date();
  const forgetCopies = (since?: Date) => sql`
    delete from core.parties
    where company_id = ${DEMO_COMPANY_ID}
      and id in (select row_id from kernel.audit_log
                 where source_row_id = ${exitoId} and process_id = 'core.party.create' and action = 'insert'
                   and occurred_at >= ${since ?? new Date(0)})
      ${since ? sql`` : sql`and document_number = ${NIT}`}`;

  test.beforeAll(async () => {
    const [exito] = await sql<{ id: string }[]>`select id from core.parties where company_id = ${DEMO_COMPANY_ID} and document_number = '890900608'`;
    exitoId = exito.id;
    // A copy an interrupted earlier run left; then the NIT must be free (else the demo data changed: reseed).
    await forgetCopies();
    const taken = await sql`select legal_name from core.parties where company_id = ${DEMO_COMPANY_ID} and document_number = ${NIT}`;
    expect(taken, `NIT ${NIT} belongs to a party that is not a copy of Éxito: reseed the demo data`).toHaveLength(0);
  });
  test.afterAll(async () => {
    await forgetCopies(started);
    await sql.end({ timeout: 5 });
  });

  test("Duplicar Éxito → a new NIT → saved, and the audit shows clonado desde Almacenes Éxito", async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    const exito = { id: exitoId };
    await page.goto("/login");
    await page.getByLabel("Correo").fill(LAURA.email);
    await page.getByLabel("Contraseña", { exact: true }).fill(LAURA.password);
    await page.getByRole("button", { name: "Entrar" }).click();
    await expect(page).toHaveURL(/\/mfa\/verify$/);
    await page.getByLabel("Dígito 1").fill(totpCode(LAURA.totpSecret!));
    await expect(page).toHaveURL(/\/$/);

    await page.goto(`/r/core.party/${exito.id}`);
    await expect(page.getByRole("heading", { name: "Almacenes Éxito S.A." })).toBeVisible();
    await expect(page.getByRole("button", { name: "Duplicar" })).toHaveAttribute("aria-keyshortcuts", "Control+D Meta+D");
    // The shortcut, from the page (not from a text box): the browser's bookmark is not what happens.
    await page.getByRole("heading", { name: "Almacenes Éxito S.A." }).click();
    await page.keyboard.press("ControlOrMeta+d");

    // The create form, prefilled from the copy: the record's data is not in the URL.
    await expect(page).toHaveURL(/\/r\/core\.party\/new$/);
    const banner = page.getByRole("status").filter({ hasText: "Copia de" });
    await expect(banner).toContainText("Copia de Almacenes Éxito S.A.");
    await expect(banner.getByRole("link", { name: "Almacenes Éxito S.A." })).toHaveAttribute("href", `/r/core.party/${exito.id}`);
    // The router keeps the source's page alive but hidden: the visible boxes are the copy's.
    await expect(page.getByRole("textbox", { name: /^Razón social/ })).toHaveValue("Almacenes Éxito S.A.");
    const number = page.getByRole("textbox", { name: /^Número/ });
    await expect(number).toHaveValue("");

    // Without a NIT the party's own create process refuses it, as for a hand-typed one.
    await page.getByRole("button", { name: "Crear", exact: true }).click();
    await expect(number).toHaveAttribute("aria-invalid", "true");
    await expect(page).toHaveURL(/\/r\/core\.party\/new$/);

    await number.fill(NIT);
    await page.getByRole("button", { name: "Crear", exact: true }).click();
    await expect(page).toHaveURL(/\/r\/core\.party\/[0-9a-f-]{36}$/);
    const [clone] = await sql<{ id: string; legal_name: string; check_digit: string }[]>`
      select id, legal_name, check_digit from core.parties where company_id = ${DEMO_COMPANY_ID} and document_number = ${NIT}`;
    expect(clone).toMatchObject({ legal_name: "Almacenes Éxito S.A." });
    await expect(page).toHaveURL(new RegExp(`/r/core\\.party/${clone!.id}$`));
    const [entry] = await sql`select source_row_id from kernel.audit_log where row_id = ${clone!.id} and process_id = 'core.party.create' and diff is null`;
    expect(entry!.source_row_id).toBe(exito.id);
    // Contacts and files stay with the source.
    expect((await sql`select 1 from kernel.attachments where record_id = ${clone!.id}`).length).toBe(0);
    expect((await sql`select 1 from core.party_contacts where party_id = ${clone!.id}`).length).toBe(0);

    await page.goto("/admin/audit");
    const audit = page.getByRole("region", { name: "Auditoría" });
    await audit.getByLabel("Filtrar Proceso").fill("core.party.create");
    const row = audit.getByRole("row", { name: /clonado desde/ }).first();
    await expect(row).toContainText("clonado desde Almacenes Éxito");
    // Registro is the copy (same name) and the origin links the source.
    await expect(row.locator(`a[href="/r/core.party/${clone!.id}"]`)).toHaveText("Almacenes Éxito S.A.");
    await expect(row.locator(`a[href="/r/core.party/${exito.id}"]`)).toHaveText("Almacenes Éxito S.A.");
  });
});
