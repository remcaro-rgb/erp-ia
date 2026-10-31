import { readFile } from "node:fs/promises";
import { expect, test } from "../test-support/streamed";
import { enrolTotp, seedAuthUser, type AuthFixture } from "../test-support/auth-fixtures";
import { cleanupAccounting, grantAccounting, postEntry, REPORT_CONSULTS, seedSmallLedger, signInWithCode, type SmallLedger } from "../test-support/accounting-fixture";

// Informes (accounting design §8, journey 7, Task 29): the cards of the reports, the parameter bar of the balance de prueba, the totals
// footer, the drill-down of an account to its Auxiliar in a tab of its own, and the Excel export.

test.describe("accounting reports", () => {
  let fixture: AuthFixture;
  let secret: string;
  let ledger: SmallLedger;

  test.beforeAll(async () => {
    fixture = await seedAuthUser({ role: "admin" });
    secret = await enrolTotp(fixture);
    await grantAccounting(fixture, [...REPORT_CONSULTS, "accounting.period.consult", "kernel.saved_view.list", "kernel.saved_view.save", "kernel.saved_view.delete", "kernel.export.run"]);
    ledger = await seedSmallLedger(fixture);
    await postEntry(fixture, ledger, { date: "2026-10-05", debit: "111005", credit: "413595", amount: 5_000_000, description: "Venta de octubre" });
    await postEntry(fixture, ledger, { date: "2026-10-09", debit: "510506", credit: "111005", amount: 1_250_000, description: "Nómina de octubre" });
  });

  test.afterAll(async () => {
    await cleanupAccounting(fixture);
    await fixture.cleanup();
  });

  test("Informes: Balance de prueba with Este período, nivel 4 → totals equal; click 4135 → Auxiliar opens in a new tab; Excel downloads", async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 1600, height: 900 });
    await signInWithCode(page, fixture, secret);

    // The cards: one per report the role may open.
    await page.goto("/accounting/reports");
    await expect(page.getByRole("link", { name: /Balance de prueba/ })).toBeVisible();
    await expect(page.getByRole("link", { name: /Información exógena/ })).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Informes" }).getByRole("link")).toHaveCount(13);
    await page.getByRole("link", { name: /Balance de prueba/ }).click();
    await expect(page).toHaveURL(/\/accounting\/reports\/trial_balance$/);

    // The bar starts on the current period; level 4.
    const bar = page.getByRole("group", { name: "Parámetros del informe" });
    await expect(bar.getByLabel("Período inicial")).toHaveValue(ledger.period);
    await expect(bar.getByLabel("Período final")).toHaveValue(ledger.period);
    await bar.getByLabel("Nivel").selectOption("4");

    // Sumas iguales: the footer totals debit = credit, and 4135 is there.
    const balance = page.getByRole("region", { name: "Balance de prueba" });
    await expect(page.getByRole("button", { name: "4135" })).toBeVisible();
    const footer = balance.locator("tfoot");
    await expect(footer).toContainText("$ 6.250.000,00");
    const cells = (await footer.locator("th, td").allInnerTexts()).map((t) => t.trim()).filter((t) => t.startsWith("$"));
    // opening 0 / 0, movement 6.250.000 / 6.250.000, closing: each side equals the other.
    expect(cells.filter((t) => t === "$ 6.250.000,00").length).toBeGreaterThanOrEqual(2);
    const [openingDebit, openingCredit, debit, credit, closingDebit, closingCredit] = cells;
    expect(debit).toBe(credit);
    expect(openingDebit).toBe(openingCredit);
    expect(closingDebit).toBe(closingCredit);

    // Excel carries what the grid shows.
    const [file] = await Promise.all([page.waitForEvent("download"), balance.getByRole("button", { name: "Excel", exact: true }).click()]);
    expect(file.suggestedFilename()).toMatch(/\.xlsx$/);
    expect((await readFile((await file.path())!)).subarray(0, 2).toString("latin1")).toBe("PK");

    // The account opens its Auxiliar in a tab of its own, for the range the balance was run on.
    await page.getByRole("button", { name: "4135" }).click();
    await expect(page).toHaveURL(/\/accounting\/reports\/account_detail\?p=/);
    await expect(page.getByRole("navigation", { name: "Pestañas abiertas" }).getByRole("button", { name: "4135", exact: true })).toBeVisible();
    const detail = page.getByRole("region", { name: "Auxiliar por cuenta" });
    await expect(detail.getByText("Venta de octubre")).toBeVisible();
    await expect(page.getByRole("combobox", { name: "Cuenta", exact: true })).toHaveValue(ledger.accounts["4135"]!);
    // Desde / Hasta are the whole month the balance was run on.
    await expect(page.locator("input#report-param-from")).toHaveValue("2026-10-01");
    await expect(page.locator("input#report-param-to")).toHaveValue("2026-10-31");
  });
  test("Información exógena 1001 de 2026 → Exportar XML downloads `Dmuisca_001001<versión>2026.xml`; with an unmapped account the page lists the errors", async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 1600, height: 900 });
    const { sql } = fixture;
    const companyId = fixture.companyIds[0]!;
    await sql`update kernel.companies set tax_id = '900373115-3', legal_name = 'Café del Norte S.A.S.' where id = ${companyId}`;
    const [role] = await sql<{ id: string }[]>`select id from kernel.roles where company_id = ${companyId} and name = 'admin'`;
    await sql`insert into kernel.process_permissions(company_id, role_id, process_id) values (${companyId}, ${role!.id}, 'accounting.report.exogena_xml') on conflict do nothing`;
    // The nómina of October (510506) is mapped to a concept and carries no tercero: the file is refused.
    await sql`insert into accounting.fiscal_concept_mappings (company_id, format, concept, account_id) values (${companyId}, '1001', '5001', ${ledger.accounts["5105"]!})`;
    await signInWithCode(page, fixture, secret);
    const url = `/accounting/reports/exogena?p=${encodeURIComponent(JSON.stringify({ year: 2026, format: "1001" }))}`;
    await page.goto(url);
    await expect(page.getByRole("button", { name: "Exportar XML" })).toBeVisible();
    await page.getByRole("button", { name: "Exportar XML" }).click();
    const refusal = page.getByRole("alert").filter({ hasText: "No se generó el archivo:" });
    await expect(refusal).toContainText("510506");

    // With its tercero on the line: the file is generated and downloads.
    const [party] = await sql<{ id: string }[]>`
      insert into core.parties (company_id, kind, person_type, document_type, document_number, check_digit, legal_name, department_code, municipality_code, dian_status)
      values (${companyId}, '{customer,supplier}', '1', '31', '900555666', '5', 'Proveedor Uno S.A.S.', '11', '11001', 'complete') returning id`;
    await sql.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      await tx`update accounting.entry_lines set party_id = ${party!.id} where company_id = ${companyId} and account_id = ${ledger.accounts["510506"]!}`;
    });
    await page.goto(url);
    const [file] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Exportar XML" }).click()]);
    expect(file.suggestedFilename()).toMatch(/^Dmuisca_001001\d{2}2026\.xml$/);
    expect((await readFile((await file.path())!)).toString("utf8")).toContain("<Formato>1001</Formato>");
    await expect(page.getByRole("alert").filter({ hasText: "No se generó el archivo:" })).toHaveCount(0);
    await sql`delete from core.parties where company_id = ${companyId}`;
  });
});
