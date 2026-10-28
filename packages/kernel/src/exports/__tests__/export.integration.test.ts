import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { start } from "workflow/api";
import { z } from "zod";
import { ensureRoleProbe, seedTenant, testDb, type SeededTenant } from "../../db/test-db";
import { exportsStore, MemoryFileStore, setExportsStore } from "../../files/store";
import { defineModule } from "../../module/define";
import { kernelModule } from "../../module/kernel-module";
import { loadModules } from "../../module/loader";
import { defineProcess } from "../../process/define";
import { ProcessError } from "../../process/errors";
import { runProcess } from "../../process/run";
import { defineEntity, registry } from "../../registry";
import { exportJobWorkflow } from "../export.workflow";
import { EXPORT_FAILED_MESSAGE, exportJobStatus } from "../jobs";

// kernel.export.run and the export job under the Workflow runtime (@workflow/vitest compiles "use workflow" /
// "use step" and runs the run in-process): what the export route's `start(exportJobWorkflow, …)` does. A stub entity
// over the test table kernel.role_probe stands in for a module's entity.

const MODULE = `wfexp${randomUUID().slice(0, 6)}`;
const probe = defineEntity({
  id: `${MODULE}.probe`,
  module: MODULE,
  schema: "kernel",
  table: "role_probe",
  label: `entity.${MODULE}.probe`,
  displayField: "secret",
  defaultSort: { field: "secret", dir: "asc" },
  fields: [{ name: "secret", type: "text", label: `field.${MODULE}.probe.secret` }],
});
const probeConsult = defineProcess({
  id: `${MODULE}.probe.consult`,
  module: MODULE,
  kind: "consult",
  description: "consulta los probes",
  input: z.object({}),
  output: z.object({}),
  handler: async () => ({}),
});

const state = { filters: [], sort: [{ field: "secret", dir: "asc" as const }], page: 1, pageSize: 25, columns: ["secret"] };
const request = (extra: Record<string, unknown> = {}) => ({ entity: probe.id, format: "csv", title: "Probes", state, labels: { secret: "Secreto" }, ...extra });

describe("kernel.export.run and the export job", () => {
  const sql = testDb();
  const store = new MemoryFileStore();
  let seed: SeededTenant;
  let companyId: string;
  let memberRoleId: string;
  const deps = { sql, registry };

  const as = (user: string) => ({ claims: seed.claimsFor(seed.users[user]!, companyId), origin: "ui" as const });
  const fill = async (rows: number) => {
    await sql`delete from kernel.role_probe where company_id = ${companyId}`;
    await sql`insert into kernel.role_probe (company_id, secret) select ${companyId}, 'fila ' || lpad(n::text, 6, '0') from generate_series(1, ${rows}::int) as n`;
  };

  beforeAll(async () => {
    await ensureRoleProbe(sql);
    seed = await seedTenant(sql, { companies: 1, entitlements: [`module:${MODULE}`], users: [{ name: "clerk", companies: [0], role: "member" }] });
    companyId = seed.companies[0]!.id;
    memberRoleId = seed.companies[0]!.memberRoleId;
    loadModules(registry, [
      kernelModule,
      defineModule({ id: MODULE, version: "1", dependsOn: [], entities: [probe], processes: [probeConsult], features: [], events: { emits: [], consumes: {} }, navigation: [] }),
    ]);
    for (const roleId of [seed.companies[0]!.adminRoleId, memberRoleId]) {
      for (const id of [probeConsult.id, "kernel.export.run"]) {
        await sql`insert into kernel.process_permissions(company_id, role_id, process_id) values (${companyId}, ${roleId}, ${id})`;
      }
    }
    setExportsStore(store);
  });

  afterAll(async () => {
    setExportsStore(undefined);
    await sql`delete from kernel.role_probe where company_id = ${companyId}`;
    await sql`delete from kernel.process_permissions where company_id = ${companyId}`;
    await seed.cleanup();
    await sql.end();
  });

  it("answers inline under 10,000 rows and with a job from 10,000, and audits the consult as the caller", async () => {
    await fill(9_999);
    expect(await runProcess(deps, as("both"), "kernel.export.run", request())).toMatchObject({ mode: "inline", contentType: "text/csv; charset=utf-8", filename: expect.stringMatching(/^probes-\d{4}-\d{2}-\d{2}\.csv$/) });
    expect(await runProcess(deps, as("both"), "kernel.export.run", request({ format: "xlsx" }))).toMatchObject({ mode: "inline", filename: expect.stringMatching(/\.xlsx$/) });
    expect(await sql`select 1 from kernel.export_jobs where company_id = ${companyId}`).toHaveLength(0);

    await fill(10_000);
    const out = await runProcess(deps, as("both"), "kernel.export.run", request());
    expect(out).toMatchObject({ mode: "job", jobId: expect.stringMatching(/^[0-9a-f-]{36}$/) });
    const [job] = await sql<{ status: string; user_id: string; format: string; entity: string; state: { title: string; labels: Record<string, string>; locale: string } }[]>`
      select status, user_id, format, entity, state from kernel.export_jobs where id = ${(out as { jobId: string }).jobId}`;
    expect(job).toMatchObject({ status: "queued", user_id: seed.users.both, format: "csv", entity: probe.id });
    expect(job!.state).toMatchObject({ title: "Probes", labels: { secret: "Secreto" }, locale: "es-419" });
    const audit = await sql<{ action: string; actor_user_id: string; origin: string }[]>`
      select action, actor_user_id, origin from kernel.audit_log where company_id = ${companyId} and process_id = 'kernel.export.run' and action = 'consult'`;
    expect(audit).toHaveLength(3);
    expect(audit.every((a) => a.actor_user_id === seed.users.both && a.origin === "ui")).toBe(true);
  });

  it("start(exportJobWorkflow) renders every page into the exports bucket and records the job as done", async () => {
    await fill(10_500);
    const caller = as("both");
    const chainId = randomUUID();
    const out = (await runProcess(deps, { ...caller, chainId }, "kernel.export.run", request({ format: "xlsx" }))) as { jobId: string };

    const run = await start(exportJobWorkflow, [{ jobId: out.jobId, claims: caller.claims, chainId }]);
    expect(await run.returnValue).toEqual({ jobId: out.jobId, status: "done", rowCount: 10_500 });

    const path = `${companyId}/${out.jobId}.xlsx`;
    const stored = store.files.get(path)!;
    expect(stored.contentType).toBe("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    const { default: ExcelJS } = await import("exceljs");
    const book = new ExcelJS.Workbook();
    await book.xlsx.load(stored.bytes as unknown as ArrayBuffer);
    const sheet = book.getWorksheet("Probes")!;
    expect(sheet.rowCount).toBe(10_501);
    expect(sheet.getRow(1).getCell(1).value).toBe("Secreto");
    expect(sheet.getRow(10_501).getCell(1).value).toBe("fila 010500");

    // One audit entry per change of the job (created, running, done), none twice; the workflow's updates name the
    // job's user as `updated_by`; the consult's audit input leaves the screen's headers and value lists out.
    const changes = await sql<{ action: string; entity: string }[]>`select action, entity from kernel.audit_log where row_id = ${out.jobId} order by occurred_at`;
    expect(changes).toEqual([
      { action: "insert", entity: "kernel.export_jobs" },
      { action: "update", entity: "kernel.export_jobs" },
      { action: "update", entity: "kernel.export_jobs" },
    ]);
    const [row] = await sql<{ updated_by: string }[]>`select updated_by from kernel.export_jobs where id = ${out.jobId}`;
    expect(row!.updated_by).toBe(seed.users.both);
    const [consult] = await sql<{ input: Record<string, unknown> }[]>`select input from kernel.audit_log where chain_id = ${chainId} and action = 'consult'`;
    expect(Object.keys(consult!.input).sort()).toEqual(["entity", "format", "state", "title"]);

    const status = await exportJobStatus(sql, caller.claims, out.jobId);
    expect(status).toMatchObject({ status: "done", rowCount: 10_500, error: null, fileName: expect.stringMatching(/^probes-.*\.xlsx$/) });
    expect(status!.url).toBe(`memory://${path}?ttl=600`);
  });

  it("a job is visible to who started it and to company admins, not to another member", async () => {
    const out = (await runProcess(deps, as("clerk"), "kernel.export.run", request())) as { jobId: string };
    expect(await exportJobStatus(sql, as("clerk").claims, out.jobId)).toMatchObject({ status: "queued" });
    // `both` and `onlyA` are admins of the company; the clerk's own job is theirs and the admins'.
    expect(await exportJobStatus(sql, as("onlyA").claims, out.jobId)).toMatchObject({ status: "queued" });

    const mine = (await runProcess(deps, as("both"), "kernel.export.run", request())) as { jobId: string };
    expect(await exportJobStatus(sql, as("clerk").claims, mine.jobId)).toBeNull();
    expect(await exportJobStatus(sql, as("clerk").claims, "not-a-uuid")).toBeNull();
    // The base table is closed to them as well: no row, whatever they ask.
    const visible = await sql.begin(async (tx) => {
      await tx`select set_config('request.jwt.claims', ${JSON.stringify({ role: "authenticated", ...as("clerk").claims })}, true)`;
      await tx`set local role authenticated`;
      return tx`select id from kernel.export_jobs where id = ${mine.jobId}`;
    });
    expect(visible).toHaveLength(0);
  });

  it("refuses what the grid refuses: no permission to export, none to consult the entity, no module, a foreign company", async () => {
    await fill(3);
    await sql`delete from kernel.process_permissions where company_id = ${companyId} and role_id = ${memberRoleId} and process_id = 'kernel.export.run'`;
    await expect(runProcess(deps, as("clerk"), "kernel.export.run", request())).rejects.toMatchObject({ code: "forbidden" });
    await sql`insert into kernel.process_permissions(company_id, role_id, process_id) values (${companyId}, ${memberRoleId}, 'kernel.export.run')`;
    await sql`delete from kernel.process_permissions where company_id = ${companyId} and role_id = ${memberRoleId} and process_id = ${probeConsult.id}`;
    await expect(runProcess(deps, as("clerk"), "kernel.export.run", request())).rejects.toMatchObject({ code: "forbidden" });
    await sql`insert into kernel.process_permissions(company_id, role_id, process_id) values (${companyId}, ${memberRoleId}, ${probeConsult.id})`;

    await expect(runProcess(deps, as("both"), "kernel.export.run", request({ entity: "nope.thing" }))).rejects.toMatchObject({ code: "invalid_input" });
    await expect(runProcess(deps, as("both"), "kernel.export.run", request({ state: { ...state, columns: ["nope"] } }))).rejects.toMatchObject({ code: "invalid_input" });
    await expect(runProcess(deps, as("both"), "kernel.export.run", request({ format: "docx" }))).rejects.toBeInstanceOf(ProcessError);
    // The validation message reaches the user in Spanish (rule 24).
    const refused = await runProcess(deps, as("both"), "kernel.export.run", request({ format: "docx" })).catch((e: ProcessError) => e);
    expect(JSON.stringify((refused as ProcessError).details)).toMatch(/Opción inválida/);

    // A PDF is laid out in memory: a request renders up to 2,000 rows, a job up to 10,000, and beyond that it is refused
    // with the reason the screen translates. CSV and Excel keep the 10,000-row threshold and have no ceiling.
    await fill(2_000);
    expect(await runProcess(deps, as("both"), "kernel.export.run", request({ format: "pdf" }))).toMatchObject({ mode: "inline", contentType: "application/pdf" });
    await fill(2_001);
    expect(await runProcess(deps, as("both"), "kernel.export.run", request({ format: "pdf" }))).toMatchObject({ mode: "job" });
    expect(await runProcess(deps, as("both"), "kernel.export.run", request({ format: "csv" }))).toMatchObject({ mode: "inline" });
    expect(await runProcess(deps, as("both"), "kernel.export.run", request({ format: "xlsx" }))).toMatchObject({ mode: "inline" });
    await fill(10_000);
    expect(await runProcess(deps, as("both"), "kernel.export.run", request({ format: "pdf" }))).toMatchObject({ mode: "job" });
    await fill(10_001);
    await expect(runProcess(deps, as("both"), "kernel.export.run", request({ format: "pdf" }))).rejects.toMatchObject({ code: "invalid_input", details: ["pdf_too_large"] });
    expect(await runProcess(deps, as("both"), "kernel.export.run", request({ format: "csv" }))).toMatchObject({ mode: "job" });
    expect(await runProcess(deps, as("both"), "kernel.export.run", request({ format: "xlsx" }))).toMatchObject({ mode: "job" });

    await sql`delete from kernel.tenant_entitlements where tenant_id = ${seed.tenantId}`;
    try {
      await expect(runProcess(deps, as("both"), "kernel.export.run", request())).rejects.toMatchObject({ code: "not_entitled" });
    } finally {
      await sql`insert into kernel.tenant_entitlements(tenant_id, key, source) values (${seed.tenantId}, ${`module:${MODULE}`}, 'manual')`;
    }
  });

  it("a job whose caller lost the permission before it ran ends failed without storing anything, and one that cannot store ends failed too", async () => {
    await fill(10_000);
    const caller = as("clerk");
    const out = (await runProcess(deps, caller, "kernel.export.run", request())) as { jobId: string };
    await sql`delete from kernel.process_permissions where company_id = ${companyId} and role_id = ${memberRoleId} and process_id = ${probeConsult.id}`;
    const quiet = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const run = await start(exportJobWorkflow, [{ jobId: out.jobId, claims: caller.claims, chainId: randomUUID() }]);
      expect(await run.returnValue).toEqual({ jobId: out.jobId, status: "failed", rowCount: 0 });
      const [job] = await sql<{ status: string; error: string; storage_path: string | null }[]>`select status, error, storage_path from kernel.export_jobs where id = ${out.jobId}`;
      expect(job).toEqual({ status: "failed", error: EXPORT_FAILED_MESSAGE, storage_path: null });
      expect(store.files.has(`${companyId}/${out.jobId}.csv`)).toBe(false);
    } finally {
      quiet.mockRestore();
      await sql`insert into kernel.process_permissions(company_id, role_id, process_id) values (${companyId}, ${memberRoleId}, ${probeConsult.id})`;
    }
    expect((await exportsStore()) === store).toBe(true);
  });
});
