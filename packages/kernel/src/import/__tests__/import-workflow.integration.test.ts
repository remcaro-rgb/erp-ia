import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { start } from "workflow/api";
import { z } from "zod";
import { ensureRoleProbe, seedTenant, testDb, type SeededTenant } from "../../db/test-db";
import { MemoryFileStore, setFileStore } from "../../files/store";
import { defineModule } from "../../module/define";
import { kernelModule } from "../../module/kernel-module";
import { loadModules } from "../../module/loader";
import { defineProcess } from "../../process/define";
import { defineEntity, registry } from "../../registry";
import { IMPORT_PROCESSES } from "../processes";
import { runImport } from "../run";
import { submitImport } from "../submit";

// The import workflow under the Workflow runtime (@workflow/vitest compiles "use workflow" / "use step" and runs
// the run in-process): what the import route's `start(runImport, …)` does. A stub entity over the test table
// kernel.role_probe stands in for a module's entity.

const MODULE = `wfimp${randomUUID().slice(0, 6)}`;
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
const probeCreate = defineProcess({
  id: `${MODULE}.probe.create`,
  module: MODULE,
  kind: "create",
  description: "crea un probe",
  input: z.object({ secret: z.string().min(2) }),
  output: z.object({ id: z.string() }),
  handler: async (ctx, input) => {
    const [row] = await ctx.tx<{ id: string }[]>`insert into kernel.role_probe(company_id, secret) values (${ctx.companyId}, ${input.secret}) returning id`;
    return { id: row!.id };
  },
});

describe("import workflow", () => {
  const sql = testDb();
  const store = new MemoryFileStore();
  let seed: SeededTenant;
  let companyId: string;

  beforeAll(async () => {
    await ensureRoleProbe(sql);
    await sql`grant insert on kernel.role_probe to authenticated`;
    seed = await seedTenant(sql, { companies: 1, entitlements: [`module:${MODULE}`] });
    companyId = seed.companies[0]!.id;
    loadModules(registry, [
      kernelModule,
      defineModule({ id: MODULE, version: "1", dependsOn: [], entities: [probe], processes: [probeCreate], features: [], events: { emits: [], consumes: {} }, navigation: [] }),
    ]);
    for (const id of [probeCreate.id, "kernel.attachment.add", ...IMPORT_PROCESSES.map((p) => p.id)]) {
      await sql`insert into kernel.process_permissions(company_id, role_id, process_id) values (${companyId}, ${seed.companies[0]!.adminRoleId}, ${id})`;
    }
    setFileStore(store);
  });

  afterAll(async () => {
    setFileStore(undefined);
    await sql`delete from kernel.step_up_verifications where company_id = ${companyId}`;
    await sql`delete from kernel.process_permissions where company_id = ${companyId}`;
    await sql`delete from kernel.role_probe where company_id = ${companyId}`;
    await seed.cleanup();
    await sql.end();
  });

  it("start(runImport) creates the valid rows, records the counts and attaches errores.csv", async () => {
    const claims = seed.claimsFor(seed.users.both, companyId);
    const stepUpToken = randomUUID();
    await sql`insert into kernel.step_up_verifications(user_id, company_id, token) values (${seed.users.both}, ${companyId}, ${stepUpToken})`;
    const bytes = new TextEncoder().encode("Secreto\nuno\nx\ndos\n");
    const ids = await submitImport({ sql, registry }, { claims, origin: "ui", stepUpToken }, { entity: probe.id, fileName: "probes.csv", bytes });

    const run = await start(runImport, [{ ...ids, claims, labels: { secret: "Secreto" } }]);
    const summary = await run.returnValue;
    expect(summary).toMatchObject({ status: "done", total: 3, created: 2, rejected: 1, summary: "2 creadas · 1 rechazada" });
    expect(await run.status).toBe("completed");

    const secrets = await sql<{ secret: string }[]>`select secret from kernel.role_probe where company_id = ${companyId} order by secret`;
    expect(secrets.map((s) => s.secret)).toEqual(["dos", "uno"]);
    const [row] = await sql`select status, rows_total, rows_ok, rows_failed, errors_attachment_id from kernel.imports where id = ${ids.importId}`;
    expect(row).toMatchObject({ status: "done", rows_total: 3, rows_ok: 2, rows_failed: 1 });
    const [errors] = await sql<{ storage_path: string }[]>`select storage_path from kernel.attachments where id = ${row!.errors_attachment_id}`;
    const lines = new TextDecoder().decode(await store.get(errors!.storage_path)).trimEnd().split("\r\n");
    expect(lines).toEqual(["fila;error;Secreto", "3;Secreto: mínimo 2 caracteres;x"]);
  });
});
