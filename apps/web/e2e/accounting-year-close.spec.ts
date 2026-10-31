import { expect, test } from "../test-support/streamed";
import { enrolTotp, seedAuthUser, type AuthFixture } from "../test-support/auth-fixtures";
import { cleanupAccounting, confirmStepUp, grantAccounting, postEntry, seedYearLedger, signInWithCode } from "../test-support/accounting-fixture";

// Cerrar año / Reabrir año (accounting design §5.7, §7 workflow 6): on its own company, so the shared demo and the smoke's preconditions
// are never touched. The year has income 10.000.000 (March) and expense 6.000.000 (June); its twelve periods are closed in setup.

const PROCESSES = [
  "accounting.period.consult", "accounting.period.close", "accounting.period.reopen", "accounting.year.close", "accounting.year.reopen",
  "accounting.fiscal_year.consult", "accounting.fiscal_year.open", "accounting.entry.consult",
];

test.describe("accounting year close", () => {
  let fixture: AuthFixture;
  let secret: string;
  let companyId: string;
  let year: string;
  let periods: string[];

  test.beforeAll(async () => {
    fixture = await seedAuthUser({ role: "admin" });
    secret = await enrolTotp(fixture);
    companyId = fixture.companyIds[0]!;
    await grantAccounting(fixture, PROCESSES);
    const ledger = await seedYearLedger(fixture);
    year = ledger.year;
    periods = ledger.periods;
    await postEntry(fixture, { ...ledger, period: periods[2]! }, { date: "2026-03-15", debit: "111005", credit: "413595", amount: 10_000_000, description: "Ventas del año" });
    await postEntry(fixture, { ...ledger, period: periods[5]! }, { date: "2026-06-15", debit: "510506", credit: "111005", amount: 6_000_000, description: "Sueldos del año" });
    await fixture.sql`update accounting.periods set status = 'closed' where fiscal_year_id = ${year}`;
  });

  test.afterAll(async () => {
    await cleanupAccounting(fixture);
    await fixture.cleanup();
  });

  test("Períodos: Cerrar año 2026 shows the preview (ingresos 10.000.000, gastos 6.000.000, utilidad 4.000.000), TOTP → two closing comprobantes dated 2026/12/31, 2026 closed and 2027 open; Reabrir año → TOTP → the closing comprobantes reversed, 2026 and its December open", async ({ page }) => {
    test.setTimeout(180_000);
    const { sql } = fixture;
    await page.setViewportSize({ width: 1440, height: 900 });
    await signInWithCode(page, fixture, secret);
    await page.goto("/accounting/periods");
    await expect(page.getByRole("button", { name: /Año 2026/ })).toHaveAttribute("aria-pressed", "true");

    await page.getByRole("button", { name: "Cerrar año", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Cerrar el año 2026" });
    const preview = dialog.getByRole("list", { name: "Vista previa del cierre" }).or(dialog.locator("dl"));
    await expect(preview).toContainText("Ingresos del año");
    await expect(preview).toContainText("$ 10.000.000,00");
    await expect(preview).toContainText("Gastos del año");
    await expect(preview).toContainText("$ 6.000.000,00");
    await expect(preview).toContainText("Utilidad del ejercicio");
    await expect(preview).toContainText("$ 4.000.000,00");

    await dialog.getByRole("button", { name: "Cerrar año", exact: true }).click();
    await confirmStepUp(page, secret);
    await expect(dialog).toBeHidden();

    await expect.poll(async () => (await sql`select status from accounting.fiscal_years where id = ${year}`)[0]!.status).toBe("closed");
    const closing = await sql<{ id: string; date: Date; code: string; status: string; number: string }[]>`
      select e.id, e.date, j.code, e.status, e.number from accounting.entries e join accounting.journals j on j.id = e.journal_id
      where e.company_id = ${companyId} and e.is_closing order by e.seq`;
    expect(closing).toHaveLength(2);
    for (const e of closing) {
      expect(e.date.toISOString().slice(0, 10)).toBe("2026-12-31");
      expect(e.code).toBe("CI");
      expect(e.status).toBe("posted");
    }
    const [profit] = await sql<{ credit: string }[]>`
      select l.credit from accounting.entry_lines l join accounting.accounts a on a.id = l.account_id where l.entry_id = ${closing[1]!.id} and a.code = '360505'`;
    expect(Number(profit!.credit)).toBe(4_000_000);
    const years = await sql<{ year: number; status: string; periods: number }[]>`
      select y.year, y.status, (select count(*)::int from accounting.periods p where p.fiscal_year_id = y.id) as periods
      from accounting.fiscal_years y where y.company_id = ${companyId} order by y.year`;
    expect(years).toEqual([{ year: 2026, status: "closed", periods: 12 }, { year: 2027, status: "open", periods: 12 }]);

    // Reabrir año: the dialog lists the closing comprobantes it will reverse.
    await page.getByRole("button", { name: /Año 2026/ }).click();
    await page.getByRole("button", { name: "Reabrir año", exact: true }).click();
    const reopen = page.getByRole("dialog", { name: "Reabrir el año 2026" });
    const list = reopen.getByRole("list", { name: "Comprobantes de cierre por revertir" });
    for (const e of closing) await expect(list).toContainText(e.number);
    await reopen.getByRole("button", { name: "Reabrir año", exact: true }).click();
    await confirmStepUp(page, secret);
    await expect(reopen).toBeHidden();

    await expect.poll(async () => (await sql`select status from accounting.fiscal_years where id = ${year}`)[0]!.status).toBe("open");
    const states = await sql<{ status: string }[]>`select status from accounting.entries where id = any(${closing.map((e) => e.id)})`;
    expect(states.map((s) => s.status)).toEqual(["reversed", "reversed"]);
    expect((await sql`select status from accounting.periods where id = ${periods[11]!}`)[0]!.status).toBe("open");
  });

  test("Cerrar año is disabled while a period is open, with 'Falta cerrar 1 período del año.'", async ({ page }) => {
    test.setTimeout(120_000);
    const { sql } = fixture;
    await page.setViewportSize({ width: 1440, height: 900 });
    // The first test leaves 2026 open with December open; set all twelve closed again, then reopen November.
    await sql`update accounting.periods set status = 'closed' where fiscal_year_id = ${year}`;
    await sql`update accounting.periods set status = 'open' where id = ${periods[10]!}`;
    await signInWithCode(page, fixture, secret);
    await page.goto("/accounting/periods");
    await page.getByRole("button", { name: /Año 2026/ }).click();
    await page.getByRole("button", { name: "Cerrar año", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Cerrar el año 2026" });
    await expect(dialog.getByRole("alert")).toContainText("Falta cerrar 1 período del año.");
    await expect(dialog.getByRole("button", { name: "Cerrar año", exact: true })).toBeDisabled();
  });
});
