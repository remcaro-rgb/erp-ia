import { randomUUID } from "node:crypto";
import type { Page } from "@playwright/test";
import { expect, test } from "../test-support/streamed";
import { enrolTotp, seedAuthUser, totpCode, type AuthFixture } from "../test-support/auth-fixtures";

// The records of the accounting masters (accounting design §4.15, §5.6, §5.13, §8, Task 28): the Seguridad tab of a Cuenta, restricted to
// a role with the admin's TOTP code, and what a user outside the grant sees; and a Regla contable, whose lines are edited, previewed
// against a real event and saved under step-up, which marks the rule as modified by the company.

const READ = [
  "accounting.account.consult",
  "accounting.ledger_line.list",
  "accounting.ledger_line.consult",
  "accounting.cost_center.consult",
  "kernel.saved_view.list",
  "kernel.saved_view.save",
  "kernel.saved_view.delete",
  "kernel.custom_field.list",
  "kernel.attachment.list",
  "kernel.export.run",
];
const ADMIN = [
  ...READ,
  "accounting.account.update",
  "accounting.account_permission.consult",
  "accounting.account_permission.update",
  "accounting.posting_rule.consult",
  "accounting.posting_rule.update",
  "accounting.posting_rule.test",
  "accounting.journal.consult",
  "accounting.entry.consult",
  "accounting.period.consult",
  "accounting.journal.update",
  "accounting.entry_template.consult",
  "accounting.entry_template.update",
  "kernel.audit.consult",
  "kernel.audit.entry",
];

async function signInWithCode(page: Page, fixture: AuthFixture, secret: string) {
  await page.goto("/login");
  await page.getByLabel("Correo").fill(fixture.email);
  await page.getByLabel("Contraseña", { exact: true }).fill(fixture.password);
  await page.getByRole("button", { name: "Entrar" }).click();
  await expect(page).toHaveURL(/\/mfa\/verify$/);
  await page.getByLabel("Dígito 1").fill(totpCode(secret));
  await expect(page).toHaveURL(/\/$/);
}

async function signIn(page: Page, user: { email: string; password: string }) {
  await page.goto("/login");
  await page.getByLabel("Correo").fill(user.email);
  await page.getByLabel("Contraseña", { exact: true }).fill(user.password);
  await page.getByRole("button", { name: "Entrar" }).click();
  await expect(page).toHaveURL(/\/$/);
}

/** Answers the step-up prompt: the box has the caret and the 6th digit sends it. */
async function confirmStepUp(page: Page, secret: string) {
  const code = page.getByLabel("Código de 6 dígitos");
  await expect(code).toBeFocused();
  await code.fill(totpCode(secret));
}

test.describe("accounting records", () => {
  let fixture: AuthFixture;
  let secret: string;
  let companyId: string;
  let marcela: { email: string; password: string; userId: string };
  const ids: Record<string, string> = {};

  test.beforeAll(async () => {
    fixture = await seedAuthUser({ role: "admin" });
    secret = await enrolTotp(fixture);
    companyId = fixture.companyIds[0]!;
    const { sql } = fixture;
    await sql`insert into kernel.tenant_entitlements(tenant_id, key, source) values (${fixture.tenantId}, 'module:accounting', 'manual')`;
    const [adminRole] = await sql<{ id: string }[]>`select id from kernel.roles where company_id = ${companyId} and name = 'admin'`;
    for (const process of ADMIN) await sql`insert into kernel.process_permissions(company_id, role_id, process_id) values (${companyId}, ${adminRole!.id}, ${process})`;

    // The contador role the account is restricted to, and Marcela, who holds another role that reads the chart.
    const [contador] = await sql<{ id: string }[]>`insert into kernel.roles(company_id, name) values (${companyId}, 'contador') returning id`;
    ids.contador = contador!.id;
    const [auxiliar] = await sql<{ id: string }[]>`insert into kernel.roles(company_id, name) values (${companyId}, 'auxiliar') returning id`;
    for (const process of READ) await sql`insert into kernel.process_permissions(company_id, role_id, process_id) values (${companyId}, ${auxiliar!.id}, ${process})`;
    const suffix = randomUUID().slice(0, 8);
    marcela = { email: `marcela-${suffix}@test.local`, password: `pw-${randomUUID()}`, userId: "" };
    const created = await fixture.admin.auth.admin.createUser({ email: marcela.email, password: marcela.password, email_confirm: true });
    if (created.error || !created.data.user) throw new Error(`could not create marcela: ${created.error?.message}`);
    marcela.userId = created.data.user.id;
    await sql`insert into kernel.users(id, email, full_name) values (${marcela.userId}, ${marcela.email}, 'Marcela Rojas')`;
    const [membership] = await sql<{ id: string }[]>`insert into kernel.memberships(user_id, company_id) values (${marcela.userId}, ${companyId}) returning id`;
    await sql`insert into kernel.membership_roles(membership_id, role_id) values (${membership!.id}, ${auxiliar!.id})`;

    // The company has run Configurar contabilidad (every accounting page leads to it until `settings` has a row).
    await sql`insert into accounting.settings (company_id) values (${companyId})`;
    // A small chart, parents first (a trigger derives the level and the parent from the code), the Fuente, a period, role mappings.
    const chart: [string, string, "debit" | "credit"][] = [
      ["1", "Activo", "debit"], ["11", "Efectivo", "debit"], ["1110", "Bancos", "debit"], ["111005", "Bancos nacionales", "debit"],
      ["13", "Deudores", "debit"], ["1305", "Clientes", "debit"], ["130505", "Nacionales", "debit"],
      ["4", "Ingresos", "credit"], ["41", "Operacionales", "credit"], ["4135", "Comercio", "credit"], ["413505", "Ventas", "credit"],
      ["5", "Gastos", "debit"], ["51", "Operacionales de administración", "debit"], ["5105", "Gastos de personal", "debit"], ["510506", "Sueldos", "debit"],
    ];
    for (const [code, name, nature] of chart) {
      const [row] = await sql<{ id: string }[]>`insert into accounting.accounts (company_id, code, name, nature, allows_movement) values (${companyId}, ${code}, ${name}, ${nature}, ${code.length >= 6}) returning id`;
      ids[code] = row!.id;
    }
    const [vt] = await sql<{ id: string }[]>`insert into accounting.journals (company_id, code, name, kind, manual_entries) values (${companyId}, 'VT', 'Ventas', 'sales', false) returning id`;
    const now = new Date();
    const [year] = await sql<{ id: string }[]>`
      insert into accounting.fiscal_years (company_id, year, starts_on, ends_on) values (${companyId}, ${now.getFullYear()}, ${`${now.getFullYear()}-01-01`}, ${`${now.getFullYear()}-12-31`}) returning id`;
    await sql`insert into accounting.periods (company_id, fiscal_year_id, number, starts_on, ends_on) values (${companyId}, ${year!.id}, 1, ${`${now.getFullYear()}-01-01`}, ${`${now.getFullYear()}-01-31`})`;
    for (const [role, code] of [["receivable", "130505"], ["revenue", "413505"], ["bank", "111005"]] as const) {
      await sql`insert into accounting.account_role_mappings (company_id, role, account_id) values (${companyId}, ${role}, ${ids[code]!})`;
    }
    const template = {
      description: "Venta de prueba",
      date: "$.date",
      lines: [
        { role: "receivable", side: "debit", amount: "$.total" },
        { role: "revenue", side: "credit", amount: "$.total" },
      ],
    };
    const [rule] = await sql<{ id: string }[]>`
      insert into accounting.posting_rules (company_id, event, name, module, journal_id, template, priority, is_default)
      values (${companyId}, 'qa.sale.issued', 'Venta de prueba', 'qa', ${vt!.id}, ${sql.json(template)}, 100, true) returning id`;
    ids.rule = rule!.id;
    const [cc] = await sql<{ id: string }[]>`insert into accounting.cost_centers (company_id, code, name, kind) values (${companyId}, 'ADM', 'Administración', 'leaf') returning id`;
    ids.cc = cc!.id;
    const [period] = await sql<{ id: string }[]>`select id from accounting.periods where company_id = ${companyId}`;
    ids.period = period!.id;
    ids.vt = vt!.id;
    const [tpl] = await sql<{ id: string }[]>`insert into accounting.entry_templates (company_id, name, journal_id, description) values (${companyId}, 'Arriendo mensual', ${vt!.id}, 'Arriendo') returning id`;
    ids.template = tpl!.id;
    await sql`insert into accounting.entry_template_lines (company_id, template_id, line_no, account_id, side, amount) values (${companyId}, ${tpl!.id}, 1, ${ids["510506"]!}, 'debit', 1200000)`;
    await sql`insert into accounting.entry_template_lines (company_id, template_id, line_no, account_id, side) values (${companyId}, ${tpl!.id}, 2, ${ids["111005"]!}, 'credit')`;
    // A past event of that kind, already dispatched so no drain posts it.
    await sql`
      insert into kernel.outbox (company_id, event, payload, chain_id, dispatched_at)
      values (${companyId}, 'qa.sale.issued', ${sql.json({ date: iso(now), total: 250000 })}, ${randomUUID()}, now())`;
  });

  test.afterAll(async () => {
    const { sql } = fixture;
    await sql.begin(async (tx) => {
      // Replica role: no triggers and no foreign key checks, so the order does not matter.
      await tx`set local session_replication_role = replica`;
      for (const table of ["entry_template_lines", "entry_templates", "cost_centers", "posting_rules", "account_role_mappings", "account_permissions", "settings", "periods", "fiscal_years", "journals", "accounts"]) {
        await tx`delete from ${tx(`accounting.${table}`)} where company_id = ${companyId}`;
      }
      await tx`delete from core.entity_sequences where company_id = ${companyId}`;
    });
    await sql`delete from kernel.membership_roles where membership_id in (select id from kernel.memberships where user_id = ${marcela.userId})`;
    await sql`delete from kernel.memberships where user_id = ${marcela.userId}`;
    await sql`delete from kernel.user_prefs where user_id = ${marcela.userId}`;
    await sql`delete from kernel.step_up_verifications where company_id = ${companyId}`;
    await sql`delete from kernel.saved_views where company_id = ${companyId}`;
    await sql`delete from kernel.user_prefs where company_id = ${companyId}`;
    await sql`delete from kernel.process_permissions where company_id = ${companyId}`;
    await sql`delete from kernel.tenant_entitlements where tenant_id = ${fixture.tenantId}`;
    await sql`delete from kernel.users where id = ${marcela.userId}`;
    await fixture.admin.auth.admin.deleteUser(marcela.userId);
    await fixture.cleanup();
  });

  test("Cuenta 5105 → Seguridad: restrict to contador (ver y contabilizar) with TOTP; as marcela: Saldos and Movimientos answer Sin acceso, the tree shows a lock", async ({ page, browser }) => {
    test.setTimeout(180_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await signInWithCode(page, fixture, secret);

    // The account's record: Datos, then its balances and movements, and Seguridad because the caller is the admin.
    await page.goto(`/r/accounting.account/${ids["5105"]}`);
    const tabs = page.getByRole("tablist");
    for (const name of ["Datos", "Saldos", "Movimientos", "Seguridad", "Datos adicionales", "Archivos"]) await expect(tabs.getByRole("tab", { name, exact: true })).toBeVisible();
    await tabs.getByRole("tab", { name: "Saldos", exact: true }).click();
    await expect(page.getByRole("table", { name: "Saldos por período" })).toBeVisible();

    await tabs.getByRole("tab", { name: "Seguridad", exact: true }).click();
    await expect(page.getByRole("radio", { name: "Abierta" })).toBeChecked();
    await page.getByRole("radio", { name: "Restringida" }).check();
    await expect(page.getByText("Sin permisos: solo el administrador ve y contabiliza en esta cuenta.")).toBeVisible();
    await page.getByRole("combobox", { name: "Rol o usuario por agregar" }).selectOption({ label: "contador" });
    await page.getByRole("button", { name: "Agregar", exact: true }).click();
    await page.getByRole("checkbox", { name: "Contabilizar · contador" }).check();
    await expect(page.getByRole("checkbox", { name: "Ver · contador" })).toBeChecked();
    await page.getByRole("button", { name: "Guardar", exact: true }).click();
    await confirmStepUp(page, secret);
    await expect.poll(async () => (await fixture.sql`select access from accounting.accounts where id = ${ids["5105"]!}`)[0]?.access).toBe("restricted");
    const [grant] = await fixture.sql`select can_view, can_post, is_active from accounting.account_permissions where account_id = ${ids["5105"]!} and subject_id = ${ids.contador!}`;
    expect(grant).toEqual({ can_view: true, can_post: true, is_active: true });

    // The tree shows a lock on the restricted account to who may view it.
    await page.goto("/accounting/accounts");
    await page.getByRole("button", { name: "Árbol" }).click();
    await expect(page.getByRole("treeitem", { name: /^5105 Gastos de personal/ }).getByRole("img", { name: "Cuenta restringida" })).toBeVisible();

    // Marcela holds another role: the account is not there for her. Its record answers "Sin acceso" on Saldos and Movimientos, and the tree has no node.
    const context = await browser.newContext();
    const other = await context.newPage();
    await other.setViewportSize({ width: 1440, height: 900 });
    await signIn(other, marcela);
    await other.goto(`/r/accounting.account/${ids["5105"]}`);
    const otherTabs = other.getByRole("tablist");
    await otherTabs.getByRole("tab", { name: "Saldos", exact: true }).click();
    await expect(other.getByRole("tabpanel").filter({ hasText: "Sin acceso" }).first()).toBeVisible();
    await otherTabs.getByRole("tab", { name: "Movimientos", exact: true }).click();
    await expect(other.getByRole("tabpanel").filter({ hasText: "Sin acceso" }).first()).toBeVisible();
    await expect(otherTabs.getByRole("tab", { name: "Seguridad", exact: true })).toHaveCount(0);
    await other.goto("/accounting/accounts");
    await other.getByRole("button", { name: "Árbol" }).click();
    await expect(other.getByRole("treeitem", { name: /^5105 / })).toHaveCount(0);
    await expect(other.getByRole("treeitem", { name: /^4135 / })).toBeVisible();
    await context.close();
  });

  test("Regla contable: edit a line's role, Probar con un evento real shows the preview, Guardar asks TOTP and sets Modificada", async ({ page }) => {
    test.setTimeout(180_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await signInWithCode(page, fixture, secret);
    await page.goto(`/r/accounting.posting_rule/${ids.rule}`);
    const tabs = page.getByRole("tablist");
    for (const name of ["Datos", "Probar", "Historial"]) await expect(tabs.getByRole("tab", { name, exact: true })).toBeVisible();
    // Líneas carries its count.
    await expect(tabs.getByRole("tab", { name: /^Líneas/ })).toContainText("2");
    await expect(page.getByText("Predeterminada")).toBeVisible();

    // Probar con un evento real: the stored rule posts to the receivable and revenue accounts.
    await tabs.getByRole("tab", { name: "Probar", exact: true }).click();
    await page.getByRole("button", { name: "Probar con un evento real" }).click();
    const preview = page.getByRole("table", { name: "Líneas del comprobante que produciría" });
    await expect(preview).toContainText("130505");
    await expect(preview).toContainText("413505");
    await expect(preview).toContainText("$ 250.000,00");

    // Edit the first line's role and save: the code is asked, and the rule is marked as modified by the company.
    await tabs.getByRole("tab", { name: /^Líneas/ }).click();
    await page.getByRole("combobox", { name: "Rol, Línea 1" }).selectOption("bank");
    await page.getByRole("button", { name: "Guardar", exact: true }).click();
    await confirmStepUp(page, secret);
    await expect.poll(async () => (await fixture.sql`select is_modified from accounting.posting_rules where id = ${ids.rule!}`)[0]?.is_modified).toBe(true);
    const [stored] = await fixture.sql<{ template: { lines: { role: string }[] } }[]>`select template from accounting.posting_rules where id = ${ids.rule!}`;
    expect(stored!.template.lines.map((l) => l.role)).toEqual(["bank", "revenue"]);
    await tabs.getByRole("tab", { name: "Datos", exact: true }).click();
    await expect(page.getByText("Modificada", { exact: true })).toBeVisible();

    // The preview now follows the edited line; the Historial lists the change.
    await tabs.getByRole("tab", { name: "Probar", exact: true }).click();
    await page.getByRole("button", { name: "Probar con un evento real" }).click();
    await expect(page.getByRole("table", { name: "Líneas del comprobante que produciría" })).toContainText("111005");
    await tabs.getByRole("tab", { name: "Historial", exact: true }).click();
    await expect(page.getByRole("list", { name: "Cambios de la regla" })).toContainText("Modifica una regla contable");
  });

  test("Período, Centro de costo, Fuente and Plantilla: the tabs of each record, and a Fuente renamed from its Datos", async ({ page }) => {
    test.setTimeout(180_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await signInWithCode(page, fixture, secret);
    const tabs = page.getByRole("tablist");

    // Período: its dates are shown, not edited; Resumen, Comprobantes and Cierre follow.
    await page.goto(`/r/accounting.period/${ids.period}`);
    for (const name of ["Datos", "Resumen", "Comprobantes", "Cierre"]) await expect(tabs.getByRole("tab", { name, exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Guardar", exact: true })).toHaveCount(0);
    await tabs.getByRole("tab", { name: "Resumen", exact: true }).click();
    await expect(page.getByText("El período no tiene comprobantes contabilizados")).toBeVisible();
    await tabs.getByRole("tab", { name: "Cierre", exact: true }).click();
    await expect(page.getByText("Aún no se ha intentado cerrar el período")).toBeVisible();

    // Centro de costo: Resultados (income and expense by period) and Movimientos.
    await page.goto(`/r/accounting.cost_center/${ids.cc}`);
    for (const name of ["Datos", "Resultados", "Movimientos"]) await expect(tabs.getByRole("tab", { name, exact: true })).toBeVisible();
    await tabs.getByRole("tab", { name: "Resultados", exact: true }).click();
    await expect(page.getByRole("table", { name: "Resultados por período" }).or(page.getByText("Aún no hay períodos"))).toBeVisible();

    // Fuente: renamed from its Datos; the consecutivo is shown and not editable.
    await page.goto(`/r/accounting.journal/${ids.vt}`);
    await expect(page.getByLabel("Código", { exact: true })).toBeDisabled();
    await page.getByLabel("Nombre", { exact: true }).fill("Ventas del café");
    await page.getByRole("button", { name: "Guardar", exact: true }).click();
    await expect.poll(async () => (await fixture.sql`select name from accounting.journals where id = ${ids.vt!}`)[0]?.name).toBe("Ventas del café");

    // Plantilla de comprobante: header and its lines, with the value the plantilla asks for when used.
    await page.goto(`/r/accounting.entry_template/${ids.template}`);
    const lines = page.getByRole("table", { name: "Líneas de la plantilla" });
    await expect(lines).toContainText("510506 · Sueldos");
    await expect(lines).toContainText("$ 1.200.000,00");
    await expect(lines).toContainText("Se pide al usarla");
  });
});

const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
