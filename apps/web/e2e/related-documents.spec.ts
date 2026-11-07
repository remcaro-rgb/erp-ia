import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, test } from "../test-support/streamed";
import { enrolTotp, seedAuthUser, type AuthFixture } from "../test-support/auth-fixtures";
import { signInWithCode } from "../test-support/accounting-fixture";
import { cleanupCompanies } from "../test-support/company-cleanup";

// The tab «Documentos relacionados» of a record page (Task 31, design §22.27, R31-8; prototype-free: the tab is drawn from the trail consult
// alone). A sale runs through the registered processes (test-support/invoicing-chain.mts configures the company, related-chain.mts writes the
// quote, the order made from it, the delivery, the invoice and the receipt, the mock DIAN accepts the invoice): from the invoice the tab lists
// the quote, the order and the delivery upstream and the receipt downstream, each a link to its page; from the quote it lists the order, the
// delivery, the invoice and the receipt downstream; a user who may not consult invoices opens the order and sees the hidden line and no invoice
// number; a voided receipt reads «Anulado», struck through.

const CHAIN = join(__dirname, "..", "test-support", "invoicing-chain.mts");
const RELATED = join(__dirname, "..", "test-support", "related-chain.mts");
const DIAN = join(__dirname, "..", "test-support", "mock-dian.mts");
const tsx = (script: string, args: string[]) =>
  execFileSync("pnpm", ["exec", "tsx", script, ...args], { cwd: join(__dirname, ".."), stdio: "pipe", env: process.env, timeout: 120_000 }).toString();
const lastJson = <T>(out: string): T => JSON.parse(out.trim().split("\n").filter((l) => l.startsWith("{")).at(-1)!) as T;

const frame = (page: Page) => page.locator(".erp-record").filter({ visible: true });
const SABANA = "860002964";

interface Doc { id: string; number: string }

test.describe("related documents tab", () => {
  test.describe.configure({ mode: "serial" });
  let fixture: AuthFixture;
  let secret: string;
  let companyId: string;
  let sale: { quote: Doc; order: Doc; delivery: Doc; invoice: Doc };
  let receipt: Doc;
  const viewer = { email: "", password: "", userId: "" };

  const openTab = async (page: Page, entity: string, id: string) => {
    await page.goto(`/r/${entity}/${id}`);
    await frame(page).getByRole("tab", { name: /^Documentos relacionados/ }).click();
    return frame(page).getByRole("tabpanel", { name: /^Documentos relacionados/ });
  };

  test.beforeAll(async () => {
    test.setTimeout(300_000);
    fixture = await seedAuthUser({ role: "admin" });
    secret = await enrolTotp(fixture);
    companyId = fixture.companyIds[0]!;
    for (const key of ["module:core", "module:accounting", "module:inventory", "module:costing", "module:sales", "module:crm", "module:invoicing", "module:payments"]) {
      await fixture.sql`insert into kernel.tenant_entitlements(tenant_id, key, source) values (${fixture.tenantId}, ${key}, 'manual')`;
    }
    tsx(CHAIN, [companyId, fixture.userId]);
    sale = lastJson<typeof sale>(tsx(RELATED, [companyId, fixture.userId, "sale", SABANA]));
    tsx(DIAN, ["invoice", sale.invoice.id, "accepted"]);
    receipt = lastJson<{ receipt: Doc }>(tsx(RELATED, [companyId, fixture.userId, "pay", sale.invoice.id])).receipt;

    // A seller who consults quotes, orders, deliveries and receipts but not invoices.
    const suffix = randomUUID().slice(0, 8);
    viewer.email = `viewer-${suffix}@test.local`;
    viewer.password = `pw-${randomUUID()}`;
    const created = await fixture.admin.auth.admin.createUser({ email: viewer.email, password: viewer.password, email_confirm: true });
    if (created.error || !created.data.user) throw new Error(`could not create the viewer: ${created.error?.message}`);
    viewer.userId = created.data.user.id;
    await fixture.sql`insert into kernel.users(id, email, full_name) values (${viewer.userId}, ${viewer.email}, 'Vendedor')`;
    const [role] = await fixture.sql<{ id: string }[]>`insert into kernel.roles(company_id, name) values (${companyId}, 'vendedor') returning id`;
    const [membership] = await fixture.sql<{ id: string }[]>`insert into kernel.memberships(user_id, company_id) values (${viewer.userId}, ${companyId}) returning id`;
    await fixture.sql`insert into kernel.membership_roles(membership_id, role_id) values (${membership!.id}, ${role!.id})`;
    for (const process of ["crm.quote.consult", "sales.order.consult", "sales.delivery.consult", "payments.receipt.consult", "core.party.consult", "core.product.consult", "inventory.warehouse.consult", "kernel.document_link.trail"]) {
      await fixture.sql`insert into kernel.process_permissions(company_id, role_id, process_id) values (${companyId}, ${role!.id}, ${process}) on conflict do nothing`;
    }
  });

  test.afterAll(async () => {
    if (!fixture) return;
    try {
      if (viewer.userId) {
        await fixture.sql`delete from kernel.membership_roles where membership_id in (select id from kernel.memberships where user_id = ${viewer.userId})`;
        await fixture.sql`delete from kernel.memberships where user_id = ${viewer.userId}`;
        await fixture.sql`delete from kernel.users where id = ${viewer.userId}`;
        await fixture.admin.auth.admin.deleteUser(viewer.userId);
      }
      await cleanupCompanies(fixture.sql, fixture.companyIds, fixture.tenantId);
    } finally {
      await fixture.cleanup();
    }
  });

  test("the invoice lists its quote, order, delivery and receipt, each a link to its record page", async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await signInWithCode(page, fixture, secret);
    const panel = await openTab(page, "invoicing.invoice", sale.invoice.id);
    // The chip counts every document of the trail; upstream (Origen) comes before downstream (Derivados).
    await expect(frame(page).getByRole("tab", { name: /^Documentos relacionados/ })).toContainText("4");
    await expect(panel.getByRole("heading", { name: "Origen" })).toBeVisible();
    await expect(panel.getByRole("heading", { name: "Derivados" })).toBeVisible();
    const entries = panel.getByTestId("related-entry");
    await expect(entries).toHaveCount(4);
    const texts = await entries.allInnerTexts();
    expect(texts.findIndex((t) => t.includes(receipt.number))).toBe(3);
    // No module name anywhere in the frame (rule 4): the kind of document is the entity's own name.
    await expect(panel).not.toContainText(/crm|sales\.|invoicing|payments/i);
    await expect(panel.getByTestId("related-hidden")).toHaveCount(0);

    const quoteEntry = entries.filter({ hasText: sale.quote.number });
    await expect(quoteEntry).toContainText("Cotización → Pedido");
    const targets: [Doc, string][] = [[sale.quote, "crm.quote"], [sale.order, "sales.order"], [sale.delivery, "sales.delivery"], [receipt, "payments.receipt"]];
    for (const [doc, entity] of targets) {
      await expect(panel.getByRole("link", { name: doc.number, exact: true })).toHaveAttribute("href", `/r/${entity}/${doc.id}`);
    }
    // Click each and land on its record page: the title shows its number.
    for (const [doc, entity] of targets) {
      const again = await openTab(page, "invoicing.invoice", sale.invoice.id);
      await again.getByRole("link", { name: doc.number, exact: true }).click();
      await expect(page).toHaveURL(new RegExp(`/r/${entity.replace(".", "\\.")}/${doc.id}$`));
      await expect(frame(page).getByRole("heading", { name: new RegExp(doc.number) })).toBeVisible();
    }
  });

  test("the quote lists its order, delivery, invoice and receipt downstream", async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await signInWithCode(page, fixture, secret);
    const panel = await openTab(page, "crm.quote", sale.quote.id);
    await expect(panel.getByRole("heading", { name: "Derivados" })).toBeVisible();
    await expect(panel.getByRole("heading", { name: "Origen" })).toHaveCount(0);
    const entries = panel.getByTestId("related-entry");
    await expect(entries).toHaveCount(4);
    const texts = await entries.allInnerTexts();
    for (const doc of [sale.order, sale.delivery, sale.invoice, receipt]) expect(texts.some((t) => t.includes(doc.number)), doc.number).toBe(true);
    await expect(entries.nth(0)).toContainText(sale.order.number);
  });

  test("a user without consult on invoices opens the order and sees the hidden line and no invoice number", async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/login");
    await page.getByLabel("Correo").fill(viewer.email);
    await page.getByLabel("Contraseña", { exact: true }).fill(viewer.password);
    await page.getByRole("button", { name: "Entrar" }).click();
    await expect(page).toHaveURL(/\/$/);
    const panel = await openTab(page, "sales.order", sale.order.id);
    // The quote is the administrator's own (crm owner scope) and the role may not consult invoices: two documents the caller never sees,
    // counted and never named. The delivery and the receipt past the invoice are still listed.
    await expect(panel.getByTestId("related-hidden")).toHaveText(/Y 2 documentos más que no puedes ver/);
    await expect(panel.getByRole("link", { name: sale.delivery.number, exact: true })).toBeVisible();
    const receiptEntry = panel.getByTestId("related-entry").filter({ hasText: receipt.number });
    await expect(receiptEntry.getByRole("link", { name: receipt.number, exact: true })).toBeVisible();
    // The receipt's edge touches the hidden invoice: it carries no relation word that would name it.
    await expect(receiptEntry).not.toContainText("Factura");
    await expect(panel.getByTestId("related-entry")).toHaveCount(2);
    await expect(page.locator("body")).not.toContainText(sale.invoice.number);
    await expect(page.locator("body")).not.toContainText(sale.quote.number);
    // Nothing of the hidden documents travels in the page either: not in the HTML, not in the RSC payload the server sent with it.
    const html = await page.content();
    for (const hidden of [sale.invoice.id, sale.invoice.number, sale.quote.number]) expect(html).not.toContain(hidden);
    // The cotización's id is on the page once, in the order's own Datos («Cotización» is a field of the pedido, not the trail's): the trail's
    // tab carries none of it.
    expect(await panel.innerHTML()).not.toContain(sale.quote.id);
  });

  test("a voided receipt shows «Anulado», struck through", async ({ page }) => {
    test.setTimeout(120_000);
    tsx(RELATED, [companyId, fixture.userId, "void", receipt.id]);
    await page.setViewportSize({ width: 1440, height: 900 });
    await signInWithCode(page, fixture, secret);
    const panel = await openTab(page, "invoicing.invoice", sale.invoice.id);
    const entry = panel.getByTestId("related-entry").filter({ hasText: receipt.number });
    await expect(entry).toHaveAttribute("data-voided", "true");
    await expect(entry).toContainText("Anulado");
    await expect(entry.getByRole("link", { name: receipt.number })).toHaveCSS("text-decoration-line", /line-through/);
    // The other documents of the chain are live.
    await expect(panel.getByTestId("related-entry").filter({ hasText: sale.order.number })).toHaveAttribute("data-voided", "false");
    // Opened from the voided receipt itself, the invoice it applied to is a live document: not struck through, no «Anulado».
    const fromReceipt = await openTab(page, "payments.receipt", receipt.id);
    const invoiceEntry = fromReceipt.getByTestId("related-entry").filter({ hasText: sale.invoice.number });
    await expect(invoiceEntry).toHaveAttribute("data-voided", "false");
    await expect(invoiceEntry).not.toContainText("Anulado");
  });
});
