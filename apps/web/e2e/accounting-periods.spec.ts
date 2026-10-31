import { expect, test } from "../test-support/streamed";
import { enrolTotp, seedAuthUser, type AuthFixture } from "../test-support/auth-fixtures";
import { cleanupAccounting, confirmStepUp, grantAccounting, seedSmallLedger, signInWithCode, type SmallLedger } from "../test-support/accounting-fixture";

// Períodos (accounting design §5.7, §8, Task 29): closing a period is a gate behind the TOTP dialog that lists the checks that failed,
// and a closed period reopens whole or only for one day.

const PROCESSES = [
  "accounting.period.consult", "accounting.period.close", "accounting.period.reopen", "accounting.year.close", "accounting.year.reopen",
  "accounting.fiscal_year.consult", "accounting.entry.consult",
];

test.describe("accounting periods", () => {
  let fixture: AuthFixture;
  let secret: string;
  let companyId: string;
  let ledger: SmallLedger;

  test.beforeAll(async () => {
    fixture = await seedAuthUser({ role: "admin" });
    secret = await enrolTotp(fixture);
    companyId = fixture.companyIds[0]!;
    await grantAccounting(fixture, PROCESSES);
    ledger = await seedSmallLedger(fixture);
  });

  test.afterAll(async () => {
    await cleanupAccounting(fixture);
    await fixture.cleanup();
  });

  test("Períodos: Cerrar octubre with a draft open shows the failed check list; after voiding the draft, TOTP → closed; Reabrir solo el día 15 → the period shows 'reabierto para 2026/10/15'", async ({ page }) => {
    test.setTimeout(180_000);
    const { sql } = fixture;
    await page.setViewportSize({ width: 1440, height: 900 });
    // A draft dated in October keeps the period from closing.
    const [draft] = await sql<{ id: string }[]>`
      insert into accounting.entries (company_id, journal_id, date, period_id, description) values (${companyId}, ${ledger.journal}, '2026-10-12', ${ledger.period}, 'Borrador de octubre') returning id`;

    await signInWithCode(page, fixture, secret);
    await page.goto("/accounting/periods");
    await expect(page.getByRole("button", { name: "Año 2026" })).toHaveAttribute("aria-pressed", "true");
    const october = page.getByRole("row", { name: /Octubre de 2026/ });
    await expect(october.getByText("Abierto")).toBeVisible();

    // Cerrar → TOTP → the checks run, one fails, the period stays open.
    await page.getByRole("button", { name: "Cerrar Octubre de 2026" }).click();
    const dialog = page.getByRole("dialog", { name: "Cerrar Octubre de 2026" });
    await dialog.getByRole("button", { name: "Cerrar período" }).click();
    await confirmStepUp(page, secret);
    await expect(dialog.getByRole("alert")).toContainText("Falló 1 verificación: el período sigue abierto.");
    const checks = dialog.getByRole("list", { name: "Verificaciones de cierre" });
    await expect(checks.getByRole("listitem").filter({ hasText: "Sin borradores" })).toContainText("Fallida");
    await expect(checks.getByRole("listitem").filter({ hasText: "Sin borradores" })).toContainText("Hay 1 borrador con fecha en el período");
    await expect(checks.getByRole("listitem").filter({ hasText: "Aprobada" }).first()).toBeVisible();
    expect((await sql`select status from accounting.periods where id = ${ledger.period}`)[0]!.status).toBe("open");

    // The draft is voided; the second attempt closes the period.
    await sql`update accounting.entries set status = 'voided' where id = ${draft!.id}`;
    await dialog.getByRole("button", { name: "Volver a intentar" }).click();
    await confirmStepUp(page, secret);
    await expect(dialog).toBeHidden();
    await expect.poll(async () => (await sql`select status from accounting.periods where id = ${ledger.period}`)[0]!.status).toBe("closed");
    await expect(october.getByText("Cerrado")).toBeVisible();

    // Reabrir solo el día 15.
    await page.getByRole("button", { name: "Reabrir Octubre de 2026" }).click();
    const reopen = page.getByRole("dialog", { name: "Reabrir Octubre de 2026" });
    await reopen.getByRole("radio", { name: "Solo un día" }).check();
    await reopen.getByLabel("Día", { exact: true }).fill("2026-10-15");
    await reopen.getByRole("button", { name: "Reabrir período" }).click();
    await confirmStepUp(page, secret);
    await expect(reopen).toBeHidden();
    await expect(october.getByText("reabierto para 2026/10/15")).toBeVisible();
    const [row] = await sql<{ status: string; reopened_for: Date | null }[]>`select status, reopened_for from accounting.periods where id = ${ledger.period}`;
    expect(row!.status).toBe("open");
    expect(row!.reopened_for?.toISOString().slice(0, 10)).toBe("2026-10-15");
  });
});
