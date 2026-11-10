import { readFile } from "node:fs/promises";
import type { Page } from "@playwright/test";
import { expect, test } from "../test-support/streamed";
import postgres from "postgres";
import { DEMO_COMPANY_ID, LAURA, MARCELA, type DemoAccount } from "../../../scripts/demo/accounts";
import { totpCode } from "../test-support/auth-fixtures";
import { testEnv } from "../test-support/env";

// The phase 1 smoke (Task 22) on the demo company the seed leaves (`pnpm db:reset && DEMO_SEED=1 pnpm db:seed`):
// nothing here creates users, roles or permissions; it signs in with the seeded accounts and walks the screens.
//
//  1. Laura (admin + gerente comercial, TOTP): Terceros from the module bar, the name filter, the Excel export, a consult
//     through the assistant, a party created through the assistant's confirmation card, and the audit viewer showing that
//     write with origin `agent`.
//  2. Marcela (cajero): the credit limit appears nowhere (grid, grid API, record, export, the assistant's result), the
//     assistant has no tool to create a party and says so, nothing is written, and the audit viewer is closed to her.
//
// The assistant runs for real (workflow, tools, confirmation, process). Its model is the AI SDK mock (`AGENT_MODEL=mock`,
// set by playwright.config.ts unless AI_GATEWAY_API_KEY is set): the exact wording of its answers is checked only then.

// Screenshots of a run, for a look at the result: not committed (test-results/ is ignored).
const SCREENSHOTS = "test-results/smoke";
const MOCKED = process.env.AGENT_MODEL === "mock" || !process.env.AI_GATEWAY_API_KEY;
const ESPIGA = { name: "Panadería La Espiga", nit: "800197268", dv: "4" };
const TRIGAL = { name: "Panadería El Trigal", nit: "860002964", dv: "4" };
/** Almacenes Éxito's seeded credit limit, as the grid would show it and as the export would write it. */
const EXITO_LIMIT = { shown: "$ 250.000.000,00", raw: "250000000" };

const sql = postgres(testEnv().DATABASE_URL, { max: 2, onnotice: () => {} });
const bodyRows = (page: Page) => page.locator(".erp-grid__body tbody tr.erp-row-link");

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

/** A new conversation in the drawer, so an earlier run's messages and cards are not on screen. */
async function freshAssistant(page: Page) {
  const drawer = page.getByRole("complementary", { name: "Asistente" });
  // Below 1280 px the drawer is an overlay that starts closed (rule 19): open it from the top bar.
  if (!(await drawer.isVisible())) await page.getByRole("button", { name: "Asistente", exact: true }).click();
  await expect(drawer).toBeVisible();
  await expect(drawer.getByLabel("Escribe")).toBeEnabled();
  // The button shows once the stored conversation has messages.
  const fresh = drawer.getByRole("button", { name: "Nueva conversación" });
  if (await fresh.isVisible()) await fresh.click();
  await expect(fresh).toBeHidden();
  return drawer;
}

/** Sends `text` once the previous turn is over (no "Detener" button), and waits until it shows in the conversation. */
async function ask(page: Page, text: string) {
  const drawer = page.getByRole("complementary", { name: "Asistente" });
  await expect(drawer.getByRole("button", { name: "Detener" })).toHaveCount(0, { timeout: 30_000 });
  await drawer.getByLabel("Escribe").fill(text);
  await drawer.getByLabel("Escribe").press("Enter");
  await expect(drawer.getByText(text, { exact: true })).toBeVisible();
}

/** The demo company's customers: what a role that sees only customers (the cajero) is shown. */
const customers = async () =>
  (await sql<{ n: number }[]>`select count(*)::int as n from core.parties where company_id = ${DEMO_COMPANY_ID} and kind @> array['customer']`)[0]!.n;

const userId = async (email: string) => (await sql<{ id: string }[]>`select id from kernel.users where email = ${email}`)[0]!.id;

/** Removes what an earlier run of the smoke created (the audit rows stay: the log is append-only). */
async function forgetParty(documentNumber: string) {
  await sql.begin(async (tx) => {
    await tx`set local session_replication_role = replica`;
    await tx`delete from core.parties where company_id = ${DEMO_COMPANY_ID} and document_number = ${documentNumber}`;
  });
}

test.describe("phase 1 smoke on the demo company", () => {
  test.beforeAll(async () => {
    await forgetParty(ESPIGA.nit);
    await forgetParty(TRIGAL.nit);
  });
  test.afterAll(async () => {
    await sql.end({ timeout: 5 });
  });

  test("login, grid, export, agent consult, agent confirmed write, audit", async ({ page }) => {
    test.setTimeout(180_000);
    await page.setViewportSize({ width: 1600, height: 900 });
    const started = new Date();
    // The seed made six parties invoice-ready through their required files (RUT, Cámara de Comercio), Éxito among them.
    const [ready] = await sql<{ n: number; exito: boolean }[]>`
      select count(*) filter (where invoice_ready)::int as n, bool_or(invoice_ready and document_number = '890900608') as exito
      from core.parties where company_id = ${DEMO_COMPANY_ID}`;
    expect(ready!.n).toBeGreaterThanOrEqual(6);
    expect(ready!.exito).toBe(true);
    await login(page, LAURA);
    await expect(page.locator("header").first().getByRole("button", { name: /Café del Norte/ })).toBeVisible();

    // Terceros sits in Contabilidad › Maestros (ModuleDef.adopts): pick the module in the side menu, then the item in the bar; it opens its tab; the name filter finds Éxito on the server.
    await page.getByRole("navigation", { name: "Módulos" }).getByRole("button", { name: "Contabilidad" }).click();
    await page.getByRole("navigation", { name: "Menú del módulo" }).getByRole("button", { name: "Maestros", exact: true }).click();
    await page.getByRole("menu", { name: "Maestros" }).getByRole("menuitem", { name: "Terceros" }).click();
    await expect(page).toHaveURL(/\/parties$/);
    await expect(page.getByRole("navigation", { name: "Pestañas abiertas" }).getByRole("button", { name: "Terceros", exact: true })).toHaveAttribute("aria-current", "page");
    const terceros = page.getByRole("region", { name: "Terceros" });
    await expect(terceros.getByText("42 registros")).toBeVisible();
    await terceros.getByLabel("Filtrar Razón social").fill("Éxito");
    await expect(bodyRows(page)).toHaveCount(1);
    await expect(bodyRows(page).first()).toContainText("Almacenes Éxito S.A.");
    await expect(bodyRows(page).first()).toContainText(EXITO_LIMIT.shown);

    // Excel: a real .xlsx of what the grid shows.
    const [file] = await Promise.all([page.waitForEvent("download"), terceros.getByRole("button", { name: "Excel", exact: true }).click()]);
    expect(file.suggestedFilename()).toMatch(/\.xlsx$/);
    expect((await readFile((await file.path())!)).subarray(0, 2).toString("latin1")).toBe("PK");

    // The assistant: a consult answers with a result table (Laura sees the credit limit).
    const drawer = await freshAssistant(page);
    await ask(page, "busca el cliente Éxito");
    const table = drawer.getByRole("table");
    await expect(table.getByText("Almacenes Éxito S.A.")).toBeVisible();
    // UX-OD-6: six columns at first; the credit limit sits behind «Ver todas las columnas».
    await drawer.getByRole("button", { name: /^Ver todas las columnas/ }).click();
    await expect(table.getByRole("columnheader", { name: "Cupo de crédito" })).toBeVisible();

    // A write: the assistant prepares the confirmation card, nothing exists until Laura confirms.
    await ask(page, `crea el cliente ${ESPIGA.name}, NIT ${ESPIGA.nit}-${ESPIGA.dv}`);
    const confirm = drawer.getByRole("button", { name: "Confirmar" });
    await expect(confirm).toBeVisible();
    expect((await sql`select 1 from core.parties where company_id = ${DEMO_COMPANY_ID} and document_number = ${ESPIGA.nit}`).length).toBe(0);
    await page.screenshot({ path: `${SCREENSHOTS}/smoke-agent-card.png` });
    await confirm.click();
    await expect(drawer.getByText("Listo · la acción se ejecutó")).toBeVisible();

    const laura = await userId(LAURA.email);
    const [party] = await sql<{ id: string; check_digit: string; legal_name: string; created_by: string }[]>`
      select id, check_digit, legal_name, created_by from core.parties where company_id = ${DEMO_COMPANY_ID} and document_number = ${ESPIGA.nit}`;
    expect(party).toMatchObject({ check_digit: ESPIGA.dv, legal_name: ESPIGA.name, created_by: laura });
    const [entry] = await sql<{ origin: string; actor_user_id: string; conversation_id: string | null }[]>`
      select origin, actor_user_id, conversation_id from kernel.audit_log
      where company_id = ${DEMO_COMPANY_ID} and process_id = 'core.party.create' and row_id = ${party!.id} and action = 'insert'
      order by occurred_at desc limit 1`;
    expect(entry).toMatchObject({ origin: "agent", actor_user_id: laura });
    expect(entry!.conversation_id).not.toBeNull();

    // The audit viewer: the write is there with its origin, filterable by process, exportable.
    await page.goto("/admin/audit");
    const audit = page.getByRole("region", { name: "Auditoría" });
    await expect(audit.getByRole("heading", { name: "Auditoría" })).toBeVisible();
    await expect(audit.getByRole("row", { name: /agent.*core\.party\.create/ }).first()).toBeVisible();
    await audit.getByLabel("Filtrar Proceso").fill("core.party.create");
    await expect(audit.getByRole("row", { name: /kernel\.user_prefs|kernel\.data\.query/ })).toHaveCount(0);
    await expect(audit.getByRole("row", { name: /agent.*core\.party\.create.*laura@demo\.local/ }).first()).toBeVisible();
    await page.screenshot({ path: `${SCREENSHOTS}/smoke-audit.png` });
    // Its export carries the entries' columns only: nothing of what the process received or changed (input, diff).
    const [auditFile] = await Promise.all([page.waitForEvent("download"), audit.getByRole("button", { name: "CSV", exact: true }).click()]);
    const auditCsv = (await readFile((await auditFile.path())!)).toString("utf8");
    expect(auditCsv.slice(1).split("\r\n")[0]).toMatch(/^"?Fecha"?;"?Origen"?;"?Proceso"?;"?Entidad"?;"?Registro"?;"?Acción"?;"?Actor"?;"?Cadena"?$/);
    expect(auditCsv).toContain("core.party.create");
    for (const leaked of [ESPIGA.name, "R-99-PN", "taxResponsibilities", "credit_limit", "legal_name"]) expect(auditCsv).not.toContain(leaked);

    // The mock's turns were metered as the mock: provider `mock`, no cost (AI usage never shows a model that was not called).
    if (MOCKED) {
      const usage = await sql<{ provider: string; model: string; cost: string }[]>`
        select provider, model, cost_usd::text as cost from kernel.llm_usage
        where company_id = ${DEMO_COMPANY_ID} and task = 'chat' and created_at >= ${started}`;
      expect(usage.length).toBeGreaterThan(0);
      expect(usage.every((u) => u.provider === "mock" && u.model === "mock/agent" && Number(u.cost) === 0)).toBe(true);
    }
  });

  test("cajero never sees credit_limit and cannot run party.create through the agent", async ({ page }) => {
    test.setTimeout(180_000);
    await page.setViewportSize({ width: 1600, height: 900 });
    const marcela = await userId(MARCELA.email);
    const laura = await userId(LAURA.email);

    // The seed hid the field through the admin process, as Laura, with her step-up (rules 14 and 15).
    const [mode] = await sql<{ mode: string }[]>`
      select fp.mode from kernel.field_permissions fp join kernel.roles r on r.id = fp.role_id
      where fp.company_id = ${DEMO_COMPANY_ID} and r.name = 'cajero' and fp.entity = 'core.party' and fp.field = 'credit_limit'`;
    expect(mode?.mode).toBe("hidden");
    const changed = await sql`
      select 1 from kernel.audit_log where company_id = ${DEMO_COMPANY_ID} and process_id = 'kernel.admin.field_permission.set' and actor_user_id = ${laura} and action <> 'denied'`;
    expect(changed.length).toBeGreaterThan(0);

    await login(page, MARCELA);

    // Grid (her role sees customers only): no column, no value, and the grid API refuses to filter on it and returns it
    // empty.
    const visible = await customers();
    await page.goto("/parties");
    const terceros = page.getByRole("region", { name: "Terceros" });
    await expect(terceros.getByText(`${visible} registros`)).toBeVisible();
    await expect(page.getByText("Cupo de crédito")).toHaveCount(0);
    await terceros.getByLabel("Filtrar Razón social").fill("Éxito");
    await expect(bodyRows(page)).toHaveCount(1);
    await expect(page.getByText(EXITO_LIMIT.shown)).toHaveCount(0);
    const api = await page.request.post("/api/grid/core.party", { data: { filters: [], sort: [], page: 1, pageSize: 50 } });
    expect(api.status()).toBe(200);
    const body = (await api.json()) as { rows: Record<string, unknown>[]; total: number };
    expect(body.total).toBe(visible);
    expect(body.rows.every((row) => row.credit_limit === null || row.credit_limit === undefined)).toBe(true);
    const filtered = await page.request.post("/api/grid/core.party", { data: { filters: [{ field: "credit_limit", op: "gt", value: 0 }], sort: [], page: 1, pageSize: 10 } });
    expect(filtered.status()).toBe(403);

    // Export: the CSV has neither the header nor the value.
    const [file] = await Promise.all([page.waitForEvent("download"), terceros.getByRole("button", { name: "CSV", exact: true }).click()]);
    const csv = (await readFile((await file.path())!)).toString("utf8");
    expect(csv).toContain("Almacenes Éxito S.A.");
    expect(csv).not.toContain("Cupo de crédito");
    expect(csv).not.toContain(EXITO_LIMIT.raw);

    // Record: the party form has no credit limit either.
    await bodyRows(page).first().click();
    await expect(page).toHaveURL(/\/r\/core\.party\/[0-9a-f-]{36}$/);
    await expect(page.getByRole("heading", { name: "Almacenes Éxito S.A." })).toBeVisible();
    await expect(page.getByText("Cupo de crédito")).toHaveCount(0);

    // The assistant's consult: the result table has no credit limit column, and the stored tool result has no value.
    const drawer = await freshAssistant(page);
    await ask(page, "busca el cliente Éxito");
    const table = drawer.getByRole("table");
    await expect(table.getByText("Almacenes Éxito S.A.")).toBeVisible();
    // UX-OD-6: six columns at first; the credit limit sits behind «Ver todas las columnas».
    await drawer.getByRole("button", { name: /^Ver todas las columnas/ }).click();
    await expect(table.getByRole("columnheader", { name: "Cupo de crédito" })).toHaveCount(0);
    await expect
      .poll(async () => (await sql`select 1 from kernel.agent_messages where company_id = ${DEMO_COMPANY_ID} and role = 'assistant' and parts::text like '%Almacenes Éxito%' and created_at > now() - interval '5 minutes'`).length)
      .toBeGreaterThan(0);
    const leaked = await sql`
      select 1 from kernel.agent_messages m join kernel.agent_conversations c on c.id = m.conversation_id
      where c.user_id = ${marcela} and m.parts::text like ${`%${EXITO_LIMIT.raw}%`}`;
    expect(leaked).toHaveLength(0);

    // A write the role may not run: no tool, so no card; the assistant says so, and nothing is written or attempted.
    await ask(page, `crea el cliente ${TRIGAL.name}, NIT ${TRIGAL.nit}-${TRIGAL.dv}`);
    if (MOCKED) await expect(drawer.getByText("Tu rol no te permite crear terceros")).toBeVisible();
    else await expect(drawer.getByText(/rol|permis/i).last()).toBeVisible();
    await expect(drawer.getByRole("button", { name: "Confirmar" })).toHaveCount(0);
    expect((await sql`select 1 from core.parties where company_id = ${DEMO_COMPANY_ID} and document_number = ${TRIGAL.nit}`).length).toBe(0);
    expect((await sql`select 1 from kernel.agent_confirmations where user_id = ${marcela}`).length).toBe(0);
    expect((await sql`select 1 from kernel.audit_log where actor_user_id = ${marcela} and process_id = 'core.party.create'`).length).toBe(0);
    // Her consults are audited as hers, with origin agent.
    expect((await sql`select 1 from kernel.audit_log where actor_user_id = ${marcela} and process_id = 'kernel.data.query' and origin = 'agent'`).length).toBeGreaterThan(0);

    // The audit viewer is the admin's only: the page says so and its grid API refuses.
    await page.goto("/admin/audit");
    await expect(page.getByRole("alert").getByText("No tienes permiso.")).toBeVisible();
    const auditApi = await page.request.post("/api/grid/kernel.audit", { data: { filters: [], sort: [], page: 1, pageSize: 10 } });
    expect(auditApi.status()).toBe(403);

    // A supplier's record (her role's party scope is customers only): the Spanish not-found page inside the shell.
    const [supplier] = await sql<{ id: string }[]>`
      select id from core.parties where company_id = ${DEMO_COMPANY_ID} and not kind @> array['customer'] order by seq limit 1`;
    await page.goto(`/r/core.party/${supplier!.id}`);
    await expect(page.getByRole("heading", { name: "No encontrado" })).toBeVisible();
    await expect(page.getByText("No encontramos este registro o no tienes acceso a él")).toBeVisible();
    await expect(page.getByText("This page could not be found")).toHaveCount(0);
    await expect(page.getByRole("navigation", { name: "Pestañas abiertas" }).locator('[aria-current="page"]')).toHaveAccessibleName("No encontrado");
  });
});
