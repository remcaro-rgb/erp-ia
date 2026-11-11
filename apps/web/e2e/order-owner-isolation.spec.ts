import { execFileSync } from "node:child_process";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import postgres from "postgres";
import { expect, test } from "../test-support/streamed";
import { DEMO_COMPANY_ID, LAURA } from "../../../scripts/demo/accounts";
import { totpCode } from "../test-support/auth-fixtures";
import { testEnv } from "../test-support/env";

// A pedido belongs to its salesperson (plan 2B Task 39, owner item 29 of 2026-11-06, design §6, §22.28; migration 0139) on the demo company.
// Two salespeople, A and B (test-support/order-owner-chain.mts makes them through the admin processes: a role that creates pedidos and holds no
// sales.order.reassign), each write a pedido. A's list and A's address for B's pedido show nothing (not found), and B's entrega, which A may read,
// names its pedido «Pedido no disponible», without number, id or link. Laura (admin: she may run sales.order.reassign) sees both, reads each
// salesperson, and «Cambiar vendedor» hands B's pedido to A; then A reads it (and B no longer does), and the entrega links to it.
//
// The spec runs on the shared demo: the two salespeople are fixed (reused by the next run, deactivated in afterAll) and both pedidos and the
// entrega are cancelled and voided at the end, so a run leaves two cancelled pedidos.

const sql = postgres(testEnv().DATABASE_URL, { max: 2, onnotice: () => {} });
const CHAIN = join(__dirname, "..", "test-support", "order-owner-chain.mts");
const CUSTOMER_DOCUMENT = "900888123";

const chain = (args: string[]): Record<string, unknown> => {
  const out = execFileSync("pnpm", ["exec", "tsx", CHAIN, DEMO_COMPANY_ID, laura, ...args], { cwd: join(__dirname, ".."), stdio: "pipe", env: process.env, timeout: 180_000 }).toString().trim().split("\n");
  return JSON.parse(out[out.length - 1]!) as Record<string, unknown>;
};

interface Seller {
  id: string;
  email: string;
  password: string;
  name: string;
}
let laura = "";
let a: Seller;
let b: Seller;
let orderA: { id: string; number: string };
let orderB: { id: string; number: string };
let deliveryB: { id: string; number: string };
/** An invoice of the demo that bills a pedido of someone else (the first one it issued), with the pedido and its salesperson. */
let invoice: { id: string; order_id: string; order_number: string; owner_name: string };

const frame = (page: Page) => page.locator(".erp-record").filter({ visible: true });
const grid = (page: Page) => page.locator("section.erp-grid").filter({ visible: true });

/** Signs the browser in as `who` (a different user each time: the session's cookies go first). */
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

/** Opens the list of pedidos and waits until it has its rows. */
async function openOrders(page: Page) {
  await page.goto("/sales/orders");
  await expect(grid(page).getByRole("row").nth(1)).toBeVisible();
}
const orderRow = (page: Page, number: string) => grid(page).getByRole("row", { name: new RegExp(`${number}\\b`) });

test.describe("order owner isolation", () => {
  test.describe.configure({ mode: "serial" });

  test.beforeAll(async () => {
    test.setTimeout(240_000);
    const [user] = await sql<{ id: string }[]>`select id from kernel.users where email = ${LAURA.email}`;
    laura = user!.id;
    const sellers = chain(["setup"]) as { a: Seller; b: Seller };
    a = sellers.a;
    b = sellers.b;
    orderA = chain(["order", a.id, CUSTOMER_DOCUMENT]) as typeof orderA;
    orderB = chain(["order", b.id, CUSTOMER_DOCUMENT]) as typeof orderB;
    deliveryB = chain(["deliver", orderB.id]) as typeof deliveryB;
    const [found] = await sql<{ id: string; order_id: string; order_number: string; owner_name: string }[]>`
      select i.id, o.id as order_id, o.number as order_number, u.full_name as owner_name
      from invoicing.invoices i join invoicing.invoice_lines l on l.invoice_id = i.id join sales.orders o on o.id = l.order_id join kernel.users u on u.id = o.owner_id
      where i.company_id = ${DEMO_COMPANY_ID} and o.owner_id not in (${a.id}, ${b.id}) order by i.seq limit 1`;
    invoice = found!;
    expect(invoice, "an invoice of the demo with a pedido of its own").toBeTruthy();
  });

  test.afterAll(async () => {
    try {
      if (deliveryB && orderB) chain(["close", orderB.id, deliveryB.id]);
      if (orderA) chain(["close", orderA.id]);
      chain(["teardown"]);
    } finally {
      await sql.end();
    }
  });

  test("a salesperson sees only their own pedidos: B's is neither in A's list nor at its address, and B's entrega names no pedido", async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await signIn(page, a);

    await openOrders(page);
    await expect(orderRow(page, orderA.number)).toBeVisible();
    await expect(orderRow(page, orderB.number)).toHaveCount(0);

    // A's own pedido: the salesperson is shown, and A may not change it (no «Cambiar vendedor»).
    await page.goto(`/r/sales.order/${orderA.id}`);
    await expect(frame(page).getByTestId("order-owner")).toContainText(a.name);
    await expect(frame(page).getByRole("button", { name: "Cambiar vendedor" })).toHaveCount(0);

    // B's pedido by its address: not found.
    await page.goto(`/r/sales.order/${orderB.id}`);
    await expect(page.getByRole("heading", { name: "No encontrado" })).toBeVisible();
    await expect(page.getByText(orderB.number)).toHaveCount(0);

    // B's entrega is not isolated, but the pedido it names is not A's to see: plain text, no number, no id, no link.
    await page.goto(`/r/sales.delivery/${deliveryB.id}`);
    await expect(frame(page).getByText(deliveryB.number).first()).toBeVisible();
    await expect(frame(page).getByTestId("order-unavailable")).toContainText("Pedido no disponible");
    await expect(frame(page).getByText(orderB.number)).toHaveCount(0);
    await expect(frame(page).getByText(orderB.id)).toHaveCount(0);
    await expect(frame(page).locator(`a[href*="${orderB.id}"]`)).toHaveCount(0);
    await expect(frame(page).getByTestId("order-owner")).toHaveCount(0);
    // Versiones of the entrega: once its history has rendered (a version row), the pedido's id is not in it.
    await frame(page).getByRole("tab", { name: /Versiones/ }).click();
    const deliveryVersions = frame(page).getByRole("tabpanel", { name: /Versiones/ });
    await expect(deliveryVersions.getByRole("table", { name: "Versión" }).getByRole("row").nth(1)).toBeVisible();
    await expect(deliveryVersions.getByText(orderB.id)).toHaveCount(0);

    // An invoice of a pedido that is not A's: readable (invoices are not isolated by the owner), and its «Pedidos» fact names no pedido.
    await page.goto(`/r/invoicing.invoice/${invoice.id}`);
    await expect(frame(page).getByTestId("invoice-orders-field")).toContainText("Pedido no disponible");
    await expect(frame(page).getByText(invoice.order_number, { exact: true })).toHaveCount(0);
    await expect(frame(page).getByTestId("invoice-orders-field")).not.toContainText(invoice.order_id);
    await expect(frame(page).locator(`a[href*="${invoice.order_id}"]`)).toHaveCount(0);
    await expect(frame(page).getByTestId("invoice-order-owners-field")).toHaveCount(0);
    // Versiones (the invoice's version history) says «Pedido no disponible» too, never the id.
    await frame(page).getByRole("tab", { name: /Versiones/ }).click();
    const versions = frame(page).getByRole("tabpanel", { name: /Versiones/ });
    await expect(versions.getByText("Pedido no disponible").first()).toBeVisible();
    await expect(versions.getByText(invoice.order_id)).toHaveCount(0);

    // The entregas' list: B's entrega is there (not isolated), its pedido reads «Pedido no disponible», no id and no link to it.
    await page.goto("/sales/deliveries");
    const deliveryRow = grid(page).getByRole("row", { name: new RegExp(`${deliveryB.number}\\b`) });
    await expect(deliveryRow).toBeVisible();
    await expect(deliveryRow).toContainText("Pedido no disponible");
    await expect(page.locator(`a[href*="${orderB.id}"]`)).toHaveCount(0);
    await expect(page.getByText(orderB.id.slice(0, 8), { exact: false })).toHaveCount(0);

    // ⌘K by ID does not find B's pedido (it finds A's own).
    const seqOf = async (id: string) => (await sql<{ seq: string }[]>`select seq::text from sales.orders where id = ${id}`)[0]!.seq;
    const [seqA, seqB] = [await seqOf(orderA.id), await seqOf(orderB.id)];
    await page.goto("/");
    await page.keyboard.press("ControlOrMeta+k");
    await page.getByRole("combobox").fill(`ID ${seqA}`);
    await expect(page.getByRole("option", { name: new RegExp(`Pedido de venta · ID ${seqA} · ${orderA.number}`) })).toBeVisible();
    // B's seq: wait for the palette's own lookup of that ID to answer (no assumption on which other records share the seq), let the
    // answer render, then no pedido is offered.
    const lookedUp = page.waitForResponse((r) => r.request().method() === "POST" && r.request().headers()["next-action"] !== undefined && r.request().postData() === `[${seqB}]`);
    await page.getByRole("combobox").fill(`ID ${seqB}`);
    await lookedUp;
    await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
    await expect(page.getByRole("option", { name: /Pedido de venta/ })).toHaveCount(0);
  });

  test("the manager sees both pedidos and their salespeople, and «Cambiar vendedor» moves B's pedido to A", async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await signIn(page, { email: LAURA.email, password: LAURA.password, totp: LAURA.totpSecret! });

    await openOrders(page);
    await expect(orderRow(page, orderA.number)).toBeVisible();
    await expect(orderRow(page, orderB.number)).toBeVisible();
    // The «Vendedor» column names each pedido's salesperson (a member's name, not an id).
    await expect(orderRow(page, orderA.number)).toContainText(a.name);
    await expect(orderRow(page, orderB.number)).toContainText(b.name);

    // B's entrega names the pedido and its salesperson to a holder of the permission.
    await page.goto(`/r/sales.delivery/${deliveryB.id}`);
    await expect(frame(page).locator(`a[href*="${orderB.id}"]`).first()).toBeVisible();
    await expect(frame(page).getByTestId("order-owner")).toContainText(b.name);

    // The same invoice names its pedido, as a link, and the salesperson of each pedido the caller reads («Vendedor del pedido»).
    await page.goto(`/r/invoicing.invoice/${invoice.id}`);
    await expect(frame(page).getByTestId("invoice-orders-field").locator(`a[href*="${invoice.order_id}"]`)).toBeVisible();
    await expect(frame(page).getByTestId("invoice-orders-field")).not.toContainText("Pedido no disponible");
    await expect(frame(page).getByTestId("invoice-order-owners-field")).toContainText(`${invoice.order_number}: ${invoice.owner_name}`);

    await page.goto(`/r/sales.order/${orderB.id}`);
    await expect(frame(page).getByTestId("order-owner")).toContainText(b.name);
    await frame(page).getByRole("button", { name: "Cambiar vendedor" }).click();
    const dialog = page.getByRole("dialog", { name: "Cambiar vendedor" });
    await expect(dialog).toBeVisible();
    const assign = dialog.getByRole("button", { name: "Asignar" });
    await expect(assign).toBeDisabled();
    await dialog.getByLabel("Vendedor").selectOption({ label: a.name });
    await assign.click();
    await expect(page.getByText(`Pedido asignado a ${a.name}`)).toBeVisible();
    await expect(frame(page).getByTestId("order-owner")).toContainText(a.name);
    await expect(frame(page).getByTestId("order-owner")).not.toContainText(b.name);

    // The change is audited with its process.
    const [audit] = await sql<{ process_id: string }[]>`
      select process_id from kernel.audit_log where company_id = ${DEMO_COMPANY_ID} and row_id = ${orderB.id} and process_id = 'sales.order.reassign' limit 1`;
    expect(audit?.process_id).toBe("sales.order.reassign");
  });

  test("after the change A reads B's former pedido and B no longer does; the entrega now links to it for A", async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await signIn(page, a);
    await openOrders(page);
    await expect(orderRow(page, orderA.number)).toBeVisible();
    await expect(orderRow(page, orderB.number)).toBeVisible();
    await page.goto(`/r/sales.order/${orderB.id}`);
    await expect(frame(page).getByTestId("order-owner")).toContainText(a.name);
    await page.goto(`/r/sales.delivery/${deliveryB.id}`);
    await expect(frame(page).locator(`a[href*="${orderB.id}"]`).first()).toBeVisible();
    await expect(frame(page).getByTestId("order-unavailable")).toHaveCount(0);

    await signIn(page, b);
    await page.goto(`/r/sales.order/${orderB.id}`);
    await expect(page.getByRole("heading", { name: "No encontrado" })).toBeVisible();
    await page.goto(`/r/sales.delivery/${deliveryB.id}`);
    await expect(frame(page).getByTestId("order-unavailable")).toContainText("Pedido no disponible");
  });
});
