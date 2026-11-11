import type { Page } from "@playwright/test";
import { expect, test } from "../test-support/streamed";
import { enrolTotp, seedAuthUser, totpCode, type AuthFixture } from "../test-support/auth-fixtures";
import { cleanupCompanies } from "../test-support/company-cleanup";

// Configurable nested runs in a real browser (plan 2B Task 32, R32-7, R32-12, owner decisions item 1): the admin opens «Ejecuciones anidadas»,
// sets the depth and adds a pair chosen from the registry (crm.lead.convert runs core.party.create nested), each change confirmed with the
// step-up code; a nested process that posts to the ledger (the credit note of an annulment, nested in invoicing.invoice.void) cannot be set to
// «Continuar y encolar»; a failure queued for the pair (seeded as the service role, as the kernel would) shows on /nested-failures with the
// process names, the reason and the status but never the stored input, and Reintentar shows the process's refusal; a role without the grant
// gets the forbidden card.

const PARENT = "crm.lead.convert";
const NESTED = "core.party.create";
const LEDGER_PARENT = "invoicing.invoice.void";
const LEDGER_NESTED = "invoicing.note.issue_annulment";

async function signInWithCode(page: Page, email: string, password: string, secret: string) {
  await page.goto("/login");
  await page.getByLabel("Correo").fill(email);
  await page.getByLabel("Contraseña", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Entrar" }).click();
  await expect(page).toHaveURL(/\/mfa\/verify$/);
  await page.getByLabel("Dígito 1").fill(totpCode(secret));
  await expect(page).toHaveURL(/\/$/);
}

/** Answers the step-up prompt a sensitive process raised: the box has the caret and the 6th digit sends it. */
async function confirmStepUp(page: Page, secret: string) {
  const code = page.getByLabel("Código de 6 dígitos");
  await expect(code).toBeFocused();
  await code.fill(totpCode(secret));
}

test.describe("nested runs", () => {
  let fixture: AuthFixture;
  let plain: AuthFixture;
  let secret: string;

  test.beforeAll(async () => {
    test.setTimeout(120_000);
    fixture = await seedAuthUser({ role: "admin" });
    plain = await seedAuthUser({ role: "member" });
    secret = await enrolTotp(fixture);
    for (const key of ["module:core", "module:accounting", "module:inventory", "module:costing", "module:sales", "module:crm", "module:invoicing"]) {
      await fixture.sql`insert into kernel.tenant_entitlements(tenant_id, key, source) values (${fixture.tenantId}, ${key}, 'manual')`;
    }
  });

  test.afterAll(async () => {
    for (const f of [fixture, plain]) {
      if (!f) continue;
      try {
        await cleanupCompanies(f.sql, f.companyIds, f.tenantId);
      } finally {
        await f.cleanup();
      }
    }
  });

  test("the admin sets the depth and a pair, sees the ledger refusal, and works the queue; a role without the grant gets the forbidden card", async ({ page, browser }) => {
    test.setTimeout(180_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await signInWithCode(page, fixture.email, fixture.password, secret);

    // The section sits in the administration's bar, and the screen starts on the defaults.
    await page.goto("/admin/nested-runs");
    await expect(page.getByRole("navigation", { name: "Secciones de administración" }).getByRole("link", { name: "Ejecuciones anidadas" })).toHaveAttribute("aria-current", "page");
    await expect(page.getByRole("heading", { level: 2, name: "Ejecuciones anidadas" })).toBeVisible();
    await expect(page.getByLabel("Niveles permitidos")).toHaveValue("4");
    await expect(page.getByText("Aún no hay pares configurados")).toBeVisible();

    // The depth: 1 to 8, confirmed with the code.
    await page.getByLabel("Niveles permitidos").fill("6");
    await page.getByRole("button", { name: "Guardar niveles" }).click();
    await confirmStepUp(page, secret);
    await expect(page.getByRole("status").filter({ hasText: "Cambios guardados" })).toBeVisible();
    await page.reload();
    await expect(page.getByLabel("Niveles permitidos")).toHaveValue("6");

    // A nested process that posts to the ledger cannot continue: the option is off and the badge says why; the nestedOnlyFrom process offers only its parent.
    const add = page.getByRole("form", { name: "Agregar un par" });
    await add.getByLabel("Proceso anidado").selectOption(LEDGER_NESTED);
    await expect(add.getByText("Contabiliza o mueve existencias", { exact: true })).toBeVisible();
    await expect(add.getByRole("option", { name: "Continuar y encolar" })).toBeDisabled();
    await expect(add.getByText(`Este proceso solo corre dentro de: ${LEDGER_PARENT}`)).toBeVisible();
    await expect(add.getByLabel("Proceso padre")).toHaveValue(LEDGER_PARENT);
    await expect(add.getByLabel("Proceso padre").locator("option:not([value=''])")).toHaveCount(1);

    // A real pair from the registry: the parent's code covers the nested process and a failure continues and queues.
    await add.getByLabel("Proceso anidado").selectOption(NESTED);
    await expect(add.getByText("Contabiliza o mueve existencias", { exact: true })).toHaveCount(0);
    await add.getByLabel("Proceso padre").selectOption(PARENT);
    await add.getByLabel("La TOTP del padre cubre").check();
    await add.getByLabel("En caso de fallo").selectOption("continue");
    await add.getByRole("button", { name: "Agregar par" }).click();
    await confirmStepUp(page, secret);
    const row = page.getByRole("row").filter({ hasText: NESTED });
    await expect(row).toBeVisible();
    await expect(row.getByText(PARENT, { exact: true })).toBeVisible();
    await expect(row.getByRole("switch", { name: /La TOTP del padre cubre/ })).toHaveAttribute("aria-checked", "true");
    await expect(row.getByRole("combobox", { name: /En caso de fallo/ })).toHaveValue("continue");
    // The parent asks for no code itself: the screen says the option does nothing yet.
    await expect(row.getByText(/no pide verificación en dos pasos/)).toBeVisible();

    // The pair also stores: a second edit (back to «Revertir todo») goes through the same process.
    await row.getByRole("combobox", { name: /En caso de fallo/ }).selectOption("rollback");
    await confirmStepUp(page, secret);
    await expect(row.getByRole("combobox", { name: /En caso de fallo/ })).toHaveValue("rollback");
    const [saved] = await fixture.sql<{ parent_totp_covers: boolean; on_failure: string }[]>`
      select parent_totp_covers, on_failure from kernel.nested_run_pairs where company_id = ${fixture.companyIds[0]!} and parent_process = ${PARENT} and nested_process = ${NESTED}`;
    expect(saved).toEqual({ parent_totp_covers: true, on_failure: "rollback" });

    // The queue, seeded as the kernel would for that pair: names, reason and status, never the input.
    await fixture.sql`
      insert into kernel.nested_run_failures (company_id, parent_process, nested_process, input, error_code, reason, chain_id, actor_user_id, origin)
      values (${fixture.companyIds[0]!}, ${PARENT}, ${NESTED}, ${fixture.sql.json({ legalName: "DATO-SECRETO-DEL-INPUT" })}, 'invalid_input', 'El número de documento no es válido', gen_random_uuid(), ${fixture.userId}, 'ui')`;
    await page.goto("/admin/nested-runs");
    await expect(page.getByRole("link", { name: "Ver la cola de fallos (1 pendiente)" })).toBeVisible();
    await page.getByRole("link", { name: /Ver la cola de fallos/ }).click();
    await expect(page).toHaveURL(/\/nested-failures$/);
    await expect(page.getByRole("heading", { level: 1, name: "Fallos de ejecuciones anidadas" })).toBeVisible();
    const failure = page.getByRole("row").filter({ hasText: "El número de documento no es válido" });
    await expect(failure).toBeVisible();
    await expect(failure.getByText(PARENT, { exact: true })).toBeVisible();
    await expect(failure.getByText(NESTED, { exact: true })).toBeVisible();
    await expect(failure.getByText("Pendiente")).toBeVisible();
    await expect(page.getByText("DATO-SECRETO-DEL-INPUT")).toHaveCount(0);
    await expect(page.getByText("Los fallos resueltos o descartados se borran a los 90 días")).toBeVisible();

    // Reintentar replays the nested process as the retrying user, with the code: the stored input is not a valid tercero, so the process refuses and the row stays pending.
    await failure.getByRole("button", { name: /Reintentar/ }).click();
    await confirmStepUp(page, secret);
    await expect(page.getByRole("alert").filter({ hasText: "No se pudo guardar" })).toBeVisible();
    await expect(failure.getByText("Pendiente")).toBeVisible();
    const [still] = await fixture.sql<{ status: string; attempts: number }[]>`select status, attempts from kernel.nested_run_failures where company_id = ${fixture.companyIds[0]!}`;
    expect(still).toEqual({ status: "pending", attempts: 0 });

    // Descartar keeps the row as «Descartado».
    await failure.getByRole("button", { name: /Descartar/ }).click();
    await expect(failure.getByText("Descartado")).toBeVisible();
    await expect(failure.getByRole("button", { name: /Reintentar/ })).toHaveCount(0);

    // A role without the grant gets the forbidden card, at the same address.
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const other = await context.newPage();
    await other.goto("/login");
    await other.getByLabel("Correo").fill(plain.email);
    await other.getByLabel("Contraseña", { exact: true }).fill(plain.password);
    await other.getByRole("button", { name: "Entrar" }).click();
    await expect(other).toHaveURL(/\/$/);
    await other.goto("/nested-failures");
    await expect(other.getByRole("alert").filter({ hasText: "No tienes acceso a esta pantalla" })).toBeVisible();
    await other.goto("/admin/nested-runs");
    await expect(other.getByRole("alert").filter({ hasText: "La administración requiere el rol admin de la empresa" })).toBeVisible();
    await context.close();
  });
});
