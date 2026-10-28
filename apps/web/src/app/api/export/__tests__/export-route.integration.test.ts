import ExcelJS from "exceljs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { seedAuthUser, type AuthFixture } from "../../../../../test-support/auth-fixtures";
import { MemoryJar } from "../../../../../test-support/memory-jar";

const state = vi.hoisted(() => ({ jar: undefined as unknown, started: [] as Promise<unknown>[] }));
vi.mock("next/headers", () => ({ cookies: async () => state.jar, headers: async () => new Headers() }));
// The workflow runtime is not under test here (the kernel's own suite runs the workflow under @workflow/vitest):
// `start` runs the workflow function in the background, as the runtime would after the route answered.
vi.mock("workflow/api", () => ({
  start: vi.fn(async (workflow: (...args: unknown[]) => Promise<unknown>, args: unknown[]) => {
    state.started.push(workflow(...args));
    return { runId: "test-run" };
  }),
}));

import { MemoryFileStore } from "@erp/kernel/testing";
import { setExportsStore } from "@erp/kernel";
import { loginWithPassword } from "@/lib/auth/login";
import { GET as status } from "../[jobId]/route";
import { POST } from "../route";

// POST /api/export and GET /api/export/:jobId (design §9, rules 14 and 20) against the real stack: a cashier whose
// role consults parties and exports, with `credit_limit` hidden and `document_number` masked.

let fixture: AuthFixture;
let other: AuthFixture;
let roleId: string;
const store = new MemoryFileStore();

const base = { filters: [], sort: [{ field: "seq", dir: "asc" }], page: 1, pageSize: 25, columns: ["seq", "legal_name", "document_number", "credit_limit", "kind"] };
const request = (body: unknown, headers: Record<string, string> = {}) =>
  new Request("http://localhost/api/export", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
const post = (body: unknown, headers?: Record<string, string>) => POST(request(body, headers));
const exportBody = (format: string, extra: Record<string, unknown> = {}, grid: Record<string, unknown> = {}) => ({
  entity: "core.party",
  format,
  title: "Terceros",
  state: { ...base, ...grid },
  ...extra,
});
const poll = (jobId: string) => status(new Request(`http://localhost/api/export/${jobId}`), { params: Promise.resolve({ jobId }) });

async function untilDone(jobId: string): Promise<{ status: string; url?: string; rowCount?: number; error?: string; fileName?: string }> {
  for (let i = 0; i < 240; i++) {
    const response = await poll(jobId);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { status: string };
    if (body.status === "done" || body.status === "failed") return body as never;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("the export job did not finish");
}

beforeAll(async () => {
  setExportsStore(store);
  fixture = await seedAuthUser({ role: "member" });
  other = await seedAuthUser({ role: "member" });
  const companyId = fixture.companyIds[0]!;
  const { sql } = fixture;
  await sql`insert into kernel.tenant_entitlements(tenant_id, key, source) values (${fixture.tenantId}, 'module:core', 'manual')`;
  [{ id: roleId }] = await sql<{ id: string }[]>`select id from kernel.roles where company_id = ${companyId}`;
  await sql`insert into kernel.process_permissions(company_id, role_id, process_id) values
    (${companyId}, ${roleId}, 'core.party.consult'), (${companyId}, ${roleId}, 'kernel.export.run')`;
  await sql`insert into kernel.field_permissions(company_id, role_id, entity, field, mode) values
    (${companyId}, ${roleId}, 'core.party', 'credit_limit', 'hidden'),
    (${companyId}, ${roleId}, 'core.party', 'document_number', 'masked')`;
  for (let i = 1; i <= 20; i++) {
    await sql`insert into core.parties (company_id, kind, person_type, document_type, document_number, legal_name, credit_limit, dian_status)
              values (${companyId}, ${i % 2 === 0 ? ["supplier"] : ["customer"]}, '1', '31', ${String(900000000 + i)}, ${`Tercero ${String(i).padStart(2, "0")} Ñandú`}, ${i * 1000}, 'complete')`;
  }
  const jar = new MemoryJar();
  state.jar = jar;
  await loginWithPassword(jar, { email: fixture.email, password: fixture.password, remember: false });
});

afterAll(async () => {
  await Promise.allSettled(state.started);
  setExportsStore(undefined);
  const { sql } = fixture;
  await sql.begin(async (tx) => {
    await tx`set local session_replication_role = replica`;
    await tx`delete from core.parties where company_id = any(${fixture.companyIds}::uuid[])`;
  });
  await sql`delete from core.entity_sequences where company_id = any(${fixture.companyIds}::uuid[])`;
  await sql`delete from kernel.export_jobs where company_id = any(${fixture.companyIds}::uuid[])`;
  await sql`delete from kernel.field_permissions where company_id = any(${fixture.companyIds}::uuid[])`;
  await sql`delete from kernel.process_permissions where company_id = any(${fixture.companyIds}::uuid[])`;
  await sql`delete from kernel.tenant_entitlements where tenant_id = ${fixture.tenantId}`;
  await fixture.cleanup();
  await other.cleanup();
});

describe("export-route", () => {
  it("20 parties to csv come back inline: BOM, ; separator, 20 data lines, the masked column as ••••••, the hidden one left out", async () => {
    const response = await post(exportBody("csv"));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toMatch(/^text\/csv/);
    expect(response.headers.get("content-disposition")).toMatch(/^attachment; filename="terceros-\d{4}-\d{2}-\d{2}\.csv"/);
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const lines = new TextDecoder().decode(bytes).split("\r\n");
    expect(lines.pop()).toBe("");
    // The headers are the catalogue's labels; the cashier's hidden credit_limit is not a column at all.
    expect(lines[0]).toBe('"N.º";"Razón social";"Número de documento";"Tipo de tercero"');
    expect(lines).toHaveLength(21);
    expect(lines[1]).toBe('1;"Tercero 01 Ñandú";"••••••";"Cliente"');
    expect(lines.slice(1).every((line) => line.split(";")[2] === '"••••••"')).toBe(true);
    expect(lines.join("")).not.toMatch(/90000000\d|credit|Cupo/);
  });

  it("exports the same rows the grid shows: filters and sort apply, all pages, no page limit", async () => {
    const response = await post(exportBody("csv", {}, { filters: [{ field: "kind", op: "eq", value: "supplier" }], sort: [{ field: "legal_name", dir: "desc" }], pageSize: 5 }));
    const lines = (await response.text()).split("\r\n").filter(Boolean);
    expect(lines).toHaveLength(11);
    expect(lines[1]).toContain("Tercero 20");
    expect(lines.every((line, i) => i === 0 || line.endsWith('"Proveedor"'))).toBe(true);
  });

  it("xlsx comes back inline with real types, the header frozen and the masked column as ••••••", async () => {
    const response = await post(exportBody("xlsx", {}, { columns: ["seq", "legal_name", "document_number", "created_at"] }));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    expect(response.headers.get("content-disposition")).toMatch(/filename="terceros-\d{4}-\d{2}-\d{2}\.xlsx"/);
    const book = new ExcelJS.Workbook();
    await book.xlsx.load((await response.arrayBuffer()) as ArrayBuffer);
    const sheet = book.worksheets[0]!;
    expect(sheet.name).toBe("Terceros");
    expect(sheet.views[0]).toMatchObject({ state: "frozen", ySplit: 1 });
    expect(sheet.rowCount).toBe(21);
    expect(sheet.getRow(2).getCell(1).value).toBe(1);
    expect(sheet.getRow(2).getCell(3).value).toBe("••••••");
    expect(sheet.getRow(2).getCell(4).value).toBeInstanceOf(Date);
  });

  it("pdf comes back inline as a PDF", async () => {
    const response = await post(exportBody("pdf"));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/pdf");
    expect(Buffer.from(await response.arrayBuffer()).subarray(0, 4).toString("latin1")).toBe("%PDF");
  });

  it("is audited as a consult of kernel.export.run, as the user, with the format in its input", async () => {
    const rows = await fixture.sql<{ action: string; origin: string; actor_user_id: string; input: { format: string; entity: string } }[]>`
      select action, origin, actor_user_id, input from kernel.audit_log
      where company_id = ${fixture.companyIds[0]!} and process_id = 'kernel.export.run' order by occurred_at`;
    expect(rows.length).toBeGreaterThanOrEqual(4);
    expect(rows.every((r) => r.action === "consult" && r.actor_user_id === fixture.userId)).toBe(true);
    expect(rows.map((r) => r.input.format)).toEqual(expect.arrayContaining(["csv", "xlsx", "pdf"]));
  });

  it("refuses what the grid refuses: hidden or masked fields in the filter or sort (403), an unknown entity (404), a bad body (400)", async () => {
    const hidden = await post(exportBody("csv", {}, { filters: [{ field: "credit_limit", op: "gt", value: 1 }] }));
    expect(hidden.status).toBe(403);
    expect(await hidden.json()).toMatchObject({ code: "forbidden" });
    expect((await post(exportBody("csv", {}, { sort: [{ field: "document_number", dir: "asc" }] }))).status).toBe(403);
    expect((await post({ ...exportBody("csv"), entity: "core.nope" })).status).toBe(404);
    expect((await post(exportBody("docx"))).status).toBe(400);
    expect((await post({ entity: "core.party" })).status).toBe(400);
    expect((await post(exportBody("csv", {}, { columns: ["nope"] }))).status).toBe(400);
    expect((await post(exportBody("csv"), { "x-company-id": other.companyIds[0]! })).status).toBe(403);
  });

  it("403 without kernel.export.run, without the entity's consult and without the module", async () => {
    const companyId = fixture.companyIds[0]!;
    await fixture.sql`delete from kernel.process_permissions where company_id = ${companyId} and process_id = 'kernel.export.run'`;
    try {
      const denied = await post(exportBody("csv"));
      expect(denied.status).toBe(403);
      expect(await denied.json()).toMatchObject({ code: "forbidden" });
    } finally {
      await fixture.sql`insert into kernel.process_permissions(company_id, role_id, process_id) values (${companyId}, ${roleId}, 'kernel.export.run')`;
    }
    // Exporting is not a way around the entity's own permission: this role may not consult products.
    expect((await post({ ...exportBody("csv"), entity: "core.product", state: { ...base, columns: ["sku"] } })).status).toBe(403);
    await fixture.sql`delete from kernel.tenant_entitlements where tenant_id = ${fixture.tenantId}`;
    try {
      const response = await post(exportBody("csv"));
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ code: "not_entitled" });
    } finally {
      await fixture.sql`insert into kernel.tenant_entitlements(tenant_id, key, source) values (${fixture.tenantId}, 'module:core', 'manual')`;
    }
  });

  it("10,001 rows switch to a job: 202 { mode: job }, it ends done, the file is in the bucket and the signed URL lasts 10 minutes", async () => {
    const companyId = fixture.companyIds[0]!;
    // Bulk fixture rows bypass the triggers (audit, seq) to keep the suite's audit log small: seq is given.
    await fixture.sql.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      await tx`
        insert into core.parties (company_id, seq, kind, person_type, document_type, document_number, legal_name, credit_limit, dian_status)
        select ${companyId}, 1000 + n, array['customer'], '1', '31', 'B' || n, 'Masivo ' || lpad(n::text, 5, '0'), 0, 'complete'
        from generate_series(1, 9981) as n`;
    });
    const response = await post(exportBody("csv", {}, { sort: [{ field: "seq", dir: "asc" }] }));
    expect(response.status).toBe(202);
    const started = (await response.json()) as { mode: string; jobId: string };
    expect(started.mode).toBe("job");
    expect(started.jobId).toMatch(/^[0-9a-f-]{36}$/);

    const done = await untilDone(started.jobId);
    expect(done.status).toBe("done");
    expect(done.rowCount).toBe(10001);
    expect(done.fileName).toMatch(/^terceros-\d{4}-\d{2}-\d{2}\.csv$/);
    expect(done.url).toBe(`memory://${companyId}/${started.jobId}.csv?ttl=600`);

    const stored = store.files.get(`${companyId}/${started.jobId}.csv`)!;
    expect(stored.contentType).toMatch(/^text\/csv/);
    const lines = new TextDecoder().decode(stored.bytes).split("\r\n");
    expect(lines).toHaveLength(10_003);
    expect(lines[1]).toBe('1;"Tercero 01 Ñandú";"••••••";"Cliente"');
    expect(lines.at(-2)).toBe('10981;"Masivo 09981";"••••••";"Cliente"');

    const [job] = await fixture.sql<{ status: string; row_count: number; storage_path: string; finished_at: Date | null; user_id: string }[]>`
      select status, row_count, storage_path, finished_at, user_id from kernel.export_jobs where id = ${started.jobId}`;
    expect(job).toMatchObject({ status: "done", row_count: 10001, storage_path: `${companyId}/${started.jobId}.csv`, user_id: fixture.userId });
    expect(job!.finished_at).not.toBeNull();

    // The start was audited as a consult, and the job's row changes (created, running, done) joined its chain.
    const [consult] = await fixture.sql<{ chain_id: string }[]>`
      select chain_id from kernel.audit_log where process_id = 'kernel.export.run' and action = 'consult' and company_id = ${companyId} order by occurred_at desc limit 1`;
    const changes = await fixture.sql<{ action: string; origin: string }[]>`
      select action, origin from kernel.audit_log where entity = 'kernel.export_jobs' and chain_id = ${consult!.chain_id} order by occurred_at`;
    expect(changes.map((c) => c.action)).toEqual(["insert", "update", "update"]);
    expect(changes.map((c) => c.origin)).toEqual(["ui", "api", "api"]);
  }, 120_000);

  it("a PDF over 10,000 rows is refused with a reason the screen translates; Excel and CSV are not", async () => {
    const refused = await post(exportBody("pdf"));
    expect(refused.status).toBe(400);
    expect(await refused.json()).toMatchObject({ code: "invalid_input", details: ["pdf_too_large"] });
    const xlsx = await post(exportBody("xlsx"));
    expect(xlsx.status).toBe(202);
    // The job renders in the background: wait for it, so its file write cannot land in a later test's store mock.
    expect((await untilDone(((await xlsx.json()) as { jobId: string }).jobId)).status).toBe("done");
  }, 120_000);

  it("a job is visible only to who started it: another member's job and an unknown id are 404, never the signed URL", async () => {
    const companyId = fixture.companyIds[0]!;
    const [foreign] = await fixture.sql<{ id: string }[]>`
      insert into kernel.export_jobs (company_id, user_id, entity, format, status, storage_path, file_name, row_count)
      values (${companyId}, ${other.userId}, 'core.party', 'csv', 'done', ${`${companyId}/foreign.csv`}, 'foreign.csv', 3) returning id`;
    store.files.set(`${companyId}/foreign.csv`, { bytes: new Uint8Array(), contentType: "text/csv" });
    expect((await poll(foreign!.id)).status).toBe(404);
    expect((await poll("00000000-0000-7000-8000-000000000000")).status).toBe(404);
    expect((await poll("not-a-uuid")).status).toBe(404);
    // A malformed percent escape is a bad id like any other, not a server error.
    expect((await poll("%E0%A4%A")).status).toBe(404);
    expect((await poll("%")).status).toBe(404);
  });

  it("a job whose file cannot be stored ends failed with a user message, and 401 without a session", async () => {
    const put = vi.spyOn(store, "put").mockRejectedValueOnce(new Error("disk full: secret internals"));
    const quiet = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const response = await post(exportBody("csv"));
      expect(response.status).toBe(202);
      const { jobId } = (await response.json()) as { jobId: string };
      const done = await untilDone(jobId);
      expect(done).toMatchObject({ status: "failed", error: "No se pudo generar la exportación" });
      expect(done.url).toBeUndefined();
      const [job] = await fixture.sql<{ status: string; storage_path: string | null; finished_at: Date | null }[]>`select status, storage_path, finished_at from kernel.export_jobs where id = ${jobId}`;
      expect(job).toMatchObject({ status: "failed", storage_path: null });
      expect(job!.finished_at).not.toBeNull();
    } finally {
      put.mockRestore();
      quiet.mockRestore();
    }
    const saved = state.jar;
    state.jar = new MemoryJar();
    try {
      expect((await post(exportBody("csv"))).status).toBe(401);
      expect((await poll("00000000-0000-7000-8000-000000000000")).status).toBe(401);
    } finally {
      state.jar = saved;
    }
  }, 120_000);
});
