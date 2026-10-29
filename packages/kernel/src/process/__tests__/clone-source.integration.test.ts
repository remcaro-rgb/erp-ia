import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { syncRegistry } from "../../admin/sync";
import { seedTenant, testDb } from "../../db/test-db";
import { kernelModule } from "../../module/kernel-module";
import { loadModules } from "../../module/loader";
import { defineEntity, Registry } from "../../registry";
import { maskedViewSql } from "../../security/masked-views";
import type { Caller } from "../context";
import { defineProcess } from "../define";
import { ProcessError } from "../errors";
import { runProcess } from "../run";

// The source of a clone (rule 37, design §22.13; final review M-5): runProcess itself checks, as the caller and in the
// run's transaction before the handler, that `sourceRowId` names a record of the created entity the caller sees (a role
// of theirs may consult the entity, and its masked view shows the row). Any other source is `not_found` at the gate,
// whichever channel calls; nothing is created. A source on a process that creates nothing stays `invalid_input`.

const PROBE = defineEntity({
  id: "kernel.clone_probe",
  module: "kernel",
  schema: "kernel",
  table: "clone_probe",
  label: "entity.kernel.clone_probe",
  displayField: "name",
  defaultSort: { field: "name", dir: "asc" },
  fields: [{ name: "name", type: "text", label: "field.kernel.clone_probe.name" }],
});

const probeCreate = defineProcess({
  id: "kernel.clone_probe.create",
  module: "kernel",
  kind: "create",
  description: "Crea un registro de prueba de la clonación",
  input: z.object({ name: z.string().min(1) }),
  output: z.object({ id: z.string() }),
  handler: async (ctx, input) => {
    const [row] = await ctx.tx<{ id: string }[]>`insert into kernel.clone_probe (company_id, name) values (${ctx.companyId}, ${input.name}) returning id`;
    return { id: row!.id };
  },
});

const probeUpdate = defineProcess({
  id: "kernel.clone_probe.update",
  module: "kernel",
  kind: "update",
  description: "Cambia un registro de prueba de la clonación",
  input: z.object({ id: z.uuid(), name: z.string().min(1) }),
  output: z.object({ id: z.string() }),
  handler: async (ctx, input) => {
    await ctx.tx`update kernel.clone_probe set name = ${input.name} where id = ${input.id}`;
    return { id: input.id };
  },
});

const probeConsult = defineProcess({
  id: "kernel.clone_probe.consult",
  module: "kernel",
  kind: "consult",
  description: "Consulta los registros de prueba de la clonación",
  input: z.object({ id: z.uuid() }),
  output: z.object({}).passthrough(),
  handler: async (ctx, input) => {
    const [row] = await ctx.tx`select * from kernel.v_clone_probe where id = ${input.id}`;
    if (!row) throw new ProcessError("not_found", "no such record");
    return row;
  },
});

describe("runProcess verifies the source of a clone", () => {
  let sql: ReturnType<typeof testDb>;
  let seed: Awaited<ReturnType<typeof seedTenant>>;
  let other: Awaited<ReturnType<typeof seedTenant>>;
  let registry: Registry;
  let companyId: string;
  let admin: Caller;
  let member: Caller;
  let ownId: string;
  let foreignId: string;

  const run = (caller: Caller, processId: string, input: unknown, sourceRowId?: string) => runProcess({ sql, registry }, caller, processId, input, sourceRowId ? { sourceRowId } : {});
  const refusal = (promise: Promise<unknown>) => promise.then(() => null, (error: unknown) => error);
  const count = async () => (await sql<{ n: number }[]>`select count(*)::int as n from kernel.clone_probe where company_id = ${companyId}`)[0]!.n;

  beforeAll(async () => {
    sql = testDb();
    const [exists] = await sql<{ exists: boolean }[]>`select to_regclass('kernel.clone_probe') is not null as exists`;
    if (exists!.exists) {
      await sql`drop view if exists kernel.v_clone_probe`;
      await sql`drop table kernel.clone_probe`;
    }
    await sql`create table kernel.clone_probe (id uuid primary key default kernel.uuid_v7(), company_id uuid not null, name text)`;
    await sql`select kernel.enable_company_rls('kernel', 'clone_probe')`;
    await sql`grant select, insert, update on kernel.clone_probe to authenticated`;
    await sql.unsafe(maskedViewSql(PROBE));

    registry = new Registry();
    loadModules(registry, [kernelModule]);
    registry.registerEntity(PROBE);
    for (const process of [probeCreate, probeUpdate, probeConsult]) registry.registerProcess(process);

    seed = await seedTenant(sql, { companies: 1, entitlements: [], users: [{ name: "member", companies: [0], role: "member" }] });
    other = await seedTenant(sql, { companies: 1, entitlements: [] });
    companyId = seed.companies[0]!.id;
    await syncRegistry(sql, registry);
    for (const company of [seed.companies[0]!, other.companies[0]!]) await sql`select kernel.seed_company_defaults(${company.id})`;
    // The member may create probes, not consult them.
    await sql`insert into kernel.process_permissions(company_id, role_id, process_id) values (${companyId}, ${seed.companies[0]!.memberRoleId}, 'kernel.clone_probe.create')`;
    admin = { claims: seed.claimsFor(seed.users.both, companyId), origin: "ui" };
    member = { claims: seed.claimsFor(seed.users.member!, companyId), origin: "ui" };
    const otherAdmin: Caller = { claims: other.claimsFor(other.users.both, other.companies[0]!.id), origin: "ui" };

    ({ id: ownId } = (await run(admin, "kernel.clone_probe.create", { name: "Origen" })) as { id: string });
    ({ id: foreignId } = (await run(otherAdmin, "kernel.clone_probe.create", { name: "De otra organización" })) as { id: string });
  });

  afterAll(async () => {
    await sql`delete from kernel.clone_probe where company_id = any(${[companyId, other.companies[0]!.id]}::uuid[])`;
    await sql`delete from kernel.process_permissions where company_id = ${companyId}`;
    await seed.cleanup();
    await other.cleanup();
    await sql.end();
  });

  it("accepts a source the caller sees and records it", async () => {
    const { id } = (await run(admin, "kernel.clone_probe.create", { name: "Copia" }, ownId)) as { id: string };
    const audit = await sql<{ source_row_id: string | null }[]>`
      select source_row_id from kernel.audit_log where row_id = ${id} and process_id = 'kernel.clone_probe.create'`;
    expect(audit.length).toBeGreaterThan(0);
    expect(audit.every((row) => row.source_row_id === ownId)).toBe(true);
  });

  it("refuses a source of another organization, a record that does not exist, and creates nothing", async () => {
    const before = await count();
    for (const source of [foreignId, "0197a1b2-0000-7000-8000-00000000beef"]) {
      const refused = await refusal(run(admin, "kernel.clone_probe.create", { name: "Copia ajena" }, source));
      expect(refused).toBeInstanceOf(ProcessError);
      expect(refused).toMatchObject({ code: "not_found", stage: "gate", details: ["El registro de origen no existe o no es visible"] });
    }
    // A dry run (the import preview) is refused the same way.
    const dry = await refusal(runProcess({ sql, registry }, admin, "kernel.clone_probe.create", { name: "Ensayo" }, { sourceRowId: foreignId, dryRun: true }));
    expect(dry).toMatchObject({ code: "not_found", stage: "gate" });
    expect(await count()).toBe(before);
  });

  it("refuses a source the caller may not consult, though their roles may create; consulting is enough to clone", async () => {
    const before = await count();
    const refused = await refusal(run(member, "kernel.clone_probe.create", { name: "Copia sin consulta" }, ownId));
    expect(refused).toMatchObject({ code: "not_found", stage: "gate" });
    expect(await count()).toBe(before);
    // Without a source the same caller creates.
    await run(member, "kernel.clone_probe.create", { name: "Nuevo" });
    await sql`insert into kernel.process_permissions(company_id, role_id, process_id) values (${companyId}, ${seed.companies[0]!.memberRoleId}, 'kernel.clone_probe.consult')`;
    try {
      const { id } = (await run(member, "kernel.clone_probe.create", { name: "Copia con consulta" }, ownId)) as { id: string };
      expect(id).not.toBe(ownId);
    } finally {
      await sql`delete from kernel.process_permissions where company_id = ${companyId} and role_id = ${seed.companies[0]!.memberRoleId} and process_id = 'kernel.clone_probe.consult'`;
    }
  });

  it("still refuses a source on a process that creates nothing, and one that is not a record id", async () => {
    expect(await refusal(run(admin, "kernel.clone_probe.update", { id: ownId, name: "Otro" }, ownId))).toMatchObject({ code: "invalid_input", stage: "gate" });
    expect(await refusal(runProcess({ sql, registry }, admin, "kernel.clone_probe.create", { name: "X" }, { sourceRowId: "no-es-un-id" }))).toMatchObject({ code: "invalid_input" });
  });
});
