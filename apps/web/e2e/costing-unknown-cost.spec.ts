import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { expect, test } from "../test-support/streamed";
import { cleanupCompanies } from "../test-support/company-cleanup";
import { enrolTotp, seedAuthUser, type AuthFixture } from "../test-support/auth-fixtures";
import { confirmStepUp, signInWithCode } from "../test-support/accounting-fixture";

// «Costo de unidades sin costo conocido» (plan 2B.2 Task 44, owner item 36, design §22.28): Parámetros › Costeo shows the section with
// «Cero (como hasta ahora)» chosen and the trade-off text; the admin chooses «Último costo conocido», confirms with the TOTP and reads
// «Guardado». A product received at 100 and then issued with no cost of its own (test-support/unknown-cost-chain.mts, through the registered
// processes and costing's consumer) is valued at 100 as an estimate (cost_source last_known, cost_missing) and Costos pendientes lists it.
// A role without costing.unknown_cost.set sees the select disabled. Cost events have no screen of their own: the estimate is read in the
// database (its label «Último costo conocido (estimado)» is the catalogue's costing.values.cost_source.last_known, kept by the i18n tests).

const CHAIN = join(__dirname, "..", "test-support", "unknown-cost-chain.mts");
const ADMIN_PROCESSES = [
  "core.product.create", "core.product.consult", "inventory.warehouse.create", "inventory.location.create", "inventory.movement.post",
  "costing.settings.consult", "costing.settings.update", "costing.unknown_cost.set", "costing.cost_missing.consult", "costing.cost_layer.consult",
];

test.describe("costing: unknown cost mode", () => {
  test.describe.configure({ mode: "serial" });
  let fixture: AuthFixture;
  let secret: string;
  let reader: AuthFixture;
  let readerSecret: string;
  let companyId: string;

  const mode = async () => (await fixture.sql<{ unknown_cost_mode: string }[]>`select unknown_cost_mode from costing.settings where company_id = ${companyId}`)[0]?.unknown_cost_mode;
  const entitle = async (f: AuthFixture) => {
    for (const key of ["module:core", "module:inventory", "module:costing"]) {
      await f.sql`insert into kernel.tenant_entitlements(tenant_id, key, source) values (${f.tenantId}, ${key}, 'manual')`;
    }
  };

  test.beforeAll(async () => {
    test.setTimeout(240_000);
    fixture = await seedAuthUser({ role: "admin" });
    secret = await enrolTotp(fixture);
    companyId = fixture.companyIds[0]!;
    await entitle(fixture);
    const [role] = await fixture.sql<{ id: string }[]>`select id from kernel.roles where company_id = ${companyId} and name = 'admin'`;
    for (const process of ADMIN_PROCESSES) await fixture.sql`insert into kernel.process_permissions(company_id, role_id, process_id) values (${companyId}, ${role!.id}, ${process}) on conflict do nothing`;
    // A reader: consults the settings, may not change the mode.
    reader = await seedAuthUser({ role: "member" });
    readerSecret = await enrolTotp(reader);
    await entitle(reader);
    const [member] = await reader.sql<{ id: string }[]>`select id from kernel.roles where company_id = ${reader.companyIds[0]!} and name = 'member'`;
    await reader.sql`insert into kernel.process_permissions(company_id, role_id, process_id) values (${reader.companyIds[0]!}, ${member!.id}, 'costing.settings.consult')`;
  });

  test.afterAll(async () => {
    if (reader) await cleanupCompanies(reader.sql, reader.companyIds, reader.tenantId).finally(() => reader.cleanup());
    if (!fixture) return;
    try {
      await cleanupCompanies(fixture.sql, fixture.companyIds, fixture.tenantId);
    } finally {
      await fixture.cleanup();
    }
  });

  test("Parámetros › Costeo: Cero por defecto, aviso del costo, «Último costo conocido» guardado con el código", async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await signInWithCode(page, fixture, secret);
    await page.goto("/costing/settings");
    const section = page.locator("section.erp-sec").filter({ has: page.getByRole("heading", { name: "Costo de unidades sin costo conocido" }) });
    const select = section.getByLabel("Valorar las unidades sin costo conocido a");
    await expect(select).toBeEnabled();
    await expect(select.locator("option:checked")).toHaveText("Cero (como hasta ahora)");
    await expect(section.getByText(/Con cero, las unidades sin costo entran valoradas en 0 y bajan el costo promedio/)).toBeVisible();
    await expect(section.getByText(/El cambio vale desde el siguiente movimiento; no recalcula nada\./)).toBeVisible();
    await select.selectOption({ label: "Último costo conocido" });
    // The method keeps its own Guardar; the mode saves apart.
    await page.getByRole("button", { name: "Guardar opción" }).click();
    await confirmStepUp(page, secret);
    await expect(page.getByRole("status").filter({ hasText: "Guardado" })).toBeVisible();
    expect(await mode()).toBe("last_known");
    const [method] = await fixture.sql<{ method: string }[]>`select method from costing.settings where company_id = ${companyId}`;
    expect(method!.method).toBe("average");
    await page.reload();
    await expect(page.getByLabel("Valorar las unidades sin costo conocido a").locator("option:checked")).toHaveText("Último costo conocido");
  });

  test("a product issued with no cost of its own is valued at its last known cost, flagged, and Costos pendientes lists it", async ({ page }) => {
    test.setTimeout(180_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    const out = execFileSync("pnpm", ["exec", "tsx", CHAIN, companyId, fixture.userId], { cwd: join(__dirname, ".."), stdio: "pipe", env: process.env, timeout: 120_000 }).toString();
    const ids = JSON.parse(out.trim().split("\n").filter((l) => l.startsWith("{")).at(-1)!) as { productId: string; issueId: string };
    const [event] = await fixture.sql<{ unit_cost: string; amount: string; cost_source: string; cost_missing: boolean }[]>`
      select unit_cost, amount, cost_source, cost_missing from costing.cost_events where company_id = ${companyId} and movement_id = ${ids.issueId}`;
    expect(event).toMatchObject({ cost_source: "last_known", cost_missing: true });
    expect(Number(event!.unit_cost)).toBe(100);
    expect(Number(event!.amount)).toBe(-200);
    await signInWithCode(page, fixture, secret);
    await page.goto("/costing/missing");
    const grid = page.locator("section.erp-grid").filter({ visible: true });
    await expect(grid.getByRole("row", { name: /Café Estimado 500 g/ })).toContainText("Bodega Sin Costo");
  });

  test("a role without costing.unknown_cost.set sees the select disabled and no Guardar for it", async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await signInWithCode(page, reader, readerSecret);
    await page.goto("/costing/settings");
    const select = page.getByLabel("Valorar las unidades sin costo conocido a");
    await expect(select).toBeDisabled();
    await expect(page.getByText("Tu rol puede ver este parámetro, pero no cambiarlo.")).toBeVisible();
    await expect(page.getByRole("button", { name: /^Guardar/ })).toHaveCount(0);
  });
});
