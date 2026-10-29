import { randomBytes, randomUUID } from "node:crypto";
import type { Page } from "@playwright/test";
import { expect, test } from "../test-support/streamed";
import { enrolTotp, seedAuthUser, totpCode, type AuthFixture } from "../test-support/auth-fixtures";

// The assistant drawer in a real browser (design §7.1, §19a, rules 15, 17): 400 px, the conversation, the result table
// with "Abrir como grid", the confirmation card and the step-up code in the chat.
//
// Not stubbed: sign-in, the stored conversation (GET /api/agent/conversation), the confirmation route
// (POST /api/agent/confirm, which runs the real process as the user with origin `agent`) and the step-up exchange
// (POST /api/auth/step-up with a real TOTP code). Stubbed: POST /api/agent/turn, through Playwright route interception,
// because a turn needs a model and the app server cannot have the agent's mock model injected from here (the turn
// itself, with the mock model and the stream, is covered by packages/agent's workflow tests). The stub answers with
// the UI message chunks the real route streams, carrying the ids of cards seeded in the database.

const PROCESSES = ["core.party.consult", "core.party.create", "kernel.saved_view.list", "kernel.data.query"];
const SCREENSHOTS = "e2e/__screenshots__";

async function signIn(page: Page, fixture: AuthFixture, secret: string) {
  await page.goto("/login");
  await page.getByLabel("Correo").fill(fixture.email);
  await page.getByLabel("Contraseña", { exact: true }).fill(fixture.password);
  await page.getByRole("button", { name: "Entrar" }).click();
  await expect(page).toHaveURL(/\/mfa\/verify$/);
  await page.getByLabel("Dígito 1").fill(totpCode(secret));
  await expect(page).toHaveURL(/\/$/);
}

const sse = (chunks: unknown[]) => [...chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`), "data: [DONE]\n\n"].join("");

test.describe("assistant drawer", () => {
  let fixture: AuthFixture;
  let secret: string;
  let companyId: string;

  const party = (documentNumber: string, legalName: string) => ({
    kind: ["customer"],
    personType: "1",
    documentType: "31",
    documentNumber,
    legalName,
    taxResponsibilities: ["R-99-PN"],
    taxScheme: "ZZ",
    countryCode: "CO",
  });
  const preview = (legalName: string, documentNumber: string, stepUp: boolean) => ({
    title: "Crea un tercero",
    effects: [
      { label: "Razón social", value: legalName },
      { label: "Número de documento", value: documentNumber },
    ],
    permission: "core.party.create",
    stepUp,
  });
  /** A conversation of the user with one pending card for core.party.create, as the assistant leaves them. */
  async function seedCard(documentNumber: string, legalName: string, stepUp: boolean) {
    const { sql } = fixture;
    const [conversation] = await sql<{ id: string }[]>`
      insert into kernel.agent_conversations(company_id, user_id, title) values (${companyId}, ${fixture.userId}, 'crea un tercero') returning id`;
    const [card] = await sql<{ id: string }[]>`
      insert into kernel.agent_confirmations(company_id, conversation_id, user_id, process_id, input, preview, token)
      values (${companyId}, ${conversation!.id}, ${fixture.userId}, 'core.party.create', ${sql.json(party(documentNumber, legalName) as never)},
              ${sql.json(preview(legalName, documentNumber, stepUp) as never)}, ${randomBytes(32).toString("base64url")})
      returning id`;
    return { conversationId: conversation!.id, cardId: card!.id };
  }
  const parties = async (documentNumber: string) =>
    (await fixture.sql<{ n: number }[]>`select count(*)::int as n from core.parties where company_id = ${companyId} and document_number = ${documentNumber}`)[0]!.n;

  test.beforeAll(async () => {
    fixture = await seedAuthUser({ role: "admin" });
    secret = await enrolTotp(fixture);
    companyId = fixture.companyIds[0]!;
    const { sql } = fixture;
    await sql`insert into kernel.tenant_entitlements(tenant_id, key, source) values (${fixture.tenantId}, 'module:core', 'manual')`;
    const [role] = await sql<{ id: string }[]>`select id from kernel.roles where company_id = ${companyId}`;
    for (const process of PROCESSES) {
      await sql`insert into kernel.process_permissions(company_id, role_id, process_id) values (${companyId}, ${role!.id}, ${process})`;
    }
  });

  test.afterAll(async () => {
    const { sql } = fixture;
    await sql.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      await tx`delete from core.parties where company_id = ${companyId}`;
    });
    await sql`delete from core.entity_sequences where company_id = ${companyId}`;
    await sql`delete from kernel.agent_conversations where company_id = ${companyId}`;
    await sql`delete from kernel.sensitive_processes where company_id = ${companyId}`;
    await sql`delete from kernel.process_idempotency where company_id = ${companyId}`;
    await sql`delete from kernel.outbox where company_id = ${companyId}`;
    await sql`delete from kernel.process_permissions where company_id = ${companyId}`;
    await sql`delete from kernel.tenant_entitlements where tenant_id = ${fixture.tenantId}`;
    await fixture.cleanup();
  });

  test("a reloaded conversation shows its pending card, which confirms by id and runs the process as the assistant", async ({ page }) => {
    test.setTimeout(120_000);
    const { conversationId, cardId } = await seedCard("900373115", "Café del Norte S.A.S.", false);
    await fixture.sql`
      insert into kernel.agent_messages(company_id, conversation_id, role, parts) values
        (${companyId}, ${conversationId}, 'user', ${fixture.sql.json([{ type: "text", text: "crea el cliente Café del Norte" }])}),
        (${companyId}, ${conversationId}, 'assistant', ${fixture.sql.json([
          { role: "assistant", content: [{ type: "text", text: "Te preparo la tarjeta." }, { type: "tool-call", toolCallId: "c1", toolName: "core__party__create", input: {} }] },
          { role: "tool", content: [{ type: "tool-result", toolCallId: "c1", toolName: "core__party__create", output: { type: "json", value: { confirmationRequired: true, cardId, preview: preview("Café del Norte S.A.S.", "900373115", false) } } }] },
        ] as never)})`;

    await page.setViewportSize({ width: 1440, height: 900 });
    await signIn(page, fixture, secret);
    const drawer = page.getByRole("complementary", { name: "Asistente" });
    await expect(drawer).toBeVisible();
    expect((await drawer.boundingBox())!.width).toBe(400);
    await expect(drawer.getByText("crea el cliente Café del Norte")).toBeVisible();

    const card = drawer.getByRole("article", { name: "Crea un tercero" });
    await expect(card.getByText("Café del Norte S.A.S.")).toBeVisible();
    await expect(card.getByText(/core\.party\.create · sin verificación/)).toBeVisible();
    await page.screenshot({ path: `${SCREENSHOTS}/assistant-confirm-card.png` });
    await card.getByRole("button", { name: "Confirmar" }).click();
    await expect(card.getByText("Listo · la acción se ejecutó")).toBeVisible();
    expect(await parties("900373115")).toBe(1);
    const [audit] = await fixture.sql`select origin, conversation_id from kernel.audit_log where process_id = 'core.party.create' and company_id = ${companyId} and action = 'insert' order by occurred_at desc limit 1`;
    expect(audit).toMatchObject({ origin: "agent", conversation_id: conversationId });

    // Reload: the decided card stays in the history with its final state, and offers no buttons.
    await page.reload();
    const again = page.getByRole("complementary", { name: "Asistente" }).getByRole("article", { name: "Crea un tercero" });
    await expect(again.getByText("Listo · la acción se ejecutó")).toBeVisible();
    await expect(again.getByRole("button", { name: "Confirmar" })).toHaveCount(0);
  });

  test("a question streams an answer and a result table that opens as a grid; a sensitive card asks for the code in the chat", async ({ page }) => {
    test.setTimeout(120_000);
    // A fresh user's latest conversation would be the one above: start from a new one.
    const { conversationId, cardId } = await seedCard("800197268", "Tostadora del Valle S.A.S.", true);
    await fixture.sql`insert into kernel.sensitive_processes(company_id, process_id, mode) values (${companyId}, 'core.party.create', 'self_2fa') on conflict do nothing`;
    await fixture.sql`update kernel.agent_conversations set updated_at = now() + interval '1 hour' where id = ${conversationId}`;
    await fixture.sql`delete from kernel.agent_messages where conversation_id = ${conversationId}`;

    const turns: { text: string; screen?: { route?: string } }[] = [];
    await page.route("**/api/agent/turn", async (route) => {
      const body = route.request().postDataJSON() as { text: string; screen?: { route?: string }; conversationId?: string };
      turns.push(body);
      const first = turns.length === 1;
      const messageId = randomUUID();
      const chunks = first
        ? [
            { type: "start", messageId },
            { type: "tool-input-available", toolCallId: "q1", toolName: "kernel__data__query", input: { entity: "core.party", filters: [{ field: "legal_name", op: "contains", value: "Café 50%" }], limit: 20 } },
            {
              type: "tool-output-available",
              toolCallId: "q1",
              output: { entity: "core.party", rows: [{ id: randomUUID(), legal_name: "Café del Norte S.A.S.", balance: "1234567.0000" }], total: 1, page: 1, truncated: false },
            },
            { type: "text-start", id: "t" },
            { type: "text-delta", id: "t", delta: "Encontré **1** tercero." },
            { type: "text-end", id: "t" },
            { type: "finish" },
          ]
        : [
            { type: "start", messageId },
            { type: "tool-input-available", toolCallId: "w1", toolName: "core__party__create", input: {} },
            { type: "tool-output-available", toolCallId: "w1", output: { confirmationRequired: true, cardId, preview: preview("Tostadora del Valle S.A.S.", "800197268", true) } },
            { type: "finish" },
          ];
      await route.fulfill({
        status: 200,
        headers: { "content-type": "text/event-stream", "x-workflow-run-id": "wrun_e2e", "x-conversation-id": conversationId, "cache-control": "no-cache" },
        body: sse(chunks),
      });
    });

    await page.setViewportSize({ width: 1440, height: 900 });
    await signIn(page, fixture, secret);
    await page.goto("/parties");
    const drawer = page.getByRole("complementary", { name: "Asistente" });
    await expect(drawer.getByLabel("Escribe")).toBeEnabled();

    await drawer.getByLabel("Escribe").fill("¿qué terceros se llaman Café?");
    await drawer.getByLabel("Escribe").press("Enter");
    await expect(drawer.getByText("Encontré")).toBeVisible();
    expect(turns[0]).toMatchObject({ text: "¿qué terceros se llaman Café?", screen: { route: "/parties" } });
    const table = drawer.getByRole("table");
    await expect(table.getByText("Café del Norte S.A.S.")).toBeVisible();
    await expect(table.getByText("$ 1.234.567,00")).toBeVisible();
    await expect(drawer.getByRole("button", { name: "Guardar reporte" })).toBeDisabled();
    await page.screenshot({ path: `${SCREENSHOTS}/assistant-result-table.png` });

    await drawer.getByRole("button", { name: "Abrir como grid" }).click();
    await expect(page).toHaveURL(/\/parties\?q=/);
    // The grid starts from the query: its filter is a chip, and a value with a percent sign arrives as typed (the
    // address is encoded once and decoded once).
    await expect(page.getByText("contiene Café 50%")).toBeVisible();

    // The write: a card that needs the step-up code.
    await drawer.getByLabel("Escribe").fill("crea la Tostadora del Valle");
    await drawer.getByLabel("Escribe").press("Enter");
    const card = drawer.getByRole("article", { name: "Crea un tercero" });
    await expect(card).toBeVisible();
    const confirm = card.getByRole("button", { name: "Confirmar" });
    await expect(confirm).toBeDisabled();
    // The code box takes the caret from the composer, and the 6th digit verifies: no Verificar click.
    await expect(card.getByLabel("Código de verificación")).toBeFocused();
    await card.getByLabel("Código de verificación").fill("000000");
    await expect(card.getByText(/Código incorrecto/)).toBeVisible();
    await expect(confirm).toBeDisabled();
    await card.getByLabel("Código de verificación").fill(totpCode(secret));
    await expect(card.getByText("Verificado")).toBeVisible();
    // Verified: the caret is on Confirmar.
    await expect(confirm).toBeFocused();
    await page.screenshot({ path: `${SCREENSHOTS}/assistant-step-up-card.png` });
    await expect(confirm).toBeEnabled();
    await confirm.click();
    await expect(card.getByText("Listo · la acción se ejecutó")).toBeVisible();
    expect(await parties("800197268")).toBe(1);
  });
});
