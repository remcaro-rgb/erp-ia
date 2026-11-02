import type { Page } from "@playwright/test";
import { expect, test } from "../test-support/streamed";
import { seedAuthUser, type AuthFixture } from "../test-support/auth-fixtures";

// The home screen in a real browser (design §19a, rules 25 and 28, prototype `renderHome`): the widget dashboard whose cards
// are dragged by their header to relocate and by the corner to resize, the layout saved per user in kernel.user_prefs
// (key home_layout) and reset with one button, and a recommendation whose accepted action opens the assistant.
//
// Not stubbed: sign-in, the processes behind the cards, the layout save (server action) and the recommendation decision.
// Stubbed: POST /api/agent/turn, because a turn needs a model (the turn itself is covered by packages/agent).

const SCREENSHOTS = "e2e/__screenshots__";
// core.party.create is what the first recommendation suggests: the role may take that action (and may not create products).
const PROCESSES = ["core.party.consult", "core.party.create", "core.product.consult", "kernel.home.kpis", "kernel.home.recent", "kernel.recommendation.list", "kernel.recommendation.decide"];
/** Default order: Indicadores, Recomendaciones, Ayuda rápida, Registros recientes. */
const DEFAULT_ORDER = ["Indicadores", "Recomendaciones para ti", "Ayuda rápida", "Registros recientes"];

async function signIn(page: Page, fixture: AuthFixture) {
  await page.goto("/login");
  await page.getByLabel("Correo").fill(fixture.email);
  await page.getByLabel("Contraseña", { exact: true }).fill(fixture.password);
  await page.getByRole("button", { name: "Entrar" }).click();
  await expect(page).toHaveURL(/\/$/);
}

const sse = (chunks: unknown[]) => [...chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`), "data: [DONE]\n\n"].join("");

test.describe("home dashboard", () => {
  let fixture: AuthFixture;
  let companyId: string;
  let roleId: string;
  let recParty: string;
  let recLink: string;

  /** Titles of the cards in the order they are on the page. */
  const order = (page: Page) => page.getByTestId("dashboard-grid").filter({ visible: true }).getByRole("region").evaluateAll((cards) => cards.map((c) => c.getAttribute("aria-label")));
  const saved = async () => (await fixture.sql`select value from kernel.user_prefs where user_id = ${fixture.userId} and company_id = ${companyId} and key = 'home_layout'`)[0]?.value?.value as
    | { id: string; w: number; h: number }[]
    | undefined;
  const clearBrowserCopy = (page: Page) => page.evaluate(() => window.localStorage.clear());
  /** Reloads and waits for the dashboard to be drawn again. */
  const reload = async (page: Page) => {
    await page.reload();
    await expect(page.getByTestId("dashboard-grid").filter({ visible: true })).toBeVisible();
  };

  test.beforeAll(async () => {
    fixture = await seedAuthUser({ role: "member" });
    companyId = fixture.companyIds[0]!;
    const { sql } = fixture;
    await sql`insert into kernel.tenant_entitlements(tenant_id, key, source) values (${fixture.tenantId}, 'module:core', 'manual')`;
    [{ id: roleId }] = await sql<{ id: string }[]>`select id from kernel.roles where company_id = ${companyId}`;
    for (const process of PROCESSES) {
      await sql`insert into kernel.process_permissions(company_id, role_id, process_id) values (${companyId}, ${roleId}, ${process})`;
    }
    const rec = async (title: string, body: string, actions: unknown) =>
      (
        await sql<{ id: string }[]>`
          insert into kernel.recommendations (company_id, audience_role_id, agent_profile, title, body, suggested_actions, confidence)
          values (${companyId}, ${roleId}, 'seed', ${title}, ${body}, ${sql.json(actions as never)}, 0.9) returning id`
      )[0]!.id;
    recParty = await rec("Registra tu primer cliente", "Aún no tienes terceros: el asistente puede crear el primero contigo.", [
      { label: "Crear con el asistente", processId: "core.party.create", input: { legal_name: "Panadería La Espiga" } },
    ]);
    recLink = await rec("Revisa tus productos", "Algunos productos no se pueden facturar todavía.", [{ label: "Ver productos", href: "/products" }]);
  });

  test.afterAll(async () => {
    const { sql } = fixture;
    await sql`delete from kernel.user_prefs where company_id = ${companyId}`;
    await sql`delete from kernel.recommendations where company_id = ${companyId}`;
    await sql`delete from core.entity_sequences where company_id = ${companyId}`;
    await sql`delete from kernel.process_permissions where company_id = ${companyId}`;
    await sql`delete from kernel.tenant_entitlements where tenant_id = ${fixture.tenantId}`;
    await fixture.cleanup();
  });

  test("greets, shows the cards the role may have, relocates by dragging, resizes from the corner, persists and resets", async ({ page }) => {
    test.setTimeout(120_000);
    const problems: string[] = [];
    page.on("console", (message) => {
      if (["error", "warning"].includes(message.type())) problems.push(message.text());
    });
    await page.emulateMedia({ colorScheme: "light" });
    await page.setViewportSize({ width: 1440, height: 900 });
    await signIn(page, fixture);

    // The greeting is the page's heading; the cards the role may have are drawn, in the default order.
    const home = page.getByTestId("home");
    await expect(home.getByRole("heading", { level: 1 })).toHaveText(/^(Buenos días|Buenas tardes|Buenas noches), Auth$/);
    expect(await order(page)).toEqual(DEFAULT_ORDER);
    const kpis = page.getByRole("region", { name: "Indicadores" });
    await expect(kpis.getByText("Productos")).toBeVisible();
    await expect(kpis.getByText("Terceros activos")).toBeVisible();
    await expect(kpis.getByText("Uso de IA del mes")).toBeVisible();
    // No support module here: no ticket card.
    await expect(kpis.getByText("Tickets de soporte")).toHaveCount(0);
    // Each count card draws its 14-day trend (OD-9) with an accessible name; the strip says once when it was read.
    await expect(kpis.locator('[data-kpi="core.parties"] svg[role="img"]')).toHaveAccessibleName(/^Tendencia 14 días: de \d+ a \d+$/);
    await expect(kpis.locator('svg[role="img"]').first()).toBeVisible();
    // A snapshot says when it was read, and the size hint stays out of sight until the card is resized or focused.
    await expect(kpis.getByText(/^Actualizado \d{2}:\d{2}$/)).toBeVisible();
    await page.mouse.click(5, 5);
    await expect(kpis.locator(".erp-wg__size")).toHaveCSS("opacity", "0");
    const recs = page.getByRole("region", { name: "Recomendaciones para ti" });
    await expect(recs.getByText("Registra tu primer cliente")).toBeVisible();
    await expect(recs.getByText("Revisa tus productos")).toBeVisible();
    await expect(page.getByRole("region", { name: "Registros recientes" })).toContainText("Aún no has creado ni modificado registros.");
    await page.screenshot({ path: `${SCREENSHOTS}/home-dashboard.png` });

    // Drag the last card (Registros recientes) by its header onto the first slot: it takes that place and the order is stored.
    await page.getByRole("region", { name: "Registros recientes" }).getByRole("button", { name: "Mover Registros recientes" }).dragTo(page.getByRole("region", { name: "Indicadores" }));
    const moved = ["Registros recientes", "Indicadores", "Recomendaciones para ti", "Ayuda rápida"];
    expect(await order(page)).toEqual(moved);
    await expect.poll(async () => (await saved())?.map((w) => w.id)).toEqual(["recent", "kpis", "recommendations", "help"]);
    // The server copy alone brings it back (the browser's cache is cleared first).
    await clearBrowserCopy(page);
    await reload(page);
    expect(await order(page)).toEqual(moved);

    // Resize the first card (4 columns) to 2 from its corner: drag left by two columns; the height follows the drag too.
    const card = page.getByRole("region", { name: "Registros recientes" });
    const grid = page.getByTestId("dashboard-grid").filter({ visible: true });
    const gridBox = (await grid.boundingBox())!;
    const column = (gridBox.width - 36) / 4;
    const before = (await card.boundingBox())!;
    const grip = (await card.getByRole("button", { name: "Cambiar tamaño de Registros recientes" }).boundingBox())!;
    const x = grip.x + grip.width / 2;
    const y = grip.y + grip.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x - 2 * (column + 12), y + 40, { steps: 8 });
    await expect(card).toHaveAttribute("data-resizing", "true");
    await page.mouse.up();
    await expect.poll(async () => (await saved())?.find((w) => w.id === "recent")).toMatchObject({ w: 2 });
    const stored = (await saved())!.find((w) => w.id === "recent")!;
    expect(stored.h).toBeGreaterThanOrEqual(400);
    const after = (await card.boundingBox())!;
    expect(Math.abs(after.width - (2 * column + 12))).toBeLessThan(2);
    expect(after.width).toBeLessThan(before.width / 1.8);
    await clearBrowserCopy(page);
    await reload(page);
    expect(Math.abs((await card.boundingBox())!.width - (2 * column + 12))).toBeLessThan(2);
    await expect(card.getByText(/^2\/4 · \d+ px$/)).toBeVisible();

    // Restablecer tarjetas: the default order and sizes, stored as such.
    await page.getByRole("button", { name: "Restablecer tarjetas" }).click();
    expect(await order(page)).toEqual(DEFAULT_ORDER);
    await expect.poll(async () => (await saved())?.map((w) => w.id)).toEqual(["kpis", "recommendations", "help", "recent"]);
    expect((await saved())!.find((w) => w.id === "recent")).toMatchObject({ w: 4 });
    await clearBrowserCopy(page);
    await reload(page);
    expect(await order(page)).toEqual(DEFAULT_ORDER);

    expect(problems.filter((text) => !/404 \(Not Found\)/.test(text))).toEqual([]);
  });

  test("the dashboard works from the keyboard", async ({ page }) => {
    await signIn(page, fixture);
    await expect(page.getByTestId("dashboard-grid").filter({ visible: true })).toBeVisible();
    const handle = page.getByRole("button", { name: "Mover Ayuda rápida" });
    await handle.focus();
    await page.keyboard.press("Alt+ArrowLeft");
    expect(await order(page)).toEqual(["Indicadores", "Ayuda rápida", "Recomendaciones para ti", "Registros recientes"]);
    await page.getByRole("button", { name: "Restablecer tarjetas" }).click();
    expect(await order(page)).toEqual(DEFAULT_ORDER);
  });

  test("accepting a recommendation's action opens the assistant with the process to confirm; dismissing removes it", async ({ page }) => {
    test.setTimeout(120_000);
    let asked: string | undefined;
    await page.route("**/api/agent/turn", async (route) => {
      asked = (route.request().postDataJSON() as { text: string }).text;
      await route.fulfill({ status: 200, headers: { "content-type": "text/event-stream", "x-conversation-id": "0197a1b2-0000-7000-8000-0000000000c1" }, body: sse([{ type: "start" }, { type: "finish" }]) });
    });
    await page.setViewportSize({ width: 1440, height: 900 });
    await signIn(page, fixture);
    const recs = page.getByRole("region", { name: "Recomendaciones para ti" });
    await recs.getByRole("button", { name: "Crear con el asistente" }).click();

    // The decision is stored, the card leaves the inbox and the assistant gets the message that makes it propose the confirmation.
    await expect(recs.getByText("Registra tu primer cliente")).toHaveCount(0);
    await expect.poll(() => asked).toBe('Ejecuta core.party.create con {"legal_name":"Panadería La Espiga"}');
    await expect(page.getByRole("complementary", { name: "Asistente" })).toContainText("Ejecuta core.party.create");
    const [row] = await fixture.sql`select status, decided_by from kernel.recommendations where id = ${recParty}`;
    expect(row).toMatchObject({ status: "accepted", decided_by: fixture.userId });
    // Nothing ran by itself: no party was created.
    expect((await fixture.sql`select count(*)::int as n from core.parties where company_id = ${companyId}`)[0]!.n).toBe(0);

    await recs.getByRole("button", { name: "Descartar" }).click();
    await expect(recs.getByText("Revisa tus productos")).toHaveCount(0);
    await expect(recs.getByText("Sin recomendaciones pendientes", { exact: true })).toBeVisible();
    expect((await fixture.sql`select status from kernel.recommendations where id = ${recLink}`)[0]!.status).toBe("dismissed");
    await reload(page);
    await expect(page.getByRole("region", { name: "Recomendaciones para ti" }).getByText("Sin recomendaciones pendientes", { exact: true })).toBeVisible();
  });

  test("an accepted action the role may not take is refused: the card stays, the assistant is not opened", async ({ page }) => {
    let asked = false;
    await page.route("**/api/agent/turn", async (route) => {
      asked = true;
      await route.fulfill({ status: 200, headers: { "content-type": "text/event-stream" }, body: sse([{ type: "start" }, { type: "finish" }]) });
    });
    const [{ id }] = await fixture.sql<{ id: string }[]>`
      insert into kernel.recommendations (company_id, audience_role_id, agent_profile, title, body, suggested_actions)
      values (${companyId}, ${roleId}, 'seed', 'Crea un producto', 'Tu rol no puede crear productos.',
              ${fixture.sql.json([{ label: "Crear producto", processId: "core.product.create", input: { sku: "X" } }] as never)})
      returning id`;
    await signIn(page, fixture);
    const recs = page.getByRole("region", { name: "Recomendaciones para ti" });
    await recs.getByRole("button", { name: "Crear producto" }).click();
    await expect(recs.getByRole("alert")).toContainText("Tu rol no puede hacer esta acción");
    await expect(recs.getByText("Crea un producto")).toBeVisible();
    expect((await fixture.sql`select status from kernel.recommendations where id = ${id}`)[0]!.status).toBe("new");
    expect(asked).toBe(false);
    await expect(page.getByRole("complementary", { name: "Asistente" })).not.toContainText("Ejecuta core.product.create");
    // It can still be dismissed.
    await recs.getByRole("button", { name: "Descartar" }).click();
    await expect(recs.getByText("Crea un producto")).toHaveCount(0);
  });
});
