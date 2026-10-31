import type { Page } from "@playwright/test";
import postgres from "postgres";
import { expect, test } from "../test-support/streamed";
import { ANDRES, DEMO_COMPANY_ID, LAURA, MARCELA, type DemoAccount } from "../../../scripts/demo/accounts";
import { totpCode } from "../test-support/auth-fixtures";
import { confirmStepUp } from "../test-support/accounting-fixture";
import { testEnv } from "../test-support/env";

// The phase 2A smoke (Task 31) on the demo ledger the seed leaves (`pnpm db:reset && DEMO_SEED=1 pnpm db:seed`): nothing here
// creates users, roles, accounts or entries beyond the comprobante the third test writes; it signs in with the seeded accounts and
// walks Contabilidad.
//
//  1. Laura (admin): Balance de prueba Este período with equal totals, Movimientos grouped by Cuenta then Centro de costo with
//     subtotals, September already closed, and the assistant's answer to "gastos de octubre por centro de costo".
//  2. Marcela (cajero, no view on 5105, class 3 nor the Davivienda account): the restricted accounts collapse into one row with the
//     same totals, the Auxiliar of 510506 answers Sin acceso, "Nómina octubre" shows masked lines and a new comprobante offers no 5105.
//  3. Andrés (contador): drafts a comprobante and sends it to approval, cannot approve it; Laura approves it with her code; the
//     auto-reversal draft of the accrual waits in Borradores dated 2026/11/01.

const sql = postgres(testEnv().DATABASE_URL, { max: 2, onnotice: () => {} });

async function login(page: Page, account: DemoAccount) {
  await page.goto("/login");
  await page.getByLabel("Correo").fill(account.email);
  await page.getByLabel("Contraseña", { exact: true }).fill(account.password);
  await page.getByRole("button", { name: "Entrar" }).click();
  if (account.totpSecret) {
    await expect(page).toHaveURL(/\/mfa\/verify$/);
    await page.getByLabel("Dígito 1").fill(totpCode(account.totpSecret));
  }
  await expect(page).toHaveURL(/\/$/);
}

/** The text of the money cells of a footer, in order. */
const money = async (cells: ReturnType<Page["locator"]>) => (await cells.allInnerTexts()).map((t) => t.trim()).filter((t) => t.startsWith("$"));

test.describe("phase 2A smoke on the demo ledger", () => {
  const created: string[] = [];

  test.afterAll(async () => {
    // What the third test wrote: the comprobante goes (the journal's consecutive is given back); the audit rows stay, the log is append-only.
    await sql.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      for (const id of created) {
        const [entry] = await tx<{ number: string | null; journal_id: string }[]>`select number, journal_id from accounting.entries where id = ${id}`;
        await tx`delete from accounting.entry_lines where entry_id = ${id}`;
        await tx`delete from accounting.entries where id = ${id}`;
        const n = entry?.number ? Number(entry.number.split("-")[1]) : 0;
        if (n > 0) await tx`update accounting.journals set next_number = ${n} where id = ${entry!.journal_id} and next_number = ${n + 1}`;
      }
    });
    await sql.end();
  });

  test("laura: Contabilidad → Balance de prueba Este período shows equal totals; Movimientos grouped by Cuenta then Centro de costo shows subtotals; Cerrar septiembre is already closed; assistant 'gastos de octubre por centro de costo' answers with a table and a link to Movimientos", async ({ page }) => {
    test.setTimeout(180_000);
    await page.setViewportSize({ width: 1600, height: 900 });
    await login(page, LAURA);

    // Balance de prueba, Este período: the footer's debit equals its credit, opening and closing too.
    await page.goto("/accounting/reports/trial_balance");
    const balance = page.getByRole("region", { name: "Balance de prueba" });
    await expect(balance.locator("tfoot")).toContainText("$");
    const cells = await money(balance.locator("tfoot").locator("th, td"));
    const [openingDebit, openingCredit, debit, credit, closingDebit, closingCredit] = cells;
    expect(cells).toHaveLength(6);
    expect(openingDebit).toBe(openingCredit);
    expect(debit).toBe(credit);
    expect(closingDebit).toBe(closingCredit);
    expect(debit).not.toBe("$ 0,00");

    // Movimientos: Agrupar por Cuenta, then Centro de costo.
    await page.goto("/accounting/movements");
    await expect(page.locator(".erp-grid__body tbody tr").first()).toBeVisible();
    await page.getByRole("button", { name: "Agrupar por", exact: true }).click();
    const add = page.getByLabel("Agregar campo para agrupar");
    await add.selectOption({ label: "Cuenta" });
    await add.selectOption({ label: "Centro de costo" });
    await expect(page.getByRole("list", { name: "Agrupar por" })).toContainText("1. Cuenta");
    await expect(page.getByRole("list", { name: "Agrupar por" })).toContainText("2. Centro de costo");
    // A group row carries its subtotal; the footer the grand total.
    const accountGroup = page.locator("tr.erp-grid__group--l1").first();
    await expect(accountGroup).toContainText("Σ $");
    await expect(page.locator("tr.erp-grid__group--l2").first()).toContainText("Σ $");
    await expect(page.locator(".erp-grid__body tfoot")).toContainText("$");

    // Períodos: September is closed, October open.
    await page.goto("/accounting/periods");
    await expect(page.getByRole("row", { name: /Septiembre de 2026/ }).getByText("Cerrado")).toBeVisible();
    await expect(page.getByRole("row", { name: /Octubre de 2026/ }).getByText("Abierto")).toBeVisible();
    await expect(page.getByRole("button", { name: "Cerrar Septiembre de 2026" })).toHaveCount(0);

    // The assistant answers with a table and a way into Movimientos.
    const drawer = page.getByRole("complementary", { name: "Asistente" });
    await expect(drawer.getByLabel("Escribe")).toBeEnabled();
    const fresh = drawer.getByRole("button", { name: "Nueva conversación" });
    if (await fresh.isVisible()) await fresh.click();
    await drawer.getByLabel("Escribe").fill("gastos de octubre por centro de costo");
    await drawer.getByLabel("Escribe").press("Enter");
    await expect(drawer.locator(".erp-result table")).toBeVisible({ timeout: 60_000 });
    await expect(drawer.locator(".erp-result tbody tr").first()).toBeVisible();
    await drawer.getByRole("button", { name: "Abrir como grid" }).click();
    await expect(page).toHaveURL(/\/accounting\/movements/);
  });

  test("marcela (ventas): Balance de prueba shows one Cuentas restringidas row with the same totals; Auxiliar 510506 answers Sin acceso; Nómina octubre shows masked lines; a new comprobante offers no 5105", async ({ page, browser }) => {
    test.setTimeout(180_000);
    await page.setViewportSize({ width: 1600, height: 900 });

    // The totals Laura sees, read from the database as the books hold them.
    const [books] = await sql<{ debit: string; credit: string }[]>`
      select sum(l.debit)::text as debit, sum(l.credit)::text as credit
      from accounting.entry_lines l join accounting.entries e on e.id = l.entry_id
      join accounting.periods p on p.id = e.period_id
      where e.company_id = ${DEMO_COMPANY_ID} and e.status = 'posted' and p.starts_on = '2026-10-01'`;
    expect(books!.debit).toBe(books!.credit);

    await login(page, MARCELA);
    await page.goto("/accounting/reports/trial_balance");
    const balance = page.getByRole("region", { name: "Balance de prueba" });
    await expect(balance.locator("tfoot")).toContainText("$");
    // Every row on one page (the restricted line sorts after the accounts).
    await page.getByLabel("Filas por página").selectOption("100");
    await expect(balance.getByText("Cuentas restringidas", { exact: false })).toHaveCount(1);
    await expect(balance.getByRole("button", { name: "5105" })).toHaveCount(0);
    await expect(balance.getByRole("button", { name: "510506" })).toHaveCount(0);
    const cells = await money(balance.locator("tfoot").locator("th, td"));
    expect(cells).toHaveLength(6);
    expect(cells[2]).toBe(cells[3]);
    expect(cells[4]).toBe(cells[5]);

    // The same totals as Laura's, read in a context of her own.
    const other = await browser.newContext();
    const lauraPage = await other.newPage();
    await lauraPage.setViewportSize({ width: 1600, height: 900 });
    await login(lauraPage, LAURA);
    await lauraPage.goto("/accounting/reports/trial_balance");
    const lauraBalance = lauraPage.getByRole("region", { name: "Balance de prueba" });
    await expect(lauraBalance.locator("tfoot")).toContainText("$");
    // The restricted row keeps each side of its accounts, so all six totals are Laura's to the peso.
    const lauraCells = await money(lauraBalance.locator("tfoot").locator("th, td"));
    expect(lauraCells).toEqual(cells);
    await other.close();

    // The Auxiliar of a restricted account answers Sin acceso: the report refuses with that note, and the page shows the refusal.
    const [account] = await sql<{ id: string }[]>`select id from accounting.accounts where company_id = ${DEMO_COMPANY_ID} and code = '510506'`;
    const params = { accountId: account!.id, from: "2026-10-01", to: "2026-10-31" };
    const answer = await page.request.post("/api/report/accounting.account_detail", { data: { params, state: { filters: [], sort: [], page: 1, pageSize: 50 } } });
    expect(answer.status()).toBe(403);
    expect(await answer.json()).toMatchObject({ code: "forbidden", details: ["Sin acceso"] });
    await page.goto(`/accounting/reports/account_detail?p=${encodeURIComponent(JSON.stringify(params))}`);
    await expect(page.getByRole("region", { name: "Auxiliar por cuenta" }).getByRole("alert")).toHaveText("Sin acceso");

    // Nómina octubre: the comprobante shows, its 5105 lines masked.
    const [payroll] = await sql<{ id: string }[]>`select id from accounting.entries where company_id = ${DEMO_COMPANY_ID} and description = 'Nómina octubre'`;
    await page.goto(`/r/accounting.entry/${payroll!.id}`);
    await expect(page.getByText("Este comprobante tiene líneas de cuentas restringidas").first()).toBeVisible();
    await expect(page.getByText("••••").first()).toBeVisible();

    // A new comprobante: the account lookup offers no 5105.
    await page.goto("/r/accounting.entry/new");
    const accountCell = page.getByRole("combobox", { name: "Cuenta, Línea 1", exact: true });
    await accountCell.click();
    await page.keyboard.type("5135");
    await expect(page.getByRole("option", { name: /^513530 · Energía eléctrica/ })).toBeVisible();
    // 5105 is not an account she may post to: once the lookup has moved on from 5135, it offers nothing under 5105.
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.type("5105");
    await expect(page.getByRole("option", { name: /^513530/ })).toBeHidden();
    await expect(page.getByRole("option", { name: /^5105/ })).toHaveCount(0);
  });

  test("andres: creates a draft, Enviar a aprobación; cannot approve it; laura approves with TOTP → NC-<n>; the auto-reversal draft of the accrual appears in Borradores dated 2026/11/01", async ({ page, browser }) => {
    test.setTimeout(180_000);
    await page.setViewportSize({ width: 1600, height: 900 });
    await login(page, ANDRES);

    await page.goto("/r/accounting.entry/new");
    await page.getByRole("textbox", { name: "Descripción", exact: true }).fill("Gasto bancario de octubre (smoke)");
    const cell = (name: string) => page.getByRole(/^(Cuenta|Tercero|Centro)/.test(name) ? "combobox" : "textbox", { name, exact: true });
    await cell("Cuenta, Línea 1").click();
    await page.keyboard.type("530505");
    await page.getByRole("option", { name: /^530505/ }).click();
    await cell("Centro de costo, Línea 1").click();
    await page.keyboard.type("ADM");
    await page.getByRole("option", { name: /^ADM/ }).click();
    await cell("Débito, Línea 1").fill("45000");
    // Enter on the crédito opens line 2.
    await cell("Crédito, Línea 1").click();
    await page.keyboard.press("Enter");
    await expect(cell("Cuenta, Línea 2")).toBeFocused();
    await page.keyboard.type("11100502");
    await page.getByRole("option", { name: /^11100502/ }).click();
    await cell("Crédito, Línea 2").click();
    await page.keyboard.type("45000");
    await page.keyboard.press("Tab");
    await expect(page.getByRole("group", { name: "Totales del comprobante" })).toContainText("Cuadrado");
    await page.getByRole("button", { name: "Crear", exact: true }).click();
    await expect(page).toHaveURL(/\/r\/accounting\.entry\/[0-9a-f-]{36}$/);
    const entryId = page.url().split("/").pop()!;
    created.push(entryId);

    await page.getByRole("button", { name: "Enviar a aprobación" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Enviado a aprobación" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Aprobar y contabilizar" })).toBeDisabled();
    await expect(page.getByText("Otra persona debe aprobar")).toBeVisible();

    // Laura approves with her code.
    const other = await browser.newContext();
    const lauraPage = await other.newPage();
    await lauraPage.setViewportSize({ width: 1600, height: 900 });
    await login(lauraPage, LAURA);
    await lauraPage.goto(`/r/accounting.entry/${entryId}`);
    await lauraPage.getByRole("button", { name: "Aprobar y contabilizar" }).click();
    await confirmStepUp(lauraPage, LAURA.totpSecret!);
    await expect(lauraPage.getByRole("status").filter({ hasText: /Contabilizado como NC-\d+/ })).toBeVisible();
    const [row] = await sql`select number, status from accounting.entries where id = ${entryId}`;
    expect(row).toMatchObject({ status: "posted" });
    expect(row!.number).toMatch(/^NC-\d+$/);

    // The accrual's auto-reversal waits in Borradores, dated 2026/11/01.
    await lauraPage.goto("/accounting/entries");
    await lauraPage.getByRole("button", { name: "Borradores" }).click();
    const reversal = lauraPage.getByRole("row", { name: /Reversión automática de NC-/ });
    await expect(reversal).toBeVisible();
    await expect(reversal).toContainText(/2026\/11\/01/);
    await other.close();
  });
});
