import type { Page } from "@playwright/test";
import { expect, test } from "../test-support/streamed";
import { seedAuthUser, type AuthFixture } from "../test-support/auth-fixtures";
import { cleanupAccounting, seedSmallLedger, type SmallLedger } from "../test-support/accounting-fixture";

// The standard record action bar and tabs (Task 15; entity types spec §5–§8, design §10 D15–D18, approved prototype): a party created
// with «Guardar» prints its PDF; a comprobante without approval is Contabilizado by «Guardar» (no «Contabilizar» button, D8); with
// approval «Guardar y enviar a aprobación» sends it and «Aprobar» by the same user posts it (owner rule: no four-eyes); «Anular» asks
// for the reason; Versiones lists the snapshots.

const PROCESSES = [
  "core.party.consult",
  "core.party.create",
  "core.party.update",
  "core.party.save",
  "core.party.submit",
  "core.party.approve",
  "core.party.reject",
  "core.party.delete",
  "accounting.entry.consult",
  "accounting.entry_line.consult",
  "accounting.entry.create",
  "accounting.entry.update",
  "accounting.entry.save",
  "accounting.entry.submit",
  "accounting.entry.approve",
  "accounting.entry.reject",
  "accounting.entry.void",
  "accounting.entry.delete",
  "accounting.entry.reverse",
  "accounting.settings.consult",
  "kernel.custom_field.list",
  "kernel.attachment.list",
  "kernel.doc_template.print",
  "kernel.record.notify",
  "kernel.export.run",
];

async function signIn(page: Page, user: { email: string; password: string }) {
  await page.goto("/login");
  await page.getByLabel("Correo").fill(user.email);
  await page.getByLabel("Contraseña", { exact: true }).fill(user.password);
  await page.getByRole("button", { name: "Entrar" }).click();
  await expect(page).toHaveURL(/\/$/);
}

const bar = (page: Page) => page.getByRole("group", { name: "Acciones del registro" });

test.describe("typed entities: record action bar", () => {
  let fixture: AuthFixture;
  let companyId: string;
  let ledger: SmallLedger;

  /** A balanced draft comprobante in October 2026 (Bancos against Capital). */
  async function draftEntry(description: string, requiresApproval: boolean): Promise<string> {
    const { sql } = fixture;
    const [entry] = await sql<{ id: string }[]>`
      insert into accounting.entries (company_id, journal_id, date, period_id, status, origin, description, requires_approval, posts)
      values (${companyId}, ${ledger.journal}, '2026-10-15', ${ledger.period}, 'draft', 'manual', ${description}, ${requiresApproval}, true) returning id`;
    await sql`insert into accounting.entry_lines (company_id, entry_id, line_no, account_id, debit, credit, debit_doc, credit_doc) values (${companyId}, ${entry!.id}, 1, ${ledger.accounts["111005"]!}, 120000, 0, 120000, 0)`;
    await sql`insert into accounting.entry_lines (company_id, entry_id, line_no, account_id, debit, credit, debit_doc, credit_doc) values (${companyId}, ${entry!.id}, 2, ${ledger.accounts["310505"]!}, 0, 120000, 0, 120000)`;
    return entry!.id;
  }
  const statusOf = async (id: string) => (await fixture.sql<{ status: string }[]>`select status from accounting.entries where id = ${id}`)[0]!.status;

  test.beforeAll(async () => {
    fixture = await seedAuthUser({ role: "member" });
    companyId = fixture.companyIds[0]!;
    const { sql } = fixture;
    for (const key of ["module:core", "module:accounting"]) await sql`insert into kernel.tenant_entitlements(tenant_id, key, source) values (${fixture.tenantId}, ${key}, 'manual')`;
    const [role] = await sql<{ id: string }[]>`select id from kernel.roles where company_id = ${companyId}`;
    for (const process of PROCESSES) await sql`insert into kernel.process_permissions(company_id, role_id, process_id) values (${companyId}, ${role!.id}, ${process})`;
    ledger = await seedSmallLedger(fixture);
  });

  test.afterAll(async () => {
    const { sql } = fixture;
    await sql.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      await tx`delete from kernel.record_snapshots where company_id = ${companyId}`;
      await tx`delete from kernel.state_recipients where company_id = ${companyId}`;
      await tx`delete from kernel.export_jobs where company_id = ${companyId}`;
      await tx`delete from core.parties where company_id = ${companyId}`;
    });
    await cleanupAccounting(fixture);
    await fixture.cleanup();
  });

  test("a party: Guardar creates it, the frame shows its ID with a copy button and the footer who made it; Imprimir makes the PDF", async ({ page }) => {
    await page.setViewportSize({ width: 1400, height: 900 });
    await signIn(page, fixture);
    await page.goto("/r/core.party/new");
    await expect(page.getByRole("heading", { name: "Crear tercero" })).toBeVisible();
    // A new record: no Imprimir, no Notificar (a maestro never has it, D17); its only state button is Guardar.
    await expect(bar(page).getByRole("button", { name: "Imprimir" })).toHaveCount(0);
    await expect(bar(page).getByRole("button", { name: "Notificar" })).toHaveCount(0);
    await page.getByLabel(/^Número/).fill("860002964");
    await page.getByLabel(/^Razón social/).fill("Distribuidora Andina S.A.S.");
    await page.getByLabel(/^Correo de recepción de facturas de venta/).fill("fe@andina.co");
    await bar(page).getByRole("button", { name: "Guardar", exact: true }).click();
    await expect(page).toHaveURL(/\/r\/core\.party\/[0-9a-f-]{36}$/);
    await expect(page.getByRole("heading", { name: "Distribuidora Andina S.A.S." })).toBeVisible();
    const [row] = await fixture.sql<{ seq: string; status: string }[]>`select seq, status from core.parties where company_id = ${companyId} and document_number = '860002964'`;
    expect(row!.status).toBe("saved");
    // The router keeps the visited new-record page mounted (hidden): look at the visible frame.
    const frame = page.locator(".erp-record").filter({ visible: true });
    await expect(frame.getByText(`ID ${row!.seq}`, { exact: true })).toBeVisible();
    await expect(frame.getByRole("button", { name: "Copiar ID", exact: true })).toBeVisible();
    await expect(page.getByText(/^Creado en .+ por Auth user/)).toBeVisible();
    await expect(page.getByText(/^Modificado en .+ por Auth user/)).toBeVisible();
    await expect(page.locator(".erp-record__header").getByText("Grabado", { exact: true })).toBeVisible();

    // Imprimir: the record's PDF as an export job, handed over by its signed link.
    const job = page.waitForResponse((r) => /\/api\/export\/[0-9a-f-]{36}$/.test(r.url()));
    await bar(page).getByRole("button", { name: "Imprimir" }).click();
    const answer = (await (await job).json()) as { url?: string; fileName?: string };
    expect(answer.url).toBeTruthy();
    expect(answer.fileName).toMatch(/\.pdf$/);
    const [printed] = await fixture.sql<{ format: string; entity: string }[]>`select format, entity from kernel.export_jobs where company_id = ${companyId} order by created_at desc limit 1`;
    expect(printed).toMatchObject({ format: "pdf", entity: "core.party" });

    // ⌘K by ID (D16): «ID <seq>» lists the party and opens it.
    await page.goto("/");
    await page.keyboard.press("ControlOrMeta+k");
    await page.getByRole("combobox").fill(`ID ${row!.seq}`);
    await page.getByRole("option", { name: new RegExp(`ID ${row!.seq} · Distribuidora Andina`) }).click();
    await expect(page).toHaveURL(/\/r\/core\.party\/[0-9a-f-]{36}$/);
  });

  test("a comprobante without approval: Guardar posts it in the same action and there is no Contabilizar button", async ({ page }) => {
    await page.setViewportSize({ width: 1400, height: 900 });
    const id = await draftEntry("Aporte de capital", false);
    await signIn(page, fixture);
    await page.goto(`/r/accounting.entry/${id}`);
    await expect(bar(page).getByRole("button", { name: /Contabilizar/ })).toHaveCount(0);
    await expect(bar(page).getByText(/Se contabiliza automáticamente/)).toBeVisible();
    await expect(bar(page).getByRole("button", { name: "Guardar y enviar a aprobación" })).toHaveCount(0);
    await bar(page).getByRole("button", { name: "Guardar", exact: true }).click();
    await expect.poll(() => statusOf(id)).toBe("posted");
    await expect(page.locator(".erp-record__header").getByText("Contabilizado", { exact: true })).toBeVisible();
    // A posted comprobante is final here: no state buttons; Revertir is the module's action, next to Duplicar.
    await expect(bar(page).getByRole("button", { name: "Revertir" })).toBeVisible();
    await expect(bar(page).locator("[data-action]:not([data-action=close])")).toHaveCount(0);
    // Rule 20: the posted comprobante's lines read in the universal grid: sort, advanced filter, both lines.
    const lines = page.locator("section.erp-grid").filter({ visible: true });
    await expect(lines.getByRole("button", { name: "Filtro avanzado" })).toBeVisible();
    await expect(lines.getByRole("button", { name: /^Ordenar por/ }).first()).toBeVisible();
    await expect(lines.locator("tbody tr")).toHaveCount(2);

    // Minor m5 (final review): Notificar prefills the state's configured recipients for a company admin only; a member starts empty.
    await fixture.sql`insert into kernel.state_recipients (company_id, entity, status, emails) values (${companyId}, 'accounting.entry', 'posted', '{contador-externo@example.com}')
                      on conflict (company_id, entity, status) do update set emails = excluded.emails`;
    await page.reload();
    await bar(page).getByRole("button", { name: "Notificar" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByLabel(/^Destinatarios/)).toBeVisible();
    await expect(dialog.getByText("contador-externo@example.com")).toHaveCount(0);
    await expect(dialog.locator(".erp-chip")).toHaveCount(0);
  });

  test("with approval: Guardar y enviar a aprobación sends it, Aprobar by the same user posts it; Versiones lists the snapshots", async ({ page }) => {
    await page.setViewportSize({ width: 1400, height: 900 });
    const id = await draftEntry("Pago con aprobación", true);
    await signIn(page, fixture);
    await page.goto(`/r/accounting.entry/${id}`);
    await bar(page).getByRole("button", { name: "Guardar y enviar a aprobación" }).click();
    await expect.poll(() => statusOf(id)).toBe("pending");
    await expect(page.locator(".erp-record__header").getByText("Pendiente de Aprobación", { exact: true })).toBeVisible();
    // The creator may approve (owner rule); Aprobar posts it in the same action.
    await bar(page).getByRole("button", { name: "Aprobar", exact: true }).click();
    await expect.poll(() => statusOf(id)).toBe("posted");
    await expect(page.locator(".erp-record__header").getByText("Contabilizado", { exact: true })).toBeVisible();

    // Versiones: one snapshot per transition past Borrador, newest first, comparable.
    await page.getByRole("tab", { name: /Versiones/ }).click();
    const versions = page.getByRole("table", { name: "Versión" });
    await expect(versions.getByRole("row")).not.toHaveCount(1);
    const count = Number((await fixture.sql<{ n: string }[]>`select count(*) as n from kernel.record_snapshots where record_id = ${id}`)[0]!.n);
    expect(count).toBeGreaterThanOrEqual(2);
    await expect(versions.getByRole("row")).toHaveCount(count + 1);
    await expect(page.getByText(/^Comparar v\d+ con v\d+$/)).toBeVisible();
  });

  test("Anular asks for the reason and the comprobante keeps it", async ({ page }) => {
    await page.setViewportSize({ width: 1400, height: 900 });
    const id = await draftEntry("Pago para anular", true);
    await signIn(page, fixture);
    await page.goto(`/r/accounting.entry/${id}`);
    await bar(page).getByRole("button", { name: "Guardar y enviar a aprobación" }).click();
    await expect.poll(() => statusOf(id)).toBe("pending");
    await bar(page).getByRole("button", { name: "Anular" }).click();
    const confirm = bar(page).getByRole("button", { name: "Confirmar", exact: true });
    await expect(confirm).toBeDisabled();
    await bar(page).getByRole("textbox", { name: "Motivo" }).fill("Pago duplicado");
    await confirm.click();
    await expect.poll(() => statusOf(id)).toBe("voided");
    const [row] = await fixture.sql<{ void_reason: string }[]>`select void_reason from accounting.entries where id = ${id}`;
    expect(row!.void_reason).toBe("Pago duplicado");
    await expect(page.locator(".erp-record__header").getByText("Anulado", { exact: true })).toBeVisible();
  });

  test("below 768 px Duplicar and Revertir move under Más ▾", async ({ page }) => {
    await page.setViewportSize({ width: 600, height: 900 });
    const id = await draftEntry("Pago para el móvil", false);
    await fixture.sql`update accounting.entries set status = 'posted', number = ${`NC-M-${Date.now()}`}, total_debit = 120000, total_credit = 120000, posted_at = now() where id = ${id}`;
    await signIn(page, fixture);
    await page.goto(`/r/accounting.entry/${id}`);
    await expect(bar(page).getByRole("button", { name: "Revertir" })).toBeHidden();
    await bar(page).getByRole("button", { name: /Más/ }).click();
    await expect(bar(page).getByRole("menuitem", { name: "Revertir" })).toBeVisible();
    await expect(bar(page).getByRole("menuitem", { name: "Duplicar" })).toBeVisible();
  });
});
