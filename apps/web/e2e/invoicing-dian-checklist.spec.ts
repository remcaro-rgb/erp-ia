import { expect, test } from "../test-support/streamed";
import { cleanupCompanies } from "../test-support/company-cleanup";
import { enrolTotp, seedAuthUser, type AuthFixture } from "../test-support/auth-fixtures";
import { confirmStepUp, signInWithCode } from "../test-support/accounting-fixture";

// Parámetros › Facturación electrónica › Lista de verificación DIAN (plan 2B Task 35; R35-11, R35-14): the company's administrator opens the
// checklist from Conexión DIAN, ticks the 23 values (by group), saves them with one verification code, confirms the defaults, and then
// attempts producción: the refusal is now the transport's (the e2e server runs the mock, which never serves producción: Task 5/17 ruling,
// owner item 84), not the checklist's. Unticking one item clears the confirmation. A user who is not an administrator cannot open it.

const PROCESSES = [
  "invoicing.settings.consult", "invoicing.settings.update", "invoicing.dian_checklist.tick", "invoicing.dian_checklist.consult", "invoicing.dian_defaults.confirm",
];

const grant = async (fixture: AuthFixture, roleName: "admin" | "member") => {
  const { sql } = fixture;
  const companyId = fixture.companyIds[0]!;
  for (const key of ["module:core", "module:accounting", "module:invoicing", "module:sales", "module:inventory"]) {
    await sql`insert into kernel.tenant_entitlements(tenant_id, key, source) values (${fixture.tenantId}, ${key}, 'manual') on conflict do nothing`;
  }
  const [role] = await sql<{ id: string }[]>`select id from kernel.roles where company_id = ${companyId} and name = ${roleName}`;
  for (const process of PROCESSES) await sql`insert into kernel.process_permissions(company_id, role_id, process_id) values (${companyId}, ${role!.id}, ${process}) on conflict do nothing`;
};

const cleanup = async (fixture: AuthFixture | undefined) => {
  if (!fixture) return;
  try {
    await cleanupCompanies(fixture.sql, fixture.companyIds, fixture.tenantId);
  } finally {
    await fixture.cleanup();
  }
};

test.describe("Lista de verificación DIAN", () => {
  test.describe.configure({ mode: "serial" });
  let admin: AuthFixture;
  let secret: string;

  test.beforeAll(async () => {
    admin = await seedAuthUser({ role: "admin" });
    secret = await enrolTotp(admin);
    await grant(admin, "admin");
  });

  test.afterAll(async () => {
    await cleanup(admin);
  });

  test("the administrator ticks the 23 values, confirms the defaults, finds producción refused by the transport, and unticking one clears the confirmation", async ({ page }) => {
    test.setTimeout(180_000);
    const companyId = admin.companyIds[0]!;
    const state = async () => (await admin.sql<{ environment: string; confirmed: boolean; version: number | null; ticked: number }[]>`
      select coalesce(s.dian_environment, 'habilitacion') as environment, coalesce(s.dian_defaults_confirmed, false) as confirmed, s.dian_checklist_version as version,
             (select count(*)::int from invoicing.dian_checks c where c.company_id = k.id and c.ticked) as ticked
      from kernel.companies k left join invoicing.settings s on s.company_id = k.id where k.id = ${companyId}`)[0]!;
    await page.setViewportSize({ width: 1440, height: 900 });
    await signInWithCode(page, admin, secret);

    // From Conexión DIAN: no checkbox any more, the progress and the link.
    await page.goto("/invoicing/settings");
    const dian = page.getByRole("region", { name: "Conexión DIAN" });
    await expect(dian.getByText("Valores por defecto DIAN: 0 de 23 verificados")).toBeVisible();
    await dian.getByRole("link", { name: "Abrir la lista de verificación" }).click();
    await expect(page.getByRole("heading", { name: "Lista de verificación DIAN" })).toBeVisible();
    await expect(page).toHaveURL(/\/invoicing\/settings\/checklist$/);
    const progress = page.getByRole("progressbar");
    await expect(progress).toHaveAttribute("aria-valuenow", "0");
    await expect(page.getByText("0 de 23 verificados").first()).toBeVisible();
    await expect(page.getByRole("button", { name: "Confirmar valores por defecto", exact: true })).toBeDisabled();
    for (const group of ["Notas y tipos de documento", "Firma y software", "Respuesta de la DIAN y reenvío", "Impuestos e importes", "Medios de pago y compradores", "Perfil fiscal del emisor", "Infraestructura", "Tablas de referencia"]) {
      await expect(page.getByRole("heading", { name: group })).toBeVisible();
    }
    await expect(page.getByRole("checkbox")).toHaveCount(23);

    // Select every group, one code for the one run.
    const select = page.getByRole("button", { name: /^Seleccionar el grupo/ });
    await expect(select).toHaveCount(8);
    for (let i = 0; i < 8; i++) await select.first().click();
    await expect(page.getByText("23 cambios sin guardar")).toBeVisible();
    await page.getByRole("button", { name: "Marcar los seleccionados" }).click();
    await confirmStepUp(page, secret);
    await expect(page.getByText("Verificación guardada", { exact: true })).toBeVisible();
    await expect(page.getByText("23 de 23 verificados").first()).toBeVisible();
    await expect(progress).toHaveAttribute("aria-valuenow", "23");
    await expect(page.getByText(/Verificado por .+ el \d{4}\/\d{2}\/\d{2}/).first()).toBeVisible();
    expect(await state()).toMatchObject({ environment: "habilitacion", confirmed: false, version: null, ticked: 23 });

    // Confirm the defaults.
    await page.getByRole("button", { name: "Confirmar valores por defecto", exact: true }).click();
    await confirmStepUp(page, secret);
    await expect(page.getByTestId("confirmed")).toContainText("Valores confirmados el");
    expect(await state()).toMatchObject({ confirmed: true, version: 1, ticked: 23 });

    // Producción with the checklist confirmed: the refusal is the transport's (the mock never serves producción), not the checklist's.
    await page.goto("/invoicing/settings");
    await expect(dian.getByText("Valores por defecto DIAN: confirmados")).toBeVisible();
    await dian.getByLabel("Ambiente DIAN").selectOption({ label: "Producción" });
    await dian.getByRole("button", { name: "Guardar conexión" }).click();
    await confirmStepUp(page, secret);
    await expect(dian.getByRole("alert")).toContainText("EINVOICE_TRANSPORT=dian-produccion");
    await expect(dian.getByRole("alert")).not.toContainText("lista de verificación");
    expect(await state()).toMatchObject({ environment: "habilitacion", confirmed: true });

    // Unticking one item (a second code) ends the confirmation, in the same run.
    await page.goto("/invoicing/settings/checklist");
    await expect(page.getByTestId("confirmed")).toBeVisible();
    await page.getByRole("checkbox", { name: /La espera entre consultas de la respuesta/ }).uncheck();
    await page.getByRole("button", { name: "Guardar cambios" }).click();
    await confirmStepUp(page, secret);
    await expect(page.getByText("22 de 23 verificados").first()).toBeVisible();
    await expect(page.getByText(/Confirma de nuevo los valores por defecto/)).toBeVisible();
    await expect(page.getByTestId("confirmed")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Confirmar valores por defecto", exact: true })).toBeDisabled();
    expect(await state()).toMatchObject({ confirmed: false, version: null, ticked: 22 });
  });
});

test.describe("Lista de verificación DIAN for a user who is not an administrator", () => {
  let member: AuthFixture;
  let secret: string;

  test.beforeAll(async () => {
    member = await seedAuthUser({ role: "member" });
    secret = await enrolTotp(member);
    await grant(member, "member");
  });

  test.afterAll(async () => {
    await cleanup(member);
  });

  test("cannot open the checklist (even holding the processes)", async ({ page }) => {
    test.setTimeout(90_000);
    await signInWithCode(page, member, secret);
    await page.goto("/invoicing/settings/checklist");
    await expect(page.locator(".erp-dian--bad")).toHaveText("Solo los administradores de la empresa abren la lista de verificación DIAN");
    await expect(page.getByRole("progressbar")).toHaveCount(0);
    await expect(page.getByRole("checkbox")).toHaveCount(0);
  });
});
