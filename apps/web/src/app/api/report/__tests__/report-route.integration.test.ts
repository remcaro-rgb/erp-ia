import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { seedAuthUser, type AuthFixture } from "../../../../../test-support/auth-fixtures";
import { MemoryJar } from "../../../../../test-support/memory-jar";

const state = vi.hoisted(() => ({ jar: undefined as unknown }));
vi.mock("next/headers", () => ({ cookies: async () => state.jar, headers: async () => new Headers() }));
vi.mock("workflow/api", () => ({ start: vi.fn(async () => ({ runId: "test-run" })) }));

import { defineEntity, defineModule, defineProcess, defineReport, loadModules, registry, ReportState } from "@erp/kernel";
import { loginWithPassword } from "@/lib/auth/login";
import { processDeps } from "@/lib/server/runtime";
import { POST as exportPost } from "../../export/route";
import { POST } from "../[id]/route";

// POST /api/report/:id (design §9) against the real stack: a test module's report over a fixed set of rows, run as a
// member whose role gets the consult only when the test grants it.

const ROWS = Array.from({ length: 7 }, (_, i) => ({ code: `110${i}`, balance: String((i + 1) * 1000) }));

const consult = defineProcess({
  id: "reportprobe.ledger.consult",
  module: "reportprobe",
  kind: "consult",
  feature: "reportprobe.reports",
  description: "Consulta de prueba de un informe",
  input: z.object({ params: z.object({ from: z.string().optional() }), state: ReportState }),
  output: z.object({ rows: z.array(z.record(z.string(), z.unknown())), total: z.number(), aggregates: z.record(z.string(), z.unknown()).optional() }),
  handler: async (_ctx, { state: grid }) => {
    const from = (grid.page - 1) * grid.pageSize;
    return { rows: ROWS.slice(from, from + grid.pageSize), total: ROWS.length, aggregates: { balance_sum: ROWS.reduce((n, r) => n + Number(r.balance), 0) } };
  },
});

const probe = defineModule({
  id: "reportprobe",
  version: "1",
  dependsOn: [],
  entities: [defineEntity({ entityType: "maestro", id: "reportprobe.line", module: "reportprobe", schema: "reportprobe", table: "lines", label: "entity.reportprobe.line", displayField: "code", defaultSort: { field: "code", dir: "asc" }, fields: [{ name: "code", type: "text", label: "field.code" }] })],
  processes: [consult],
  features: [{ id: "reportprobe.reports", label: "feature.reportprobe", processes: [consult.id], entities: ["reportprobe.line"] }],
  events: { emits: [], consumes: {} },
  navigation: [],
  reports: [
    defineReport({
      id: "reportprobe.ledger",
      module: "reportprobe",
      feature: "reportprobe.reports",
      label: "report.reportprobe.ledger",
      params: z.object({ from: z.string().optional() }),
      consult: consult.id,
      columns: [
        { field: "code", label: "Código", type: "text", mono: true },
        { field: "balance", label: "Saldo", type: "money", total: "sum" },
      ],
      totals: ["balance"],
    }),
  ],
});

let fixture: AuthFixture;
let roleId: string;

const call = (id: string, body: unknown, headers: Record<string, string> = {}) =>
  POST(new Request(`http://localhost/api/report/${id}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }), { params: Promise.resolve({ id }) });

const grid = { filters: [], sort: [], page: 1, pageSize: 5 };

beforeAll(async () => {
  processDeps();
  if (!registry.hasModule("reportprobe")) loadModules(registry, [probe]);
  fixture = await seedAuthUser({ role: "member" });
  const { sql } = fixture;
  await sql`insert into kernel.tenant_entitlements(tenant_id, key, source) values (${fixture.tenantId}, 'module:reportprobe', 'manual')`;
  [{ id: roleId }] = await sql<{ id: string }[]>`select id from kernel.roles where company_id = ${fixture.companyIds[0]!}`;
  const jar = new MemoryJar();
  state.jar = jar;
  await loginWithPassword(jar, { email: fixture.email, password: fixture.password, remember: false });
});

afterAll(async () => {
  const { sql } = fixture;
  await sql`delete from kernel.process_permissions where company_id = any(${fixture.companyIds}::uuid[])`;
  await sql`delete from kernel.tenant_entitlements where tenant_id = ${fixture.tenantId}`;
  await fixture.cleanup();
});

describe("report-route", () => {
  it("POST /api/report/:id runs the consult as the caller and refuses a caller without the consult", async () => {
    // A member whose role has no consult: refused.
    const denied = await call("reportprobe.ledger", { params: {}, state: grid });
    expect(denied.status).toBe(403);

    // With the consult granted: the window, the total and the aggregates.
    await fixture.sql`insert into kernel.process_permissions(company_id, role_id, process_id) values (${fixture.companyIds[0]!}, ${roleId}, ${consult.id})`;
    const allowed = await call("reportprobe.ledger", { params: { from: "2026-01-01" }, state: grid });
    expect(allowed.status).toBe(200);
    const body = (await allowed.json()) as { rows: { code: string }[]; total: number; aggregates?: Record<string, unknown> };
    expect(body.total).toBe(7);
    expect(body.rows.map((r) => r.code)).toEqual(["1100", "1101", "1102", "1103", "1104"]);
    expect(body.aggregates).toEqual({ balance_sum: 28000 });
    const second = (await (await call("reportprobe.ledger", { params: {}, state: { ...grid, page: 2 } })).json()) as { rows: unknown[] };
    expect(second.rows).toHaveLength(2);

    // A window as large as an export reads.
    const wide = (await (await call("reportprobe.ledger", { params: {}, state: { ...grid, pageSize: 1000 } })).json()) as { rows: unknown[] };
    expect(wide.rows).toHaveLength(7);
  });

  it("answers 404 for an unknown report, 400 for bad parameters or state, 403 for a foreign company or a company without the module", async () => {
    expect((await call("reportprobe.nope", { params: {}, state: grid })).status).toBe(404);
    expect((await call("reportprobe.ledger", { params: { from: 5 }, state: grid })).status).toBe(400);
    expect((await call("reportprobe.ledger", { params: {}, state: { ...grid, pageSize: 5000 } })).status).toBe(400);
    expect((await call("reportprobe.ledger", "nonsense")).status).toBe(400);
    expect((await call("reportprobe.ledger", { params: {}, state: grid }, { "x-company-id": "00000000-0000-4000-8000-000000000000" })).status).toBe(403);

    await fixture.sql`delete from kernel.tenant_entitlements where tenant_id = ${fixture.tenantId}`;
    expect((await call("reportprobe.ledger", { params: {}, state: grid })).status).toBe(403);
  });

  it("exports a report through /api/export with source: every row, the headers of its columns, the consult's gate", async () => {
    const exportBody = (format: string) => ({ entity: "report:reportprobe.ledger", source: { kind: "report", id: "reportprobe.ledger", params: {} }, format, state: grid });
    const post = (body: unknown) => exportPost(new Request("http://localhost/api/export", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
    await fixture.sql`insert into kernel.tenant_entitlements(tenant_id, key, source) values (${fixture.tenantId}, 'module:reportprobe', 'manual')`;
    await fixture.sql`insert into kernel.process_permissions(company_id, role_id, process_id) values (${fixture.companyIds[0]!}, ${roleId}, 'kernel.export.run'), (${fixture.companyIds[0]!}, ${roleId}, ${consult.id}) on conflict do nothing`;
    const csv = await post(exportBody("csv"));
    expect(csv.status).toBe(200);
    const lines = (await csv.text()).replace(/^\uFEFF/, "").trim().split("\r\n");
    expect(lines).toHaveLength(8);
    expect(lines[0]).toBe('"Código";"Saldo"');
    expect((await post({ ...exportBody("csv"), source: { kind: "report", id: "reportprobe.nope", params: {} } })).status).toBe(404);
    await fixture.sql`delete from kernel.process_permissions where company_id = any(${fixture.companyIds}::uuid[]) and process_id = ${consult.id}`;
    expect((await post(exportBody("csv"))).status).toBe(403);
  });
});
