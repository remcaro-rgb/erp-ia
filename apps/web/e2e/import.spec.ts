import { expect, test, type Page } from "@playwright/test";
import { enrolTotp, seedAuthUser, totpCode, type AuthFixture } from "../test-support/auth-fixtures";

// Mass import in a real browser (design §9, prototype "Importar"): Terceros › Importar, a CSV with Spanish headers
// previewed row by row, "Importar filas válidas" with the step-up code, the import workflow running in the app, and
// the history on Importar datos with its counts and errores.csv.

const PROCESSES = [
  "core.party.consult",
  "core.party.create",
  "kernel.saved_view.list",
  "kernel.attachment.add",
  "kernel.attachment.list",
  "kernel.import.template",
  "kernel.import.preview",
  "kernel.import.run",
  "kernel.import.list",
];

const HEADER = "Tipo de tercero;Tipo de persona;Tipo de documento;Número de documento;Razón social;Responsabilidades fiscales;Régimen tributario;País;Departamento;Municipio;Dirección;Correo de facturación";
const line = (doc: string, name: string) => `customer;1;31;${doc};${name};O-13;01;CO;11;11001;Cra 1 # 2-3;fe@empresa.co`;

async function signIn(page: Page, fixture: AuthFixture, secret: string) {
  await page.goto("/login");
  await page.getByLabel("Correo").fill(fixture.email);
  await page.getByLabel("Contraseña", { exact: true }).fill(fixture.password);
  await page.getByRole("button", { name: "Entrar" }).click();
  await expect(page).toHaveURL(/\/mfa\/verify$/);
  await page.getByLabel("Dígito 1").fill(totpCode(secret));
  await expect(page).toHaveURL(/\/$/);
}

test.describe("mass import", () => {
  let fixture: AuthFixture;
  let secret: string;
  let companyId: string;

  test.beforeAll(async () => {
    fixture = await seedAuthUser({ role: "admin" });
    secret = await enrolTotp(fixture);
    companyId = fixture.companyIds[0]!;
    const { sql } = fixture;
    await sql`insert into kernel.tenant_entitlements(tenant_id, key, source) values (${fixture.tenantId}, 'module:core', 'manual')`;
    const [role] = await sql<{ id: string }[]>`select id from kernel.roles where company_id = ${companyId}`;
    for (const process of PROCESSES) {
      await sql`insert into kernel.process_permissions(company_id, role_id, process_id) values (${companyId}, ${role!.id}, ${process})`;
    }
  });

  test.afterAll(async () => {
    const { sql } = fixture;
    for (const table of ["parties", "entity_sequences"]) await sql`delete from ${sql(`core.${table}`)} where company_id = ${companyId}`;
    await sql`delete from kernel.imports where company_id = ${companyId}`;
    await sql`delete from kernel.process_idempotency where company_id = ${companyId}`;
    await sql`delete from kernel.attachments where company_id = ${companyId}`;
    await sql`delete from kernel.outbox where company_id = ${companyId}`;
    await sql`delete from kernel.process_permissions where company_id = ${companyId}`;
    await sql`delete from kernel.tenant_entitlements where tenant_id = ${fixture.tenantId}`;
    await fixture.cleanup();
  });

  test("previews a CSV, imports its valid rows after the step-up and shows the result in the history", async ({ page }) => {
    test.setTimeout(120_000);
    await signIn(page, fixture, secret);
    await page.goto("/parties");
    await page.getByRole("button", { name: "Importar", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Importar terceros" });
    await expect(dialog.getByRole("link", { name: "Plantilla Excel" })).toHaveAttribute("href", "/api/import?entity=core.party&format=xlsx");

    const csv = [HEADER, line("900373115", "Lácteos Andinos S.A.S."), line("800197268", "Tostadora del Valle S.A.S."), line("800ABC123", "Mal Dato Ltda.")].join("\r\n");
    await dialog.locator("input[type=file]").setInputFiles({ name: "terceros.csv", mimeType: "text/csv", buffer: Buffer.from(csv, "utf8") });
    await expect(dialog.getByText("Vista previa · 3 filas")).toBeVisible();
    await expect(dialog.getByText("2 válidas")).toBeVisible();
    await expect(dialog.getByText("31: solo dígitos")).toBeVisible();

    await dialog.getByRole("button", { name: "Importar filas válidas" }).click();
    // The code box has the caret and the 6th digit sends it (no Verificar click).
    await expect(dialog.getByLabel("Código de 6 dígitos")).toBeFocused();
    await dialog.getByLabel("Código de 6 dígitos").fill(totpCode(secret));
    await expect(dialog.getByText("Importación en curso", { exact: false })).toBeVisible();

    await dialog.getByRole("link", { name: "Ver historial" }).click();
    await expect(page).toHaveURL(/\/import$/);
    const row = page.getByRole("row").filter({ hasText: "terceros.csv" });
    await expect(row.getByText("terminada")).toBeVisible({ timeout: 60_000 });
    await expect(row.getByRole("cell", { name: "2", exact: true })).toBeVisible();
    await expect(row.getByRole("cell", { name: "1", exact: true })).toBeVisible();
    await expect(row.getByRole("button", { name: "errores.csv" })).toBeVisible();

    // The history says how fresh it is, and a failed read is said on screen with Reanudar (UI density audit quick win 10).
    const history = page.locator(".erp-import__history");
    await history.getByRole("button", { name: "Actualizar" }).click();
    await expect(history.getByText(/^Actualizado \d{2}:\d{2}:\d{2}$/)).toBeVisible();
    // The network drops: the read of the history fails.
    await page.route(/\/api\/import$/, (route) => route.abort("internetdisconnected"));
    await history.getByRole("button", { name: "Actualizar" }).click();
    await expect(history.getByRole("status")).toContainText("Sin conexión");
    await page.unroute(/\/api\/import$/);
    await history.getByRole("button", { name: "Reanudar" }).click();
    await expect(history.getByText(/^Actualizado \d{2}:\d{2}:\d{2}$/)).toBeVisible();

    const parties = await fixture.sql<{ document_number: string }[]>`select document_number from core.parties where company_id = ${companyId} order by document_number`;
    expect(parties.map((p) => p.document_number)).toEqual(["800197268", "900373115"]);
  });
});
