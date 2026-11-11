import { execFileSync } from "node:child_process";
import { join } from "node:path";
import type { APIRequestContext, Page } from "@playwright/test";
import postgres from "postgres";
import { expect, test } from "../test-support/streamed";
import { DEMO_COMPANY_ID, LAURA } from "../../../scripts/demo/accounts";
import { COMMISSION_PLANS } from "../../../scripts/demo/commissions";
import { totpCode } from "../test-support/auth-fixtures";
import { testEnv } from "../test-support/env";

// Commissions on screen (plan 2B.2 Task 30.4, Part G design PG §5.5, §6; owner items 163, 167, 168) on the demo company. Laura (admin) creates
// on the plan form a plan for salesperson A (test-support/order-owner-chain.mts makes A and B): an external agent's (the demo's Agencia Comercial
// del Caribe, a supplier ready to invoice) at 5 % and 8 % on «Café molido». A's pedido of Café molido is confirmed, delivered, invoiced from Por
// facturar and issued, and the mock DIAN accepts it (test-support/commission-chain.mts, the registered processes); Laura registers on screen a
// receipt of 40 % of the invoice and its payments.received goes to sales and accounting (the e2e stack runs no worker). On the default basis (al
// recaudo) the receipt accrues 40 % of the commission: a COM- document Causada in Comisiones, a row of Comisiones por vendedor with the rest
// Por causar, and the agent's payable in Cartera y cuentas por pagar por edades. Salesperson A sees the commission; B (no plan, no
// sales.commission.consult_all) sees neither the commission nor the report's row.
//
// The spec runs on the shared demo: A's plan is deactivated before the next run (commission-chain.mts reset), the sellers are deactivated at the
// end; the sale, its receipt and its commission stay, as the other chain specs leave theirs.

const sql = postgres(testEnv().DATABASE_URL, { max: 2, onnotice: () => {} });
const OWNERS = join(__dirname, "..", "test-support", "order-owner-chain.mts");
const CHAIN = join(__dirname, "..", "test-support", "commission-chain.mts");
const CUSTOMER = { document: "900667788", name: "Catering Corporativo Andes" };
const SKU = "CAF-MOL-250";
const RATE = 8;
const AGENT = COMMISSION_PLANS.agent.party;

const tsx = (script: string, args: string[]): Record<string, unknown> => {
  const out = execFileSync("pnpm", ["exec", "tsx", script, DEMO_COMPANY_ID, laura, ...args], { cwd: join(__dirname, ".."), stdio: "pipe", env: process.env, timeout: 240_000 }).toString().trim().split("\n");
  return JSON.parse(out[out.length - 1]!) as Record<string, unknown>;
};
const peso = (n: number) => `$ ${Math.floor(Math.abs(n)).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".")},${String(Math.round(Math.abs(n) * 100) % 100).padStart(2, "0")}`;
const cents = (n: number) => Math.round(n * 100) / 100;

const bar = (page: Page) => page.getByRole("group", { name: "Acciones del registro" });
const frame = (page: Page) => page.locator(".erp-record").filter({ visible: true });
const grid = (page: Page) => page.locator("section.erp-grid").filter({ visible: true });

interface Seller { id: string; email: string; password: string; name: string }
let laura = "";
let a: Seller;
let b: Seller;
let today = "";
let planName = "";

async function signIn(page: Page, who: { email: string; password: string; totp?: string }) {
  await page.context().clearCookies();
  await page.goto("/login");
  await page.getByLabel("Correo").fill(who.email);
  await page.getByLabel("Contraseña", { exact: true }).fill(who.password);
  await page.getByRole("button", { name: "Entrar" }).click();
  await page.waitForURL(/\/(mfa\/verify)?$/);
  if (page.url().endsWith("/mfa/verify")) await page.getByLabel("Dígito 1").fill(totpCode(who.totp!));
  await expect(page).toHaveURL(/\/$/);
}

async function report<T>(request: APIRequestContext, id: string, params: Record<string, unknown>): Promise<T[]> {
  const answer = await request.post(`/api/report/${id}`, { data: { params, state: { filters: [], sort: [], page: 1, pageSize: 1000 } } });
  expect(answer.status(), `${id} ${await answer.text()}`).toBe(200);
  return ((await answer.json()) as { rows: T[] }).rows;
}

test.describe("sales commissions", () => {
  test.describe.configure({ mode: "serial" });

  test.beforeAll(async () => {
    test.setTimeout(240_000);
    const [user] = await sql<{ id: string }[]>`select id from kernel.users where email = ${LAURA.email}`;
    laura = user!.id;
    const sellers = tsx(OWNERS, ["setup"]) as { a: Seller; b: Seller };
    a = sellers.a;
    b = sellers.b;
    tsx(CHAIN, ["reset", a.id, b.id]);
    const [clock] = await sql<{ today: string }[]>`select (now() at time zone 'America/Bogota')::date::text as today`;
    today = clock!.today;
    planName = `Plan e2e ${Date.now()}`;
  });

  test.afterAll(async () => {
    try {
      tsx(CHAIN, ["reset", a.id, b.id]);
      tsx(OWNERS, ["teardown"]);
    } finally {
      await sql.end();
    }
  });

  test("a plan on screen, a sale collected 40 %: the commission accrued, its row in Comisiones por vendedor and the agent's payable in the aging", async ({ page }) => {
    test.setTimeout(300_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await signIn(page, { email: LAURA.email, password: LAURA.password, totp: LAURA.totpSecret });

    // ── Nuevo plan de comisión: the agent as payee, A as salesperson, 5 % and 8 % on Café molido. ──
    await page.goto("/r/sales.commission_plan/new");
    await expect(page.getByRole("heading", { name: "Crear plan de comisión" })).toBeVisible();
    await frame(page).getByLabel(/^Nombre/).fill(planName);
    await frame(page).getByLabel(/^Tipo de beneficiario/).selectOption("agent");
    await frame(page).getByRole("combobox", { name: "Beneficiario", exact: true }).fill("Agencia Comercial del Caribe");
    await page.getByRole("option", { name: /Agencia Comercial del Caribe/ }).first().click();
    await frame(page).getByLabel(/^Tasa general/).fill("5");
    await frame(page).getByRole("switch", { name: new RegExp(a.name) }).click();
    await frame(page).getByRole("button", { name: "Agregar categoría" }).click();
    await frame(page).getByLabel("Categoría de la línea 1").selectOption({ label: "Café molido" });
    await frame(page).getByLabel("Tasa de la línea 1").fill(String(RATE));
    await bar(page).getByRole("button", { name: /^Guardar/ }).first().click();
    await expect(page).toHaveURL(/\/r\/sales\.commission_plan\/[0-9a-f-]{36}$/);
    const planId = page.url().split("/").pop()!;
    expect(await sql`select p.default_rate_pct::float8 as rate, p.payee_kind, pa.document_number as payee from sales.commission_plans p join core.parties pa on pa.id = p.payee_party_id where p.id = ${planId}`)
      .toEqual([{ rate: 5, payee_kind: "agent", payee: AGENT.documentNumber }]);
    // The stored plan reads back in its form: A among the salespeople, the category's rate.
    await expect(frame(page).getByRole("switch", { name: new RegExp(a.name) })).toHaveAttribute("aria-checked", "true");
    await expect(frame(page).getByLabel("Tasa de la línea 1")).toHaveValue(String(RATE));

    // ── A's sale, invoiced and accepted by the mock DIAN (the registered processes). ──
    const sale = tsx(CHAIN, ["sale", a.id, CUSTOMER.document, SKU, "10"]) as { invoiceId: string; number: string; subtotal: number; total: number };
    const commission = cents((sale.subtotal * RATE) / 100);
    const paid = Math.round(sale.total * 0.4);
    const accrued = cents((commission * paid) / sale.total);

    // ── Registrar pago of 40 % on screen; its payments.received to sales (the accrual) and accounting (the commission's entry). ──
    await page.goto("/r/payments.receipt/new");
    await page.getByRole("combobox", { name: "Cliente" }).fill(CUSTOMER.name);
    await page.getByRole("option", { name: new RegExp(CUSTOMER.name) }).first().click();
    const open = frame(page).getByRole("table", { name: "Facturas del cliente" });
    await expect(open.getByRole("row", { name: new RegExp(sale.number) })).toBeVisible();
    await frame(page).getByLabel(/^Medio de pago/).selectOption({ label: "Transferencia Bancolombia" });
    await frame(page).getByLabel(/^Referencia/).fill(`TRF-E2E-COM-${sale.invoiceId.slice(0, 8)}`);
    await open.getByLabel(`Aplicar a ${sale.number}`).fill(String(paid));
    await frame(page).getByLabel(/^Valor recibido/).fill(String(paid));
    await frame(page).getByRole("button", { name: "Registrar pago", exact: true }).click();
    await expect(page).toHaveURL(/\/r\/payments\.receipt\/[0-9a-f-]{36}$/);
    const receiptId = page.url().split("/").pop()!;
    tsx(CHAIN, ["drain", receiptId]);

    const [com] = await sql<{ id: string; number: string; amount: number; stage: string; source_kind: string }[]>`
      select c.id, c.number, c.amount::float8 as amount, c.stage, c.source_kind
      from sales.commissions c where c.company_id = ${DEMO_COMPANY_ID} and c.source_kind = 'receipt' and c.source_id = ${receiptId}`;
    expect(com, "the receipt's commission").toMatchObject({ amount: accrued, stage: "posted", source_kind: "receipt" });

    // ── Comisiones: the COM- document, Causada, with its amount and plan. ──
    await page.goto("/sales/commissions");
    await expect(grid(page).getByRole("row", { name: new RegExp(`${com!.number}\\b`) })).toBeVisible();
    await page.goto(`/r/sales.commission/${com!.id}`);
    await expect(frame(page).getByTestId("commission-stage")).toHaveText("Causada");
    await expect(frame(page).getByTestId("commission-amount")).toContainText(peso(accrued));
    await expect(frame(page).getByRole("link", { name: planName })).toBeVisible();

    // ── Comisiones por vendedor: the invoice's row, accrued 40 %, the rest Por causar. ──
    type Row = { invoice_number: string; plan_name: string; base: number; rate_pct: number; commission: number; accrued: number; open: number };
    const rows = (await report<Row>(page.request, "sales.commissions", { from: today, to: today })).filter((r) => r.invoice_number === sale.number);
    expect(rows).toEqual([expect.objectContaining({ plan_name: planName, base: sale.subtotal, rate_pct: RATE, commission, accrued, open: cents(commission - accrued) })]);
    await page.goto(`/sales/reports/commissions?p=${encodeURIComponent(JSON.stringify({ from: today, to: today, status: "all" }))}`);
    await expect(page.getByRole("row", { name: new RegExp(sale.number) }).first()).toContainText(peso(commission - accrued));

    // ── Cartera y cuentas por pagar por edades: the agent's payable, not yet due. ──
    type Aging = { party_document: string; not_due: number; total: number };
    const owed = (await report<Aging>(page.request, "accounting.aging", { kind: "payable", asOf: today })).find((r) => r.party_document === AGENT.documentNumber);
    expect(owed, "the agent in the payables aging").toBeTruthy();
    expect(Number(owed!.not_due)).toBeGreaterThanOrEqual(accrued);
    await page.goto(`/accounting/reports/aging?p=${encodeURIComponent(JSON.stringify({ kind: "payable", asOf: today }))}`);
    await expect(page.getByRole("cell", { name: AGENT.legalName }).first()).toBeVisible();

    // ── A sees their commission; B sees neither it nor the report's row. ──
    await signIn(page, a);
    await page.goto("/sales/commissions");
    await expect(grid(page).getByRole("row", { name: new RegExp(`${com!.number}\\b`) })).toBeVisible();
    await signIn(page, b);
    await page.goto("/sales/commissions");
    await expect(grid(page)).toBeVisible();
    await expect(grid(page).getByRole("row", { name: new RegExp(`${com!.number}\\b`) })).toHaveCount(0);
    await page.goto(`/r/sales.commission/${com!.id}`);
    await expect(page.getByRole("heading", { name: "No encontrado" })).toBeVisible();
    expect((await report<Row>(page.request, "sales.commissions", { from: today, to: today })).filter((r) => r.invoice_number === sale.number)).toEqual([]);
  });
});
