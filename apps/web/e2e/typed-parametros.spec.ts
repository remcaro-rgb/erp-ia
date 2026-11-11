import { randomUUID } from "node:crypto";
import type { Page } from "@playwright/test";
import { expect, test } from "../test-support/streamed";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { pdfText } from "../../../packages/kernel/src/templates/__tests__/pdf-text";
import { enrolTotp, seedAuthUser, totpCode, type AuthFixture } from "../test-support/auth-fixtures";

// Parámetros of the entity types (Task 16; entity types spec §5.4, §6, §7, §9.2; approved prototype «Configuración de tipos»,
// «Destinatarios por estado», «Plantillas PDF», «Acceso al menú»): the company admin turns on approval for Terceros and a new party lands
// Pendiente de Aprobación; a recipient list for Aprobado makes Aprobar e-mail the party's PDF (the SMTP sink of the local stack); an edited
// template's fixed text shows in Imprimir; a grid's Imprimir downloads the list PDF; a member who is not the admin cannot open Parámetros.
// The state e-mail is delivered by the kernel's consumer of the outbox event, run here as the dispatch workflow's step runs it (the app
// under test has no mail transport of its own).

const MAILPIT = (process.env.TEST_MAILPIT_URL ?? "http://127.0.0.1:55324").replace(/\/+$/, "");
const DELIVER = join(__dirname, "..", "test-support", "deliver-state-mail.mts");

const ADMIN_PROCESSES = [
  "kernel.entity_type_settings.update",
  "kernel.state_recipients.update",
  "kernel.menu_access.set",
  "kernel.doc_template.save",
  "kernel.doc_template.set_default",
  "kernel.doc_template.print",
  "kernel.export.run",
  "kernel.attachment.add",
  "kernel.attachment.list",
  "kernel.custom_field.list",
  "kernel.admin.company.update",
  "core.party.consult",
  "core.party.create",
  "core.party.update",
  "core.party.save",
  "core.party.submit",
  "core.party.approve",
  "core.party.reject",
  "core.party.delete",
];

async function signInWithCode(page: Page, user: { email: string; password: string }, secret: string) {
  await page.goto("/login");
  await page.getByLabel("Correo").fill(user.email);
  await page.getByLabel("Contraseña", { exact: true }).fill(user.password);
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

/** Answers the step-up prompt the sensitive process raised. */
async function confirmStepUp(page: Page, secret: string) {
  const code = page.getByLabel("Código de 6 dígitos");
  await expect(code).toBeVisible();
  await code.fill(totpCode(secret));
}

/** Opens a block of the template editor (its header toggles it). */
async function openBlock(page: Page, name: RegExp) {
  const head = page.getByRole("button", { name });
  if ((await head.getAttribute("aria-expanded")) !== "true") await head.click();
}

const bar = (page: Page) => page.getByRole("group", { name: "Acciones del registro" });

/** The PDF a print answered: the export job's signed link, fetched. */
async function printedPdf(page: Page, click: () => Promise<void>): Promise<Uint8Array> {
  const job = page.waitForResponse((r) => /\/api\/export\/[0-9a-f-]{36}$/.test(r.url()));
  await click();
  const answer = (await (await job).json()) as { url?: string; fileName?: string };
  expect(answer.url).toBeTruthy();
  expect(answer.fileName).toMatch(/\.pdf$/);
  const response = await fetch(answer.url!);
  expect(response.ok).toBe(true);
  return new Uint8Array(await response.arrayBuffer());
}

test.describe("typed entities: Parámetros", () => {
  // One story: the party the first test creates is approved, printed and listed by the next ones.
  test.describe.configure({ mode: "serial" });
  let fixture: AuthFixture;
  let secret: string;
  let companyId: string;
  const member = { email: `miembro-${randomUUID().slice(0, 8)}@test.local`, password: `pw-${randomUUID()}`, id: "" };
  const recipient = `aprobados-${randomUUID().slice(0, 8)}@test.local`;
  let partyId = "";

  test.beforeAll(async () => {
    fixture = await seedAuthUser({ role: "admin" });
    secret = await enrolTotp(fixture);
    companyId = fixture.companyIds[0]!;
    const { sql } = fixture;
    for (const key of ["module:core"]) await sql`insert into kernel.tenant_entitlements(tenant_id, key, source) values (${fixture.tenantId}, ${key}, 'manual')`;
    const [adminRole] = await sql<{ id: string }[]>`select id from kernel.roles where company_id = ${companyId} and name = 'admin'`;
    for (const process of ADMIN_PROCESSES) await sql`insert into kernel.process_permissions(company_id, role_id, process_id) values (${companyId}, ${adminRole!.id}, ${process})`;
    // A member of the company who may work with Terceros but is not the admin.
    const { data, error } = await fixture.admin.auth.admin.createUser({ email: member.email, password: member.password, email_confirm: true });
    if (error || !data.user) throw new Error(`could not create the member: ${error?.message}`);
    member.id = data.user.id;
    await sql`insert into kernel.users(id, email, full_name) values (${member.id}, ${member.email}, 'Miembro Parámetros')`;
    const [plain] = await sql<{ id: string }[]>`insert into kernel.roles(company_id, name) values (${companyId}, 'ventas') returning id`;
    const [membership] = await sql<{ id: string }[]>`insert into kernel.memberships(user_id, company_id) values (${member.id}, ${companyId}) returning id`;
    await sql`insert into kernel.membership_roles(membership_id, role_id) values (${membership!.id}, ${plain!.id})`;
    for (const process of ["core.party.consult", "core.party.create", "core.party.save"]) {
      await sql`insert into kernel.process_permissions(company_id, role_id, process_id) values (${companyId}, ${plain!.id}, ${process})`;
    }
  });

  test.afterAll(async () => {
    const { sql } = fixture;
    await sql.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      for (const table of ["record_snapshots", "export_jobs", "mail_log", "mail_claims", "doc_templates", "attachments", "entity_type_settings", "state_recipients", "menu_access", "step_up_verifications", "outbox"]) {
        await tx.unsafe(`delete from kernel.${table} where company_id = $1`, [companyId]);
      }
      await tx`delete from core.parties where company_id = ${companyId}`;
      await tx`delete from core.entity_sequences where company_id = ${companyId}`;
    });
    await sql`delete from kernel.membership_roles where membership_id in (select id from kernel.memberships where user_id = ${member.id})`;
    await sql`delete from kernel.memberships where user_id = ${member.id}`;
    await sql`delete from kernel.user_prefs where user_id = ${member.id}`;
    await sql`delete from kernel.process_permissions where company_id = ${companyId}`;
    await sql`delete from kernel.roles where company_id = ${companyId} and name = 'ventas'`;
    await sql`delete from kernel.tenant_entitlements where tenant_id = ${fixture.tenantId}`;
    await sql`delete from kernel.users where id = ${member.id}`;
    await fixture.admin.auth.admin.deleteUser(member.id);
    await fixture.cleanup();
  });

  test("Configuración de tipos: approval on for Terceros, a new party lands Pendiente de Aprobación", async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await signInWithCode(page, fixture, secret);

    // The module bar's Parámetros lists the kernel's screens for the module's maestros and documentos.
    const menu = page.getByRole("navigation", { name: "Menú del módulo" });
    await page.goto("/parties");
    await menu.getByRole("button", { name: "Parámetros", exact: true }).click();
    const items = page.getByRole("menu", { name: "Parámetros" });
    await expect(items.getByRole("menuitem", { name: "Configuración de tipos" })).toBeVisible();
    await expect(items.getByRole("menuitem", { name: "Destinatarios por estado" })).toBeVisible();
    await expect(items.getByRole("menuitem", { name: "Plantillas PDF" })).toBeVisible();
    await items.getByRole("menuitem", { name: "Configuración de tipos" }).click();
    await expect(page).toHaveURL(/\/core\/parametros\/tipos$/);
    await expect(page.getByRole("heading", { name: "Configuración de tipos" })).toBeVisible();
    await expect(page.getByText("cambiarlos aquí no altera los registros que ya existen")).toBeVisible();

    const toggle = page.getByRole("switch", { name: "Requiere aprobación · Tercero" });
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    await toggle.click();
    await page.getByRole("button", { name: "Guardar", exact: true }).click();
    await confirmStepUp(page, secret);
    await expect(page.getByRole("status").filter({ hasText: "Guardado" })).toBeVisible();
    const [setting] = await fixture.sql<{ requires_approval: boolean }[]>`select requires_approval from kernel.entity_type_settings where company_id = ${companyId} and entity = 'core.party'`;
    expect(setting?.requires_approval).toBe(true);

    // A new party: «Guardar y enviar a aprobación» (D15) lands it Pendiente de Aprobación.
    await page.goto("/r/core.party/new");
    await page.getByLabel(/^Número/).fill("860002964");
    await page.getByLabel(/^Razón social/).fill("Distribuidora Andina S.A.S.");
    await page.getByLabel(/^Correo de recepción de facturas de venta/).fill("fe@andina.co");
    await bar(page).getByRole("button", { name: "Guardar y enviar a aprobación" }).click();
    await expect(page).toHaveURL(/\/r\/core\.party\/[0-9a-f-]{36}$/);
    await expect(page.locator(".erp-record__header").filter({ visible: true }).getByText("Pendiente de Aprobación", { exact: true })).toBeVisible();
    const [party] = await fixture.sql<{ id: string; status: string; requires_approval: boolean }[]>`select id, status, requires_approval from core.parties where company_id = ${companyId} and document_number = '860002964'`;
    expect(party).toMatchObject({ status: "pending", requires_approval: true });
    partyId = party!.id;
  });

  test("Destinatarios por estado: a list for Aprobado e-mails the party's PDF when it is approved", async ({ page }) => {
    test.setTimeout(120_000);
    expect(partyId).not.toBe("");
    await page.setViewportSize({ width: 1440, height: 900 });
    await signInWithCode(page, fixture, secret);
    await page.goto("/core/parametros/destinatarios");
    await expect(page.getByRole("heading", { name: "Destinatarios por estado" })).toBeVisible();
    await page.getByLabel("Entidad").selectOption({ label: "Tercero (maestro)" });
    // A maestro has no Contabilizado / Anulado states.
    await expect(page.getByLabel("Agregar correo a Contabilizado")).toHaveCount(0);
    const input = page.getByLabel("Agregar correo a Aprobado");
    await input.fill("no-es-correo");
    await input.press("Enter");
    await expect(page.getByRole("alert").filter({ hasText: "Correo no válido" })).toBeVisible();
    await input.fill(recipient);
    await input.press("Enter");
    await expect(page.getByRole("button", { name: `Quitar ${recipient}` })).toBeVisible();
    await page.getByRole("button", { name: "Guardar", exact: true }).click();
    await confirmStepUp(page, secret);
    await expect(page.getByRole("status").filter({ hasText: "Guardado" })).toBeVisible();
    const [list] = await fixture.sql<{ emails: string[] }[]>`select emails from kernel.state_recipients where company_id = ${companyId} and entity = 'core.party' and status = 'approved'`;
    expect(list?.emails).toEqual([recipient]);

    // Aprobar: the party is Aprobado and its status event carries the mail.
    await page.goto(`/r/core.party/${partyId}`);
    await bar(page).getByRole("button", { name: "Aprobar", exact: true }).click();
    await expect(page.locator(".erp-record__header").filter({ visible: true }).getByText("Aprobado", { exact: true })).toBeVisible();
    const events = await fixture.sql<{ id: string }[]>`
      select id from kernel.outbox
      where company_id = ${companyId} and event = 'core.party.status_changed' and payload->>'id' = ${partyId} and payload->>'to' = 'approved'`;
    expect(events).toHaveLength(1);

    // The dispatch step: the kernel's consumer of the event, with the stack's SMTP sink as the transport (a tsx child: the PDF renderer
    // is an ES module this loader cannot import).
    execFileSync("pnpm", ["exec", "tsx", DELIVER, events[0]!.id], { cwd: join(__dirname, ".."), stdio: "pipe", env: process.env, timeout: 90_000 });

    await expect
      .poll(async () => ((await (await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`addressed:"${recipient}"`)}`)).json()) as { messages_count: number }).messages_count, { timeout: 15_000 })
      .toBe(1);
    const [logged] = await fixture.sql<{ status: string; recipients: string[] }[]>`select status, recipients from kernel.mail_log where company_id = ${companyId} and record_id = ${partyId}`;
    expect(logged).toMatchObject({ status: "sent", recipients: [recipient] });
  });

  test("Plantillas PDF: the edited fixed text prints; a template saved meanwhile is refused, not overwritten", async ({ page }) => {
    test.setTimeout(120_000);
    expect(partyId).not.toBe("");
    await page.setViewportSize({ width: 1440, height: 900 });
    await signInWithCode(page, fixture, secret);
    await page.goto("/core/parametros/plantillas");
    await expect(page.getByRole("heading", { name: "Plantillas PDF" })).toBeVisible();

    // A new record template of Tercero starts from the built-in one; a fixed text block is added and saved (version 1).
    await page.getByRole("button", { name: "Nueva plantilla" }).click();
    await page.getByLabel("Nombre", { exact: true }).fill("Ficha e2e");
    await page.getByLabel("Entidad", { exact: true }).selectOption({ label: "Tercero (maestro)" });
    await page.getByLabel("Alcance", { exact: true }).selectOption({ label: "Un registro" });
    await page.getByLabel("Tipo de bloque").selectOption({ label: "Texto fijo" });
    await page.getByRole("button", { name: "Agregar bloque" }).click();
    await page.getByLabel("Texto", { exact: true }).fill("Certificado e2e de tercero");
    await expect(page.getByTestId("template-preview").getByText("Certificado e2e de tercero")).toBeVisible();
    await page.getByRole("button", { name: "Guardar", exact: true }).click();
    await confirmStepUp(page, secret);
    await expect(page.getByRole("status").filter({ hasText: "Guardado" })).toBeVisible();
    await expect(page.getByText("v1", { exact: true }).first()).toBeVisible();

    // It becomes the default record template of Tercero.
    await page.getByRole("switch", { name: /^Predeterminada/ }).click();
    await confirmStepUp(page, secret);
    await expect.poll(async () => (await fixture.sql<{ is_default: boolean }[]>`select is_default from kernel.doc_templates where company_id = ${companyId} and name = 'Ficha e2e'`)[0]?.is_default).toBe(true);

    // The fixed text is edited: version 2.
    await openBlock(page, /Texto fijo · Certificado e2e de tercero/);
    await page.getByLabel("Texto", { exact: true }).fill("Texto editado e2e");
    await page.getByRole("button", { name: "Guardar", exact: true }).click();
    await confirmStepUp(page, secret);
    await expect(page.getByRole("status").filter({ hasText: "Guardado" })).toBeVisible();
    const [saved] = await fixture.sql<{ id: string; version: number }[]>`select id, version from kernel.doc_templates where company_id = ${companyId} and name = 'Ficha e2e'`;
    expect(saved!.version).toBe(2);

    // Imprimir on the party prints the edited text with the default template.
    await page.goto(`/r/core.party/${partyId}`);
    const pdf = await printedPdf(page, () => bar(page).getByRole("button", { name: "Imprimir" }).click());
    expect(pdfText(pdf)).toContain("Texto editado e2e");
    expect(pdfText(pdf)).not.toContain("Certificado e2e de tercero");

    // Another admin saves the template meanwhile: this editor's save is refused (expectedVersion), and it offers to reload.
    await page.goto("/core/parametros/plantillas");
    await page.getByRole("button", { name: "Ficha e2e" }).click();
    await openBlock(page, /Texto fijo · Texto editado e2e/);
    await fixture.sql`update kernel.doc_templates set blocks = blocks || jsonb_build_array(jsonb_build_object('kind', 'text', 'x', 40, 'y', 40, 'w', 120, 'value', 'Otro admin')) where id = ${saved!.id}`;
    await page.getByLabel("Texto", { exact: true }).fill("No debe guardarse");
    await page.getByRole("button", { name: "Guardar", exact: true }).click();
    await confirmStepUp(page, secret);
    await expect(page.getByRole("alert").filter({ hasText: "Otra persona guardó esta plantilla" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Recargar" })).toBeVisible();
    const [kept] = await fixture.sql<{ blocks: { value?: string }[] }[]>`select blocks from kernel.doc_templates where id = ${saved!.id}`;
    expect(kept!.blocks.some((b) => b.value === "No debe guardarse")).toBe(false);
  });

  test("a grid's Imprimir downloads the list PDF", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await signInWithCode(page, fixture, secret);
    await page.goto("/parties");
    const grid = page.getByRole("region", { name: "Terceros" });
    await expect(grid.getByText("Distribuidora Andina S.A.S.")).toBeVisible();
    const pdf = await printedPdf(page, () => grid.getByRole("button", { name: "Imprimir" }).click());
    expect(Buffer.from(pdf.subarray(0, 5)).toString("latin1")).toBe("%PDF-");
    // The list's rows (a long name wraps inside its cell).
    expect(pdfText(pdf)).toContain("860002964");
    expect(pdfText(pdf)).toContain("Distribuidora");
    const [job] = await fixture.sql<{ entity: string; format: string; state: { scope?: string } }[]>`select entity, format, state from kernel.export_jobs where company_id = ${companyId} order by created_at desc limit 1`;
    expect(job).toMatchObject({ entity: "core.party", format: "pdf" });
    expect(job!.state.scope).toBe("list");
  });

  test("Acceso al menú lists the items by name, never by their technical key", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await signInWithCode(page, fixture, secret);
    await page.goto("/admin/menu-access");
    await expect(page.getByRole("heading", { name: "Acceso al menú" })).toBeVisible();
    const tree = page.getByRole("navigation", { name: "Opciones del menú" });
    await tree.getByRole("button", { name: "Terceros", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Terceros", level: 3 })).toBeVisible();
    await expect(page.getByText("Sin reglas: lo ve quien tiene permiso por su rol.")).toBeVisible();
    await expect(page.getByText("core.parties")).toHaveCount(0);
    await expect(page.getByText(/core\.[a-z_]+/)).toHaveCount(0);

    // A rule hides Productos from the role «ventas»: one audited run replaces the item's rules.
    await tree.getByRole("button", { name: "Productos", exact: true }).click();
    await page.getByLabel("Nueva regla").selectOption({ label: "Rol · ventas" });
    await page.getByRole("button", { name: "Agregar regla" }).click();
    await page.getByRole("switch", { name: "Permitido · ventas" }).click();
    await page.getByRole("button", { name: "Guardar", exact: true }).click();
    await confirmStepUp(page, secret);
    await expect(page.getByRole("status").filter({ hasText: "Guardado" })).toBeVisible();
    await expect(tree.getByRole("button", { name: /Productos.*1 regla/ })).toBeVisible();
    const rules = await fixture.sql<{ nav_key: string; allowed: boolean }[]>`select nav_key, allowed from kernel.menu_access where company_id = ${companyId}`;
    expect(rules).toEqual([{ nav_key: "core.products", allowed: false }]);
  });

  test("a member who is not the admin cannot open Parámetros", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await signIn(page, member);
    await page.goto("/parties");
    const menu = page.getByRole("navigation", { name: "Menú del módulo" });
    await menu.getByRole("button", { name: "Parámetros", exact: true }).click();
    await expect(page.getByRole("menu", { name: "Parámetros" }).getByRole("menuitem", { name: "Configuración de tipos" })).toHaveCount(0);
    await page.keyboard.press("Escape");
    for (const path of ["/core/parametros/tipos", "/core/parametros/destinatarios", "/core/parametros/plantillas", "/admin/menu-access"]) {
      await page.goto(path);
      await expect(page.getByText("No tienes permiso.")).toBeVisible();
      await expect(page.getByRole("button", { name: "Guardar", exact: true })).toHaveCount(0);
    }
  });
});
