import { execFileSync } from "node:child_process";
import type { Page } from "@playwright/test";
import { expect, test } from "../test-support/streamed";
import { seedAuthUser, type AuthFixture } from "../test-support/auth-fixtures";

// The master pages of the accounting module (accounting design §8, Task 26): the chart as Tabla · Árbol with the choice remembered
// per user, the children of the selected node in the grid, Nueva cuenta auxiliar under a subcuenta and the same page for a dimension.

const PROCESSES = [
  "accounting.account.consult",
  "accounting.account.create",
  "accounting.cost_center.consult",
  "accounting.cost_center.create",
  "kernel.saved_view.list",
  "kernel.saved_view.save",
  "kernel.saved_view.delete",
  "kernel.export.run",
];

async function signIn(page: Page, fixture: AuthFixture) {
  await page.goto("/login");
  await page.getByLabel("Correo").fill(fixture.email);
  await page.getByLabel("Contraseña", { exact: true }).fill(fixture.password);
  await page.getByRole("button", { name: "Entrar" }).click();
  await expect(page).toHaveURL(/\/$/);
}

const grid = (page: Page, name: string) => page.getByRole("region", { name });
const bodyRows = (page: Page) => page.locator(".erp-grid__body tbody tr.erp-row-link");
const node = (page: Page, name: RegExp) => page.getByRole("treeitem", { name });

test.describe("accounting masters", () => {
  let fixture: AuthFixture;
  let companyId: string;

  test.beforeAll(async () => {
    fixture = await seedAuthUser({ role: "member" });
    companyId = fixture.companyIds[0]!;
    const { sql } = fixture;
    await sql`insert into kernel.tenant_entitlements(tenant_id, key, source) values (${fixture.tenantId}, 'module:accounting', 'manual')`;
    const [role] = await sql<{ id: string }[]>`select id from kernel.roles where company_id = ${companyId}`;
    for (const process of PROCESSES) {
      await sql`insert into kernel.process_permissions(company_id, role_id, process_id) values (${companyId}, ${role!.id}, ${process})`;
    }
    // The company has run Configurar contabilidad (every accounting page leads to it until `settings` has a row).
    await sql`insert into accounting.settings (company_id) values (${companyId})`;
    // A small chart, parents first (a trigger derives the level and the parent from the code), one period and a cost center tree.
    const chart: [string, string, "debit" | "credit"][] = [
      ["1", "Activo", "debit"], ["13", "Deudores", "debit"], ["1305", "Clientes", "debit"], ["130505", "Nacionales", "debit"], ["130510", "Extranjeros", "debit"],
      ["1355", "Anticipo de impuestos", "debit"], ["2", "Pasivo", "credit"], ["22", "Proveedores", "credit"],
    ];
    for (const [code, name, nature] of chart) {
      await sql`insert into accounting.accounts (company_id, code, name, nature, allows_movement) values (${companyId}, ${code}, ${name}, ${nature}, ${code.length >= 6})`;
    }
    const [year] = await sql<{ id: string }[]>`
      insert into accounting.fiscal_years (company_id, year, starts_on, ends_on) values (${companyId}, 2026, '2026-01-01', '2026-12-31') returning id`;
    await sql`insert into accounting.periods (company_id, fiscal_year_id, number, starts_on, ends_on) values (${companyId}, ${year!.id}, 10, '2026-10-01', '2026-10-31')`;
    const [sede] = await sql<{ id: string }[]>`insert into accounting.cost_centers (company_id, code, name, kind) values (${companyId}, 'SEDE', 'Sede principal', 'group') returning id`;
    await sql`insert into accounting.cost_centers (company_id, code, name, parent_id, kind) values (${companyId}, 'ADM', 'Administración', ${sede!.id}, 'leaf')`;
  });

  test.afterAll(async () => {
    const { sql } = fixture;
    await sql.begin(async (tx) => {
      // Replica role: no triggers and no foreign key checks, so the order does not matter.
      await tx`set local session_replication_role = replica`;
      for (const table of ["entry_lines", "entries", "journals", "settings", "periods", "fiscal_years", "cost_centers", "accounts"]) await tx`delete from ${tx(`accounting.${table}`)} where company_id = ${companyId}`;
      await tx`delete from core.entity_sequences where company_id = ${companyId}`;
    });
    await sql`delete from kernel.saved_views where company_id = ${companyId}`;
    await sql`delete from kernel.user_prefs where company_id = ${companyId}`;
    await sql`delete from kernel.process_permissions where company_id = ${companyId}`;
    await sql`delete from kernel.tenant_entitlements where tenant_id = ${fixture.tenantId}`;
    await fixture.cleanup();
  });

  test("Plan de cuentas: Tabla · Árbol toggle persists per user; selecting 13 shows its children in the grid; Nueva cuenta auxiliar under 130505 creates 13050501", async ({ page }) => {
    await page.setViewportSize({ width: 1600, height: 900 });
    await signIn(page, fixture);
    await page.goto("/accounting/accounts");

    // Tabla first: every account, and the Seguridad column.
    const plan = grid(page, "Plan de cuentas");
    await expect(plan.getByRole("heading", { name: "Plan de cuentas" })).toBeVisible();
    await expect(bodyRows(page)).toHaveCount(8);
    await expect(plan.getByRole("columnheader", { name: /Seguridad/ })).toBeVisible();
    await expect(page.getByRole("tree")).toHaveCount(0);
    // Nueva cuenta auxiliar and the Restringidas quick filter, with nothing restricted yet.
    await expect(plan.getByRole("button", { name: "Nueva cuenta auxiliar" })).toBeEnabled();
    await plan.getByRole("button", { name: "Restringidas" }).click();
    await expect(bodyRows(page)).toHaveCount(0);
    await plan.getByRole("button", { name: "Restringidas" }).click();
    await expect(bodyRows(page)).toHaveCount(8);

    // Árbol: the choice is remembered, so a reload keeps it.
    await plan.getByRole("button", { name: "Árbol" }).click();
    await expect(page.getByRole("tree", { name: "Árbol de Plan de cuentas" })).toBeVisible();
    await expect.poll(async () => (await fixture.sql`select value from kernel.user_prefs where user_id = ${fixture.userId} and key = 'master_view.accounting.account'`)[0]?.value).toBe("tree");
    await page.reload();
    await expect(page.getByRole("tree", { name: "Árbol de Plan de cuentas" })).toBeVisible();
    await expect(grid(page, "Plan de cuentas").getByRole("button", { name: "Árbol" })).toHaveAttribute("aria-pressed", "true");

    // Two levels are open (classes and groups), so the accounts show and the subcuentas do not. Without a selection the grid lists the classes.
    await expect(node(page, /^1 Activo/)).toBeVisible();
    await expect(node(page, /^13 Deudores/)).toBeVisible();
    await expect(node(page, /^1305 Clientes/)).toBeVisible();
    await expect(node(page, /^130505 Nacionales/)).toHaveCount(0);
    await expect(bodyRows(page)).toHaveCount(2);

    // Selecting 13 shows its accounts, 1305 and 1355, and nothing else.
    await node(page, /^13 Deudores/).click();
    await expect(bodyRows(page)).toHaveCount(2);
    await expect(bodyRows(page).filter({ hasText: "1305" })).toHaveCount(1);
    await expect(bodyRows(page).filter({ hasText: "1355" })).toHaveCount(1);
    await expect(bodyRows(page).filter({ hasText: "130505" })).toHaveCount(0);

    // Under an account (4 digits) a company cannot hang an auxiliary: the button is off until a subcuenta is selected.
    await expect(grid(page, "Plan de cuentas").getByRole("button", { name: "Nueva cuenta auxiliar" })).toBeDisabled();
    await page.getByRole("button", { name: "Abrir hasta el nivel 4" }).click();
    await node(page, /^130505 Nacionales/).click();
    const nueva = grid(page, "Plan de cuentas").getByRole("button", { name: "Nueva cuenta auxiliar" });
    await expect(nueva).toBeEnabled();
    await nueva.click();

    const dialog = page.getByRole("dialog");
    await expect(dialog.getByText("Bajo 130505 Nacionales")).toBeVisible();
    await expect(dialog.getByLabel("Código")).toHaveValue("130505");
    await dialog.getByLabel("Código").fill("13050501");
    await dialog.getByLabel("Descripción").fill("Clientes Éxito");
    await dialog.getByRole("button", { name: "Crear" }).click();
    await expect(dialog).toHaveCount(0);

    // The new auxiliary appears in the tree, under 130505, and the parent keeps its place.
    await expect(node(page, /^13050501 Clientes Éxito/)).toBeVisible();
    const [created] = await fixture.sql<{ level: string; parent_code: string; nature: string }[]>`
      select a.level, p.code as parent_code, a.nature from accounting.accounts a join accounting.accounts p on p.id = a.parent_id
      where a.company_id = ${companyId} and a.code = '13050501'`;
    expect(created).toEqual({ level: "auxiliary", parent_code: "130505", nature: "debit" });

    // A refusal of the process is shown in the dialog: a code that has no subcuenta above it.
    await node(page, /^130505 Nacionales/).click();
    await grid(page, "Plan de cuentas").getByRole("button", { name: "Nueva cuenta auxiliar" }).click();
    await page.getByRole("dialog").getByLabel("Código").fill("99999999");
    await page.getByRole("dialog").getByLabel("Descripción").fill("Sin madre");
    await page.getByRole("dialog").getByRole("button", { name: "Crear" }).click();
    await expect(page.getByRole("dialog").getByRole("alert")).toContainText("No se pudo crear");
  });

  test("Centros de costo: the same page, with the period's result beside the nodes and Nuevo under the selected group", async ({ page }) => {
    await page.setViewportSize({ width: 1600, height: 900 });
    await signIn(page, fixture);
    await page.goto("/accounting/cost-centers");
    const centros = grid(page, "Centros de costo");
    await expect(bodyRows(page)).toHaveCount(2);
    await centros.getByRole("button", { name: "Árbol" }).click();
    await expect(page.getByRole("tree", { name: "Árbol de Centros de costo" })).toBeVisible();
    await expect(page.getByText("Resultado", { exact: true })).toBeVisible();
    await expect(page.getByRole("combobox", { name: "Período" })).toBeVisible();

    await node(page, /^SEDE Sede principal/).click();
    await expect(bodyRows(page)).toHaveCount(1);
    await centros.getByRole("button", { name: "Nuevo", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByText("Bajo SEDE Sede principal")).toBeVisible();
    await dialog.getByLabel("Código").fill("VTA");
    await dialog.getByLabel("Descripción").fill("Ventas");
    await dialog.getByRole("button", { name: "Crear" }).click();
    await expect(node(page, /^VTA Ventas/)).toBeVisible();
    const [row] = await fixture.sql<{ parent: string; kind: string }[]>`
      select p.code as parent, c.kind from accounting.cost_centers c join accounting.cost_centers p on p.id = c.parent_id where c.company_id = ${companyId} and c.code = 'VTA'`;
    expect(row).toEqual({ parent: "SEDE", kind: "leaf" });
  });

  test("Plan de cuentas → Tabla → período octubre de 2026 → ordenar por Saldo: the largest October balance leads, and the Excel carries the column", async ({ page }) => {
    await page.setViewportSize({ width: 1600, height: 900 });
    const { sql } = fixture;
    const [journal] = await sql<{ id: string }[]>`insert into accounting.journals (company_id, code, name, kind, manual_entries) values (${companyId}, 'NC', 'Notas contables', 'general', true) returning id`;
    const [period] = await sql<{ id: string }[]>`select id from accounting.periods where company_id = ${companyId} and number = 10`;
    const account = async (code: string) => (await sql<{ id: string }[]>`select id from accounting.accounts where company_id = ${companyId} and code = ${code}`)[0]!.id;
    // 130505 +9.000 and 130510 +3.000 against 22: the Activo adds both, so the larger balance is the one the sort must put first.
    const [entry] = await sql<{ id: string }[]>`
      insert into accounting.entries (company_id, journal_id, date, period_id, status, origin, description) values (${companyId}, ${journal!.id}, '2026-10-12', ${period!.id}, 'draft', 'manual', 'Octubre') returning id`;
    let line = 0;
    for (const [code, debit, credit] of [["130505", 9000, 0], ["130510", 3000, 0], ["22", 0, 12000]] as const) {
      await sql`insert into accounting.entry_lines (company_id, entry_id, line_no, account_id, debit, credit, debit_doc, credit_doc) values (${companyId}, ${entry!.id}, ${++line}, ${await account(code)}, ${debit}, ${credit}, ${debit}, ${credit})`;
    }
    await sql`update accounting.entries set status = 'posted', number = 'NC-1', total_debit = 12000, total_credit = 12000, posted_at = now() where id = ${entry!.id}`;

    await signIn(page, fixture);
    await page.goto("/accounting/accounts");
    const plan = grid(page, "Plan de cuentas");
    // The earlier test left the user on Árbol.
    await plan.getByRole("button", { name: "Tabla" }).click();
    await expect(plan.getByRole("columnheader", { name: /Saldo/ })).toBeVisible();
    await plan.getByRole("combobox", { name: "Período" }).selectOption({ label: "octubre de 2026" });
    await expect(bodyRows(page).filter({ hasText: "Nacionales" })).toContainText("9.000,00");
    await expect(bodyRows(page).filter({ hasText: "Extranjeros" })).toContainText("3.000,00");

    // Sorted by the figure, largest first: the three accounts that add both lines lead with the same 12.000,00.
    await plan.getByRole("columnheader", { name: /Saldo/ }).getByRole("button").click();
    await plan.getByRole("columnheader", { name: /Saldo/ }).getByRole("button").click();
    await expect(bodyRows(page).first()).toContainText("12.000,00");
    await expect(bodyRows(page).nth(7)).not.toContainText("12.000,00");

    const [file] = await Promise.all([page.waitForEvent("download"), plan.getByRole("button", { name: "Excel", exact: true }).click()]);
    expect(file.suggestedFilename()).toMatch(/\.xlsx$/);
    const sheet = execFileSync("unzip", ["-p", (await file.path())!, "xl/*"], { encoding: "utf8", maxBuffer: 1 << 24 });
    // The file names the column by the catalogue label and carries the figures in the order of the screen (largest first).
    expect(sheet).toContain("Cifra del período");
    expect([...sheet.matchAll(/<c r="I\d+" s="2"><v>(\d+)<\/v>/g)].map((m) => Number(m[1])).slice(0, 7)).toEqual([12000, 12000, 12000, 12000, 12000, 9000, 3000]);
  });
});
