import { execFileSync } from "node:child_process";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, test } from "../test-support/streamed";
import { enrolTotp, seedAuthUser, type AuthFixture } from "../test-support/auth-fixtures";
import { confirmStepUp, signInWithCode } from "../test-support/accounting-fixture";
import { cleanupCompanies } from "../test-support/company-cleanup";

// The invoicing pages (plan 2B Task 20; design §8, §8.1 step 5, §9, entity types spec §9.2; prototype 2B /invoicing/invoices/1234): «Por
// facturar» lists what the entregas shipped and is not on an invoice; «Crear facturas» writes the Borrador of the chosen pedido; «Emitir»
// numbers it by the DIAN resolution, computes its CUFE and posts it (the Contabilidad tab); the DIAN's answer moves its chip to Aceptada
// (the mock DIAN, recorded by the e-invoice workflow's own processes: test-support/mock-dian.mts; the e2e stack runs no Workflow World);
// Imprimir makes its PDF; a credit note of one line is written from the invoice, issued, and posted in its own record. A rejection shows the
// DIAN's errors and «Reintentar envío» sends it again; «Anular (nota crédito)» asks for the code, issues the annulment credit note, and the
// invoice reads Anulada once the DIAN accepts that note. A customer that is no longer ready to invoice is refused with the reason.
// Fix round 1: «Por facturar» is the universal grid with a selection column; Emitir, Reintentar envío and Anular are the record bar's; the
// Anular dialog shows the note it issues; a hand-made Borrador saves as a Borrador (Guardar never issues), duplicates and is deleted; a
// note duplicates into its invoice's «Crear nota» panel; the posted entries are checked by account and amount (the annulment reverses them).
// The sale chain the pages start from (accounting configured, the DIAN resolution, the customers, the goods, three shipped pedidos) is
// written through the registered processes by test-support/invoicing-chain.mts.

const CHAIN = join(__dirname, "..", "test-support", "invoicing-chain.mts");
const DIAN = join(__dirname, "..", "test-support", "mock-dian.mts");

const bar = (page: Page) => page.getByRole("group", { name: "Acciones del registro" });
const frame = (page: Page) => page.locator(".erp-record").filter({ visible: true });
const grid = (page: Page) => page.locator("section.erp-grid").filter({ visible: true });

const tsx = (script: string, args: string[]) =>
  execFileSync("pnpm", ["exec", "tsx", script, ...args], { cwd: join(__dirname, ".."), stdio: "pipe", env: process.env, timeout: 120_000 }).toString();
const lastJson = <T>(out: string): T => JSON.parse(out.trim().split("\n").filter((l) => l.startsWith("{")).at(-1)!) as T;

test.describe("invoicing pages", () => {
  test.describe.configure({ mode: "serial" });
  let fixture: AuthFixture;
  let secret: string;
  let companyId: string;
  let chain: { orders: { orderId: string; orderNumber: string; deliveryId: string; deliveryNumber: string }[] };

  const invoiceOf = async (orderId: string) =>
    (await fixture.sql<{ id: string; number: string | null; stage: string; status: string; dian_status: string; cufe: string | null }[]>`
      select distinct i.id, i.number, i.stage, i.status, i.dian_status, i.cufe from invoicing.invoices i join invoicing.invoice_lines l on l.invoice_id = i.id
      where i.company_id = ${companyId} and l.order_id = ${orderId}`)[0];
  const dian = (kind: "invoice" | "note", id: string, verdict: "accepted" | "rejected", ...errors: string[]) => tsx(DIAN, [kind, id, verdict, ...errors]);
  /** The posted comprobante of a source record: its number and the net (debit − credit) per account code. */
  const entryOf = async (entity: string, id: string) => {
    const rows = await fixture.sql<{ number: string; code: string; debit: string; credit: string }[]>`
      select e.number, a.code, l.debit::text, l.credit::text from accounting.entries e
      join accounting.entry_lines l on l.entry_id = e.id join accounting.accounts a on a.id = l.account_id
      where e.company_id = ${companyId} and e.source_entity = ${entity} and e.source_record_id = ${id} and e.status = 'posted'`;
    const net: Record<string, number> = {};
    for (const r of rows) net[r.code] = Math.round(((net[r.code] ?? 0) + Number(r.debit) - Number(r.credit)) * 100) / 100;
    return { number: rows[0]?.number ?? null, net, debit: rows.reduce((t, r) => t + Number(r.debit), 0), credit: rows.reduce((t, r) => t + Number(r.credit), 0) };
  };
  const openTab = async (page: Page, name: RegExp) => {
    await frame(page).getByRole("tab", { name }).click();
    return frame(page).getByRole("tabpanel", { name });
  };

  test.beforeAll(async () => {
    test.setTimeout(240_000);
    fixture = await seedAuthUser({ role: "admin" });
    secret = await enrolTotp(fixture);
    companyId = fixture.companyIds[0]!;
    const { sql } = fixture;
    for (const key of ["module:core", "module:accounting", "module:inventory", "module:costing", "module:sales", "module:crm", "module:invoicing"]) {
      await sql`insert into kernel.tenant_entitlements(tenant_id, key, source) values (${fixture.tenantId}, ${key}, 'manual')`;
    }
    chain = lastJson(tsx(CHAIN, [companyId, fixture.userId]));
  });

  test.afterAll(async () => {
    if (!fixture) return;
    try {
      await cleanupCompanies(fixture.sql, fixture.companyIds, fixture.tenantId);
    } finally {
      await fixture.cleanup();
    }
  });

  test("Por facturar → Borrador → Emitir → Aceptada (mock DIAN); Imprimir; a credit note issued; both posted in their Contabilidad tab", async ({ page }) => {
    test.setTimeout(240_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await signInWithCode(page, fixture, secret);
    const [first] = chain.orders;

    // Facturación › Documentos › Facturas: the grid, with «Crear factura desde pedidos» beside it.
    await page.goto("/invoicing/invoices");
    await expect(page.getByRole("navigation", { name: "Menú del módulo" })).toBeVisible();
    await expect(grid(page)).toBeVisible();
    // Nueva factura (by hand): the customer, the payment form and means, the due date and the priced lines; Guardar keeps it a Borrador
    // (saveOnly: no number, no CUFE, nothing posted), and the bar then has Guardar and Emitir together.
    await page.goto("/r/invoicing.invoice/new");
    for (const label of ["Forma de pago", "Medio de pago", "Vencimiento"]) await expect(frame(page).getByLabel(label)).toBeVisible();
    await page.getByRole("combobox", { name: "Cliente" }).fill("Hotel Casa");
    await page.getByRole("option", { name: /Hotel Casa Andina/ }).first().click();
    await page.getByRole("combobox", { name: "Producto, línea 1" }).fill("FAC-CAF");
    await page.getByRole("option", { name: /FAC-CAF-500/ }).first().click();
    await page.getByLabel("Cantidad, línea 1").fill("2");
    await bar(page).getByRole("button", { name: "Guardar", exact: true }).click();
    await expect(page).toHaveURL(/\/r\/invoicing\.invoice\/[0-9a-f-]{36}$/);
    const handId = page.url().split("/").pop()!;
    await expect(frame(page).getByTestId("invoice-stage")).toHaveText("Borrador");
    const [hand] = await fixture.sql<{ stage: string; number: string | null; cufe: string | null; status: string }[]>`select stage, number, cufe, status from invoicing.invoices where id = ${handId}`;
    expect(hand).toMatchObject({ stage: "draft", number: null, cufe: null, status: "draft" });
    expect((await entryOf("invoicing.invoice", handId)).number).toBeNull();
    await expect(bar(page).getByRole("button", { name: "Guardar", exact: true })).toBeVisible();
    await expect(bar(page).getByRole("button", { name: "Emitir", exact: true })).toBeEnabled();
    // Reintentar envío is in the bar, disabled with why (a Borrador is not sent), never hidden; a Borrador has no Anular.
    await expect(bar(page).getByRole("button", { name: "Reintentar envío", exact: true })).toBeDisabled();
    await expect(bar(page).getByRole("button", { name: "Reintentar envío", exact: true })).toHaveAttribute("title", /emítelo/);
    await expect(bar(page).getByRole("button", { name: "Anular (nota crédito)" })).toHaveCount(0);
    // Duplicar (rule 37): the create form starts from the copy (its lines), never its identity.
    await bar(page).getByRole("button", { name: "Duplicar" }).click();
    await expect(page).toHaveURL(/\/r\/invoicing\.invoice\/new$/);
    await expect(frame(page).getByLabel("Cantidad, línea 1")).toHaveValue("2");
    await expect(frame(page).getByText(/Copia de/).first()).toBeVisible();
    // Eliminar the Borrador: it is gone (a Borrador is deleted, never annulled).
    await page.goto(`/r/invoicing.invoice/${handId}`);
    await bar(page).getByRole("button", { name: "Eliminar", exact: true }).click();
    await bar(page).getByRole("button", { name: "Sí, eliminar", exact: true }).click();
    await expect(page).toHaveURL(/\/invoicing\/invoices$/);
    expect(await fixture.sql`select 1 from invoicing.invoices where id = ${handId}`).toHaveLength(0);
    await page.goto("/invoicing/invoices");
    await page.getByRole("link", { name: "Crear factura desde pedidos" }).click();
    await expect(page).toHaveURL(/\/invoicing\/pending$/);

    // «Por facturar» (Reportes): the universal grid (rule 20) of what each entrega shipped and is not on an invoice, filtered by pedido.
    await expect(grid(page)).toBeVisible();
    await expect(page.getByRole("button", { name: "Crear facturas", exact: true })).toBeDisabled();
    await grid(page).getByLabel("Filtrar Pedido").fill(first!.orderNumber);
    await expect(grid(page).locator("tbody tr")).toHaveCount(2);
    await expect(grid(page).locator("tbody tr").first()).toContainText(first!.deliveryNumber);
    await grid(page).getByRole("checkbox", { name: "Seleccionar todas las filas de la página" }).check();
    await page.getByRole("button", { name: "Crear facturas", exact: true }).click();
    await expect(page).toHaveURL(/\/r\/invoicing\.invoice\/[0-9a-f-]{36}$/);
    const draft = (await invoiceOf(first!.orderId))!;
    expect(draft).toMatchObject({ stage: "draft", number: null, dian_status: "draft" });
    await expect(frame(page).getByTestId("invoice-stage")).toHaveText("Borrador");
    // The pedido and its entrega are references that open their records (rule 21).
    await expect(frame(page).getByRole("link", { name: first!.orderNumber })).toBeVisible();
    await expect(frame(page).getByRole("link", { name: first!.deliveryNumber })).toBeVisible();
    // 3 × $ 28.000 + IVA 5 % and 1 × $ 50.000 + IVA 19 %: $ 147.700,00 (rule 23).
    await expect(frame(page).getByTestId("invoice-total")).toHaveText("$ 147.700,00");
    // Anular explains why it is not there yet: a Borrador is deleted (Eliminar), not annulled.
    await expect(bar(page).getByRole("button", { name: "Anular (nota crédito)" })).toHaveCount(0);

    // «Emitir» (the bar's, on any tab): numbered by the DIAN resolution (FE), its CUFE, posted in the same action.
    await openTab(page, /^Líneas e impuestos/);
    await bar(page).getByRole("button", { name: "Emitir", exact: true }).click();
    await openTab(page, /^Datos$/);
    await expect(frame(page).getByTestId("invoice-stage")).toHaveText("Emitida");
    const issued = (await invoiceOf(first!.orderId))!;
    expect(issued.number).toMatch(/^FE/);
    expect(issued.cufe).toMatch(/^[0-9a-f]{96}$/);
    await expect(frame(page).getByTestId("invoice-cufe")).toHaveText(issued.cufe!);
    await expect(frame(page).getByTestId("invoice-dian")).toHaveText("Sin enviar");
    // Not accepted yet: Anular (nota crédito) is in the bar, disabled with the reason.
    await expect(bar(page).getByRole("button", { name: "Anular (nota crédito)" })).toBeDisabled();
    await expect(bar(page).getByRole("button", { name: "Anular (nota crédito)" })).toHaveAttribute("title", /DIAN/);

    // The DIAN accepts it (mock): Aceptada, with the trail Emitida · Enviada a la DIAN · Aceptada.
    dian("invoice", issued.id, "accepted");
    await page.reload();
    await expect(frame(page).getByTestId("invoice-dian")).toHaveText("Aceptada");
    const trail = frame(page).getByRole("list", { name: "Recorrido DIAN" });
    await expect(trail.getByRole("listitem")).toHaveText([/Emitida/, /Enviada a la DIAN/, /Aceptada/]);
    const dianTab = await openTab(page, /^DIAN/);
    await expect(dianTab).toContainText(`mock-track-${issued.id.slice(0, 8)}-1`);
    const response = dianTab.getByRole("link", { name: "Respuesta de la DIAN (ApplicationResponse)" });
    await expect(response).toBeVisible();
    // The file is reached through a short-lived signed link the server makes for the caller (rule 22), never a public path.
    const download = await page.request.get((await response.getAttribute("href"))!, { maxRedirects: 0 });
    expect(download.status()).toBe(303);
    expect(download.headers().location).toMatch(/token=/);
    // Líneas e impuestos: the lines and the taxes per rate in the universal grid (rule 20).
    const lines = await openTab(page, /^Líneas e impuestos/);
    await expect(lines.locator("section.erp-grid").first().locator("tbody tr")).toHaveCount(2);
    await expect(lines.locator("section.erp-grid").nth(1).locator("tbody tr")).toHaveCount(2);
    // Contabilidad: the invoice's comprobante, balanced, the receivable debited with the total, revenue and IVA credited by line and rate.
    const ledger = await openTab(page, /^Contabilidad/);
    await expect(ledger.locator("tbody tr")).toHaveCount(1);
    const invoiceEntry = await entryOf("invoicing.invoice", issued.id);
    await expect(ledger.locator("tbody tr").first()).toContainText(invoiceEntry.number!);
    expect(invoiceEntry.debit).toBe(147700);
    expect(invoiceEntry.credit).toBe(147700);
    const receivable = Object.entries(invoiceEntry.net).filter(([, n]) => n > 0);
    expect(receivable).toEqual([[expect.stringMatching(/^1305/), 147700]]);
    // Revenue 84.000 + 50.000 and IVA 4.200 (5 %) + 9.500 (19 %).
    const credits = Object.entries(invoiceEntry.net).filter(([, n]) => n < 0);
    expect(credits.filter(([c]) => c.startsWith("4")).reduce((t, [, n]) => t + n, 0)).toBe(-134000);
    expect(credits.filter(([c]) => c.startsWith("24")).reduce((t, [, n]) => t + n, 0)).toBe(-13700);

    // Imprimir: the invoice's PDF (Task 19's template: CUFE, QR, resolution legend).
    await openTab(page, /^Datos$/);
    const job = page.waitForResponse((r) => /\/api\/export\/[0-9a-f-]{36}$/.test(r.url()));
    await bar(page).getByRole("button", { name: "Imprimir" }).click();
    const answer = (await (await job).json()) as { url?: string; fileName?: string };
    expect(answer.fileName).toMatch(/\.pdf$/);
    const [printed] = await fixture.sql<{ format: string; entity: string }[]>`select format, entity from kernel.export_jobs where company_id = ${companyId} order by created_at desc limit 1`;
    expect(printed).toMatchObject({ format: "pdf", entity: "invoicing.invoice" });

    // «Crear nota crédito»: one unit of the coffee line back, concept 1 (devolución), its reason.
    await frame(page).getByRole("button", { name: "Crear nota crédito", exact: true }).click();
    const panel = frame(page).getByRole("region", { name: "Nota crédito" });
    await panel.getByLabel("Concepto").selectOption("1");
    await panel.getByLabel("Motivo").fill("Devolución de una bolsa");
    await panel.getByLabel("Cantidad, línea 1").fill("1");
    await panel.getByRole("button", { name: "Crear nota", exact: true }).click();
    await expect(page).toHaveURL(/\/r\/invoicing\.note\/[0-9a-f-]{36}$/);
    await expect(frame(page).getByTestId("note-stage")).toHaveText("Borrador");
    await expect(frame(page).getByRole("link", { name: issued.number! })).toBeVisible();
    await bar(page).getByRole("button", { name: "Emitir", exact: true }).click();
    await expect(frame(page).getByTestId("note-stage")).toHaveText("Emitida");
    const [note] = await fixture.sql<{ id: string; number: string; total: string }[]>`select id, number, total::text from invoicing.notes where company_id = ${companyId} and invoice_id = ${issued.id}`;
    expect(note!.number).toMatch(/^NC/);
    expect(Number(note!.total)).toBe(29400);
    // Both are posted: the note in its own Contabilidad tab (one bag back: 28.000 + IVA 1.400 off the receivable), the invoice in its own.
    await expect((await openTab(page, /^Contabilidad/)).locator("tbody tr")).toHaveCount(1);
    const noteEntry = await entryOf("invoicing.note", note!.id);
    expect(noteEntry.debit).toBe(29400);
    expect(Object.entries(noteEntry.net).filter(([c]) => c.startsWith("1305"))).toEqual([[expect.any(String), -29400]]);
    // Duplicar a note (rule 37): its invoice opens with «Crear nota» started from the note (concept, reason, quantities).
    await openTab(page, /^Datos$/);
    await bar(page).getByRole("button", { name: "Duplicar", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/r/invoicing\\.invoice/${issued.id}$`));
    const copy = frame(page).getByRole("region", { name: "Nota crédito" });
    await expect(copy.getByLabel("Concepto")).toHaveValue("1");
    await expect(copy.getByLabel("Motivo")).toHaveValue("Devolución de una bolsa");
    await expect(copy.getByLabel("Cantidad, línea 1")).toHaveValue("1");
    await copy.getByRole("button", { name: "Cancelar", exact: true }).click();
    await page.goto(`/r/invoicing.invoice/${issued.id}`);
    await expect(frame(page).getByRole("link", { name: note!.number })).toBeVisible();
    await expect((await openTab(page, /^Contabilidad/)).locator("tbody tr")).toHaveCount(1);
    // Notas crédito y débito (Documentos): the note in its grid.
    await page.goto("/invoicing/notes");
    await expect(grid(page).getByRole("row", { name: new RegExp(note!.number) })).toContainText("Emitida");
  });

  test("a rejection shows the DIAN's errors and «Reintentar envío» sends it again; Anular issues the annulment credit note and the invoice reads Anulada", async ({ page }) => {
    test.setTimeout(240_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    const second = chain.orders[1]!;
    const { invoiceId } = lastJson<{ invoiceId: string }>(tsx(CHAIN, [companyId, fixture.userId, "--issue", "890903938"]));
    dian("invoice", invoiceId, "rejected", "Regla FAD06: el NIT del adquirente no coincide (simulado)");
    await signInWithCode(page, fixture, secret);
    await page.goto(`/r/invoicing.invoice/${invoiceId}`);
    await expect(frame(page).getByTestId("invoice-dian")).toHaveText("Rechazada");
    await expect(frame(page).getByRole("list", { name: "Errores de la DIAN" })).toContainText("Regla FAD06");

    await bar(page).getByRole("button", { name: "Reintentar envío", exact: true }).click();
    // On its way again (prototype 2B «En proceso»); the last rejection's errors stay until the new verdict arrives.
    await expect(frame(page).getByTestId("invoice-dian")).toHaveText("En proceso");
    await expect(frame(page).getByRole("list", { name: "Errores de la DIAN" })).toContainText("Regla FAD06");
    await expect(frame(page).getByText("estos son los errores del último rechazo")).toBeVisible();
    const [round] = await fixture.sql<{ status: string; round: number }[]>`select status, round from invoicing.einvoice_submissions where invoice_id = ${invoiceId} and note_id is null`;
    expect(round).toMatchObject({ status: "queued", round: 2 });
    dian("invoice", invoiceId, "accepted");
    await page.reload();
    await expect(frame(page).getByTestId("invoice-dian")).toHaveText("Aceptada");
    await expect(frame(page).getByRole("list", { name: "Errores de la DIAN" })).toHaveCount(0);
    // Accepted: nothing to resend; Reintentar envío stays in the bar, disabled with why.
    await expect(bar(page).getByRole("button", { name: "Reintentar envío", exact: true })).toBeDisabled();
    await expect(bar(page).getByRole("button", { name: "Reintentar envío", exact: true })).toHaveAttribute("title", /ya lo aceptó/);

    // «Anular (nota crédito)» (prototype openVoid): the dialog names the invoice and the note it issues (credit, concept 2, the total, its
    // own numbering) and the code it asks for; Cancelar and «Emitir nota crédito».
    const number = (await fixture.sql<{ number: string; total: string }[]>`select number, total::text from invoicing.invoices where id = ${invoiceId}`)[0]!;
    await bar(page).getByRole("button", { name: "Anular (nota crédito)" }).click();
    const ask = page.getByRole("dialog", { name: `Anular la factura ${number.number}` });
    await expect(ask).toBeVisible();
    const preview = ask.getByRole("region", { name: "Nota que se emitirá" });
    await expect(preview).toContainText("crédito");
    await expect(preview).toContainText("2 · Anulación de factura electrónica");
    await expect(ask.getByTestId("void-value")).toContainText(new Intl.NumberFormat("es-CO", { minimumFractionDigits: 2 }).format(Number(number.total)).replace(/\u00a0/g, " "));
    await expect(preview).toContainText("Numeración propia: NC · siguiente");
    await expect(ask).toContainText("código de verificación");
    await expect(ask.getByRole("button", { name: "Cancelar", exact: true })).toBeVisible();
    await ask.getByLabel("Motivo de la anulación").fill("Factura emitida al cliente equivocado");
    await ask.getByRole("button", { name: "Emitir nota crédito", exact: true }).click();
    await confirmStepUp(page, secret);
    await expect(frame(page).getByTestId("invoice-annulment")).toContainText("La factura sigue emitida hasta que la DIAN acepte la nota");
    await expect(frame(page).getByTestId("invoice-stage")).toHaveText("Emitida");
    const [annulment] = await fixture.sql<{ id: string; annulment: boolean; stage: string }[]>`select id, annulment, stage from invoicing.notes where invoice_id = ${invoiceId}`;
    expect(annulment).toMatchObject({ annulment: true, stage: "issued" });
    dian("note", annulment!.id, "accepted");
    await page.reload();
    await expect(frame(page).getByTestId("invoice-stage")).toHaveText("Anulada");
    await expect(frame(page).getByTestId("invoice-annulment")).toContainText("aceptada por la DIAN");
    // The annulment reverses the invoice's entry account by account, amount by amount.
    const invoiceEntry = await entryOf("invoicing.invoice", invoiceId);
    const annulEntry = await entryOf("invoicing.note", annulment!.id);
    expect(annulEntry.number).not.toBeNull();
    expect(Object.keys(annulEntry.net).sort()).toEqual(Object.keys(invoiceEntry.net).sort());
    for (const [code, net] of Object.entries(invoiceEntry.net)) expect(annulEntry.net[code]).toBe(-net);
    // The grid filters by the stage: Anulada (the invoice keeps its posted status).
    await page.goto("/invoicing/invoices");
    await expect(grid(page).getByRole("row", { name: new RegExp((await invoiceOf(second.orderId))!.number!) })).toContainText("Anulada");
  });

  test("a customer that is no longer ready to invoice is refused with the reason on «Crear facturas»", async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    const third = chain.orders[2]!;
    await fixture.sql`update core.parties set dian_status = 'missing: 1', dian_missing = ${["Dirección"]} where company_id = ${companyId} and document_number = '800197268'`;
    await signInWithCode(page, fixture, secret);
    await page.goto("/invoicing/pending");
    const counted = await fixture.sql<{ n: number }[]>`select count(*)::int as n from invoicing.pending_lines where order_id = ${third.orderId}`;
    const n = counted[0]!.n;
    await grid(page).getByLabel("Filtrar Pedido").fill(third.orderNumber);
    await expect(grid(page).locator("tbody tr")).toHaveCount(n);
    await expect(grid(page).locator("tbody tr").first()).toContainText(third.orderNumber);
    await grid(page).getByRole("checkbox", { name: "Seleccionar todas las filas de la página" }).check();
    await page.getByRole("button", { name: "Crear facturas", exact: true }).click();
    // The readiness gate names the customer and what it lacks (rule 10).
    await expect(page.getByRole("alert").filter({ hasText: "Tienda El Maizal" })).toContainText("Dirección");
    await expect(page).toHaveURL(/\/invoicing\/pending$/);
    expect(await invoiceOf(third.orderId)).toBeUndefined();
  });
});
