import { randomUUID } from "node:crypto";
import { expect, test } from "../test-support/streamed";
import { enrolTotp, seedAuthUser, type AuthFixture } from "../test-support/auth-fixtures";
import { cleanupAccounting, confirmStepUp, grantAccounting, signInWithCode } from "../test-support/accounting-fixture";

// Reglas contables (accounting design §5.5, §5.9, §8, Task 29): the first visit leads to Configurar contabilidad; afterwards the inbox of
// events that could not post (Reintentar), the account mapping with every role covered, the settings with the counter of events before the
// ledger started, and the revenue account of a product category saved under TOTP from the category's own record.

const PROCESSES = [
  "accounting.chart.seed",
  "accounting.posting_rule.consult", "accounting.account_role_mapping.consult", "accounting.account_role_mapping.update",
  "accounting.fiscal_concept_mapping.consult", "accounting.fiscal_concept_mapping.update",
  "accounting.posting_failure.consult", "accounting.posting.retry", "accounting.posting_failure.dismiss",
  "accounting.settings.consult", "accounting.settings.update", "accounting.period.reopen", "accounting.period.consult",
  "accounting.account.consult", "accounting.entry.consult", "accounting.journal.consult",
  "core.category.consult", "core.category.update",
  "kernel.saved_view.list", "kernel.saved_view.save", "kernel.saved_view.delete", "kernel.custom_field.list", "kernel.attachment.list", "kernel.export.run",
];

test.describe("accounting posting rules", () => {
  let fixture: AuthFixture;
  let secret: string;
  let companyId: string;

  test.beforeAll(async () => {
    fixture = await seedAuthUser({ role: "admin" });
    secret = await enrolTotp(fixture);
    companyId = fixture.companyIds[0]!;
    await grantAccounting(fixture, PROCESSES);
  });

  test.afterAll(async () => {
    await cleanupAccounting(fixture);
    await fixture.cleanup();
  });

  test("Reglas contables: Pendientes shows a failure with Reintentar; Mapeo de cuentas shows no unmapped role after setup; category record Contabilidad tab saves the revenue account with TOTP", async ({ page }) => {
    test.setTimeout(240_000);
    const { sql } = fixture;
    await page.setViewportSize({ width: 1600, height: 900 });
    await signInWithCode(page, fixture, secret);

    // Until the company is configured, every accounting page leads to the one action.
    await page.goto("/accounting/posting");
    await expect(page).toHaveURL(/\/accounting\/setup$/);
    await expect(page.getByRole("heading", { name: "Configurar contabilidad" })).toBeVisible();
    await page.getByRole("button", { name: "Configurar contabilidad" }).click();
    await confirmStepUp(page, secret);
    await expect(page).toHaveURL(/\/accounting\/entries$/, { timeout: 120_000 });
    expect((await sql`select count(*)::int as n from accounting.settings where company_id = ${companyId}`)[0]!.n).toBe(1);

    // Mapeo de cuentas: every role of the catalogue has its account.
    await page.goto("/accounting/posting?tab=mapping");
    await expect(page.getByText("Todos los roles tienen cuenta.")).toBeVisible();
    await expect(page.getByText("Sin cuenta", { exact: true })).toHaveCount(0);

    // An event no rule could post: a rule whose lines do not balance, and its failure in the inbox.
    const [nc] = await sql<{ id: string }[]>`select id from accounting.journals where company_id = ${companyId} and code = 'NC'`;
    const template = {
      description: "Venta de prueba",
      date: "$.date",
      lines: [
        { role: "bank", side: "debit", amount: "$.total" },
        { role: "revenue", side: "credit", amount: "$.other" },
      ],
    };
    const [rule] = await sql<{ id: string }[]>`
      insert into accounting.posting_rules (company_id, event, name, module, journal_id, template, priority, is_default)
      values (${companyId}, 'qa.sale.issued', 'Venta de prueba', 'qa', ${nc!.id}, ${sql.json(template)}, 100, false) returning id`;
    await sql`
      insert into accounting.posting_failures (company_id, event_id, event, event_date, posting_rule_id, payload, error_code, error_detail, status)
      values (${companyId}, ${randomUUID()}, 'qa.sale.issued', '2026-10-05', ${rule!.id}, ${sql.json({ date: "2026-10-05", total: 100000, other: 40000 })}, 'unbalanced', 'Débitos y créditos no cuadran', 'pending')`;
    await sql`insert into accounting.skipped_events (company_id, outbox_id, event, event_date) values (${companyId}, ${randomUUID()}, 'qa.sale.issued', '2025-12-30')`;

    await page.goto("/accounting/posting?tab=pending");
    const tab = page.getByRole("navigation", { name: "Secciones de las reglas contables" });
    await expect(tab.getByRole("link", { name: /Pendientes de contabilizar/ })).toContainText("1");
    // The bar item carries the same count.
    await expect(page.getByRole("button", { name: "Reglas contables 1 pendientes", exact: true })).toBeVisible();
    const row = page.getByRole("row", { name: /qa\.sale\.issued/ });
    await expect(row).toContainText("Comprobante descuadrado");
    await row.getByRole("button", { name: "Reintentar" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Sigue pendiente:" })).toBeVisible();
    expect((await sql`select attempts from accounting.posting_failures where company_id = ${companyId}`)[0]!.attempts).toBe(2); // the first attempt is the engine's own, the second is Reintentar

    // Configuración: the counter of events before the start of the ledger.
    await page.goto("/accounting/posting?tab=settings");
    await expect(page.getByTestId("skipped-events")).toHaveText("1");

    // The revenue account of a category, from the category's own record.
    const [category] = await sql<{ id: string }[]>`insert into core.product_categories (company_id, name, iva_rate, default_uom) values (${companyId}, 'Café', '5', 'KGM') returning id`;
    await page.goto(`/r/core.product_category/${category!.id}`);
    await page.getByRole("tab", { name: "Contabilidad", exact: true }).click();
    const revenue = page.getByRole("combobox", { name: "Cuenta de ingresos" });
    await revenue.fill("413595");
    await page.getByRole("option", { name: /413595/ }).first().click();
    await page.getByRole("button", { name: "Guardar", exact: true }).click();
    await confirmStepUp(page, secret);
    await expect
      .poll(async () => (await sql`select a.code from accounting.account_role_mappings m join accounting.accounts a on a.id = m.account_id where m.company_id = ${companyId} and m.role = 'revenue' and m.dimension = ${`category:${category!.id}`}`)[0]?.code)
      .toBe("413595");
  });
});
