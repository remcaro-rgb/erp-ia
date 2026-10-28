import { randomUUID } from "node:crypto";
import { expect, test, type Browser, type Page } from "@playwright/test";
import { seedAuthUser, type AuthFixture } from "../test-support/auth-fixtures";

// Support tickets in a real browser (design §8): a reporter files a ticket from ⌘K and the context of the screen they
// came from travels with it; an agent of the same company answers (and leaves an internal note); the reporter sees the
// answer but not the note. The reporter and the agent are real Auth users with different roles in one company.

const COMMON = ["kernel.saved_view.list", "kernel.attachment.list", "kernel.custom_field.list"];
const REPORTER_PROCESSES = ["support.ticket.create", "support.ticket.consult", "support.ticket.reply", ...COMMON];
const AGENT_PROCESSES = ["support.ticket.consult", "support.ticket.reply", "support.ticket.close", ...COMMON];

async function signIn(page: Page, email: string, password: string) {
  await page.goto("/login");
  await page.getByLabel("Correo").fill(email);
  await page.getByLabel("Contraseña", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Entrar" }).click();
  await expect(page).toHaveURL(/\/$/);
}

async function signedInPage(browser: Browser, email: string, password: string): Promise<Page> {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await signIn(page, email, password);
  return page;
}

test.describe("support tickets", () => {
  let reporter: AuthFixture;
  let companyId: string;
  const agent = { email: `agent-${randomUUID().slice(0, 8)}@test.local`, password: `pw-${randomUUID()}`, userId: "", roleId: "" };

  test.beforeAll(async () => {
    reporter = await seedAuthUser({ role: "member" });
    companyId = reporter.companyIds[0]!;
    const { sql, admin } = reporter;
    await sql`insert into kernel.tenant_entitlements(tenant_id, key, source) values (${reporter.tenantId}, 'module:support', 'manual')`;
    const [reporterRole] = await sql<{ id: string }[]>`select id from kernel.roles where company_id = ${companyId}`;
    for (const process of REPORTER_PROCESSES) {
      await sql`insert into kernel.process_permissions(company_id, role_id, process_id) values (${companyId}, ${reporterRole!.id}, ${process})`;
    }
    // The agent: another user of the same company with a role that may answer and close.
    const [role] = await sql<{ id: string }[]>`insert into kernel.roles(company_id, name) values (${companyId}, 'support_agent') returning id`;
    agent.roleId = role!.id;
    for (const process of AGENT_PROCESSES) {
      await sql`insert into kernel.process_permissions(company_id, role_id, process_id) values (${companyId}, ${role!.id}, ${process})`;
    }
    const { data, error } = await admin.auth.admin.createUser({ email: agent.email, password: agent.password, email_confirm: true });
    if (error || !data.user) throw new Error(`could not create the agent: ${error?.message}`);
    agent.userId = data.user.id;
    await sql`insert into kernel.users(id, email, full_name) values (${agent.userId}, ${agent.email}, 'Agente de soporte')`;
    const [membership] = await sql<{ id: string }[]>`insert into kernel.memberships(user_id, company_id) values (${agent.userId}, ${companyId}) returning id`;
    await sql`insert into kernel.membership_roles(membership_id, role_id) values (${membership!.id}, ${role!.id})`;
  });

  test.afterAll(async () => {
    const { sql, admin } = reporter;
    await sql`delete from support.ticket_messages where company_id = ${companyId}`;
    await sql`delete from support.tickets where company_id = ${companyId}`;
    await sql`delete from core.entity_sequences where company_id = ${companyId}`;
    await sql`delete from kernel.saved_views where company_id = ${companyId}`;
    await sql`delete from kernel.outbox where company_id = ${companyId}`;
    await sql`delete from kernel.membership_roles where membership_id in (select id from kernel.memberships where user_id = ${agent.userId})`;
    await sql`delete from kernel.memberships where user_id = ${agent.userId}`;
    await sql`delete from kernel.process_permissions where company_id = ${companyId}`;
    await sql`delete from kernel.tenant_entitlements where tenant_id = ${reporter.tenantId}`;
    await sql`delete from kernel.users where id = ${agent.userId}`;
    await admin.auth.admin.deleteUser(agent.userId);
    await reporter.cleanup();
  });

  test("files a ticket with the captured context, an agent answers, the reporter sees the answer", async ({ browser }) => {
    // --- The reporter selects text on Inicio and files a ticket from ⌘K; the context is the screen they came from.
    const mine = await signedInPage(browser, reporter.email, reporter.password);
    const heading = mine.getByTestId("home").getByRole("heading", { name: "Inicio" });
    await heading.evaluate((element) => {
      const range = document.createRange();
      range.selectNodeContents(element);
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
    });
    // The browser reports a selection change a moment after it happens; opening ⌘K moves focus and clears it.
    await expect.poll(() => mine.evaluate(() => window.getSelection()?.toString() ?? "")).toBe("Inicio");
    await mine.waitForTimeout(300);
    // A console error the page raised travels with the ticket, with the secret in it redacted.
    await mine.evaluate(() => console.error("falló la llamada token=abc123 para Ana"));
    await mine.keyboard.press("ControlOrMeta+k");
    await mine.getByRole("combobox").fill("ticket");
    await mine.getByRole("option", { name: /Crear ticket de soporte/ }).click();

    const dialog = mine.getByRole("dialog", { name: "Nuevo ticket de soporte" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText("Pantalla", { exact: true })).toBeVisible();
    await expect(dialog.locator("dd.erp-mono").first()).toHaveText("/");
    await expect(dialog.getByRole("list", { name: "Errores de consola" }).getByText("falló la llamada token=[redacted] para Ana")).toBeVisible();
    await dialog.getByLabel("Tipo").selectOption("bug");
    await dialog.getByLabel("Título").fill("El botón Salir no responde");
    await dialog.getByLabel("Cuéntanos qué pasó o qué necesitas").fill("Hago clic en Salir y no pasa nada.");
    await dialog.getByRole("button", { name: "Enviar ticket" }).click();

    // The ticket opens in its sheet with the record frame tabs.
    const sheet = mine.getByRole("dialog").filter({ hasText: "El botón Salir no responde" });
    await expect(sheet.getByRole("tab", { name: /Datos$/ })).toBeVisible();
    for (const tab of [/Mensajes/, /Datos adicionales/, /Archivos/]) await expect(sheet.getByRole("tab", { name: tab })).toBeVisible();
    await expect(sheet.getByText("Hago clic en Salir y no pasa nada.")).toBeVisible();

    const [ticket] = await reporter.sql<{ id: string; context: { route: string; selection: string; consoleErrors: string[]; lastAuditIds: string[] }; status: string; reporter_user_id: string }[]>`
      select id, context, status, reporter_user_id from support.tickets where company_id = ${companyId} and title = 'El botón Salir no responde'`;
    expect(ticket).toBeDefined();
    expect(ticket!.status).toBe("open");
    expect(ticket!.reporter_user_id).toBe(reporter.userId);
    expect(ticket!.context.route).toBe("/");
    expect(ticket!.context.selection).toContain("Inicio");
    expect(ticket!.context.lastAuditIds).toEqual([]);
    expect(ticket!.context.consoleErrors).toContain("falló la llamada token=[redacted] para Ana");
    expect(JSON.stringify(ticket!.context)).not.toContain("abc123");
    await mine.keyboard.press("Escape");

    // --- The agent sees every ticket of the company, answers, and leaves an internal note.
    const theirs = await signedInPage(browser, agent.email, agent.password);
    await theirs.goto("/support");
    const grid = theirs.getByRole("region", { name: "Soporte" });
    await expect(grid.getByRole("heading", { name: "Soporte" })).toBeVisible();
    await expect(grid.getByRole("button", { name: "Nuevo ticket" })).toHaveCount(0);
    const row = grid.locator("tbody tr.erp-row-link").filter({ hasText: "El botón Salir no responde" });
    await expect(row).toBeVisible();
    await expect(row).toContainText("Abierto");
    await row.click();

    const agentSheet = theirs.getByRole("dialog").filter({ hasText: "El botón Salir no responde" });
    await expect(agentSheet.getByText("Hago clic en Salir y no pasa nada.")).toBeVisible();
    await agentSheet.getByRole("tab", { name: /Mensajes/ }).click();
    await agentSheet.getByLabel("Tu respuesta").fill("Gracias por avisar, ya lo corregimos.");
    await agentSheet.getByRole("button", { name: "Responder" }).click();
    const messages = agentSheet.getByRole("list", { name: "Mensajes" });
    await expect(messages.getByText("Gracias por avisar, ya lo corregimos.")).toBeVisible();

    await agentSheet.getByLabel("Tu respuesta").fill("Nota: fue el cierre de sesión del proxy.");
    await agentSheet.getByLabel(/Nota interna/).check();
    await agentSheet.getByRole("button", { name: "Responder" }).click();
    await expect(messages.locator("[data-internal='true']")).toContainText("Nota: fue el cierre de sesión del proxy.");
    await expect.poll(async () => (await reporter.sql`select status from support.tickets where id = ${ticket!.id}`)[0]!.status).toBe("answered");

    // --- The reporter reloads: the answer is there, the internal note is not, and the grid says "Respondido".
    await mine.goto("/support");
    const myGrid = mine.getByRole("region", { name: "Soporte" });
    const myRow = myGrid.locator("tbody tr.erp-row-link").filter({ hasText: "El botón Salir no responde" });
    await expect(myRow).toContainText("Respondido");
    await myRow.click();
    const mySheet = mine.getByRole("dialog").filter({ hasText: "El botón Salir no responde" });
    await mySheet.getByRole("tab", { name: /Mensajes/ }).click();
    const myMessages = mySheet.getByRole("list", { name: "Mensajes" });
    await expect(myMessages.getByText("Gracias por avisar, ya lo corregimos.")).toBeVisible();
    await expect(myMessages.getByText("Soporte")).toBeVisible();
    await expect(mySheet.getByText("fue el cierre de sesión del proxy")).toHaveCount(0);
    await expect(mySheet.getByLabel(/Nota interna/)).toHaveCount(0);
    await expect(mySheet.getByRole("button", { name: "Cerrar ticket" })).toHaveCount(0);

    // The frame's link opens the same ticket as a full page (rule 21), for the reporter and not for another reporter's.
    await expect(mySheet.getByRole("link", { name: /Abrir en una pestaña nueva/ })).toHaveAttribute("href", `/r/support.ticket/${ticket!.id}`);
    await mine.goto(`/r/support.ticket/${ticket!.id}`);
    await expect(mine.getByRole("heading", { name: "El botón Salir no responde" })).toBeVisible();
    await expect(mine.getByRole("tab", { name: /Mensajes/ })).toBeVisible();
    await mine.goto("/support");

    // The reporter only ever sees their own tickets: the agent's grid and theirs differ by owner, not by company.
    await reporter.sql`insert into support.tickets(company_id, reporter_user_id, kind, title, body) values (${companyId}, ${agent.userId}, 'question', 'Ticket ajeno', 'No es del solicitante')`;
    await mine.reload();
    await expect(myGrid.locator("tbody tr.erp-row-link").filter({ hasText: "El botón Salir no responde" })).toBeVisible();
    await expect(myGrid.getByText("Ticket ajeno")).toHaveCount(0);
    await theirs.reload();
    await expect(theirs.getByRole("region", { name: "Soporte" }).getByText("Ticket ajeno")).toBeVisible();

    // The agent closes the answered ticket; the reporter can no longer reply.
    await theirs.getByRole("region", { name: "Soporte" }).locator("tbody tr.erp-row-link").filter({ hasText: "El botón Salir no responde" }).click();
    await theirs.getByRole("dialog").getByRole("button", { name: "Cerrar ticket" }).click();
    await expect.poll(async () => (await reporter.sql`select status from support.tickets where id = ${ticket!.id}`)[0]!.status).toBe("closed");
    await mine.reload();
    await myGrid.locator("tbody tr.erp-row-link").filter({ hasText: "El botón Salir no responde" }).click();
    const closedSheet = mine.getByRole("dialog").filter({ hasText: "El botón Salir no responde" });
    await closedSheet.getByRole("tab", { name: /Mensajes/ }).click();
    await expect(closedSheet.getByText("Este ticket está cerrado y no recibe más respuestas.")).toBeVisible();
    await expect(closedSheet.getByRole("button", { name: "Responder" })).toHaveCount(0);

    await mine.context().close();
    await theirs.context().close();
  });
});
