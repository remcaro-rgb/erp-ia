import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { testDb, seedTenant, ensureRoleProbe, ROLE_PROBE } from "../db/test-db";
import { withClaims } from "../db/client";
import { Registry } from "../registry";
import { loadModules } from "../module/loader";
import { kernelModule } from "../module/kernel-module";
import { runProcess } from "../process/run";
import { registerVerifier, unregisterVerifier } from "../verify";
import type { Caller } from "../process/context";

// External verification hooks (design §5.16, rule 11): with no provider the request is queued and the UI
// shows "en cola"; with one the adapter's answer is stored.

describe("verify", () => {
  let sql: ReturnType<typeof testDb>;
  let seed: Awaited<ReturnType<typeof seedTenant>>;
  let registry: Registry;
  let admin: Caller;
  let cashier: Caller;
  let otherCompanyAdmin: Caller;
  let recordId: string;
  let otherRecordId: string;
  const companyIds = () => seed.companies.map((c) => c.id);
  const run = (caller: Caller, id: string, input: unknown) => runProcess({ sql, registry }, caller, id, input);
  const request = (caller: Caller, over: Record<string, unknown> = {}) =>
    run(caller, "kernel.verify.request", { kind: "email", value: "ana@exito.com", entity: "kernel.role_probe", recordId, ...over });

  beforeAll(async () => {
    sql = testDb();
    await ensureRoleProbe(sql);
    seed = await seedTenant(sql, { companies: 2, users: [{ name: "cashier", companies: [0], role: "member" }] });
    registry = new Registry();
    loadModules(registry, [kernelModule]);
    registry.registerEntity(ROLE_PROBE);
    admin = { claims: seed.claimsFor(seed.users.both, seed.companies[0]!.id), origin: "ui" };
    cashier = { claims: seed.claimsFor(seed.users.cashier!, seed.companies[0]!.id), origin: "ui" };
    otherCompanyAdmin = { claims: seed.claimsFor(seed.users.both, seed.companies[1]!.id), origin: "ui" };
    for (const company of seed.companies) {
      for (const process of ["kernel.verify.request", "kernel.verify.status"]) {
        await sql`insert into kernel.process_permissions(company_id, role_id, process_id) values (${company.id}, ${company.adminRoleId}, ${process})`;
      }
    }
    recordId = (await sql`insert into kernel.role_probe(company_id, secret) values (${seed.companies[0]!.id}, 's') returning id`)[0]!.id;
    otherRecordId = (await sql`insert into kernel.role_probe(company_id, secret) values (${seed.companies[1]!.id}, 's') returning id`)[0]!.id;
  });
  afterEach(async () => {
    unregisterVerifier("fake-mail");
    await sql`delete from kernel.verifiers where company_id = any(${companyIds()}::uuid[])`;
  });
  afterAll(async () => {
    await sql`delete from kernel.role_probe where company_id = any(${companyIds()}::uuid[])`;
    await sql`delete from kernel.process_permissions where company_id = any(${companyIds()}::uuid[])`;
    await seed.cleanup();
    await sql.end();
  });

  it("verify('email', x) with no provider inserts a verification_request with status queued", async () => {
    const out = await request(admin);
    expect(out).toMatchObject({ status: "queued", provider: null });
    const [row] = await sql`select * from kernel.verification_requests where id = ${out.id}`;
    expect(row).toMatchObject({
      company_id: seed.companies[0]!.id,
      kind: "email",
      value: "ana@exito.com",
      entity: "kernel.role_probe",
      record_id: recordId,
      status: "queued",
      provider: null,
      created_by: seed.users.both,
    });
    // A verifier row without a provider is the same as none.
    await sql`insert into kernel.verifiers(company_id, kind, provider) values (${seed.companies[0]!.id}, 'email', null)`;
    expect(await request(admin, { value: "otra@exito.com" })).toMatchObject({ status: "queued" });
  });

  it("asking again for the same datum of the same record while it is queued returns that request and inserts nothing", async () => {
    const first = await request(admin, { value: "dedupe@exito.com" });
    const again = await request(admin, { value: "dedupe@exito.com" });
    expect(again).toEqual(first);
    expect((await sql`select 1 from kernel.verification_requests where record_id = ${recordId} and value = 'dedupe@exito.com'`).length).toBe(1);
    // Another datum, kind or record is another request.
    expect((await request(admin, { value: "otro-dedupe@exito.com" })).id).not.toBe(first.id);
    expect((await request(admin, { kind: "phone", value: "+576015550000" })).id).not.toBe(first.id);
    // A provider that can answer is asked, whatever is queued.
    registerVerifier("fake-mail", { verify: async () => ({ ok: true }) });
    await sql`insert into kernel.verifiers(company_id, kind, provider) values (${seed.companies[0]!.id}, 'email', 'fake-mail')`;
    const answered = await request(admin, { value: "dedupe@exito.com" });
    expect(answered).toMatchObject({ status: "verified", provider: "fake-mail" });
    expect(answered.id).not.toBe(first.id);
  });

  it("status answers the latest request for the record, kind and value, or null", async () => {
    const status = (over: Record<string, unknown> = {}) =>
      run(admin, "kernel.verify.status", { kind: "email", value: "luis@exito.com", entity: "kernel.role_probe", recordId, ...over });
    expect(await status()).toBeNull();
    await request(admin, { value: "luis@exito.com" });
    expect(await status()).toMatchObject({ status: "queued", provider: null });
    expect(await status({ value: "otro@exito.com" })).toBeNull();
    expect(await status({ kind: "phone" })).toBeNull();
    // Once a provider exists the newest request wins.
    registerVerifier("fake-mail", { verify: async () => ({ ok: true }) });
    await sql`insert into kernel.verifiers(company_id, kind, provider) values (${seed.companies[0]!.id}, 'email', 'fake-mail')`;
    await request(admin, { value: "luis@exito.com" });
    expect(await status()).toMatchObject({ status: "verified", provider: "fake-mail" });
  });

  it("with a provider the adapter's answer is stored; an adapter that fails or is missing never marks verified", async () => {
    await sql`insert into kernel.verifiers(company_id, kind, provider) values (${seed.companies[0]!.id}, 'email', 'fake-mail')`;
    // The provider is configured but its adapter is not installed: the request waits.
    const waiting = await request(admin);
    expect(waiting).toMatchObject({ status: "queued", provider: "fake-mail" });
    const seen: unknown[] = [];
    registerVerifier("fake-mail", {
      verify: async (kind, value) => {
        seen.push([kind, value]);
        if (value === "boom@exito.com") throw new Error("provider down");
        return value.startsWith("bad") ? { ok: false, detail: { reason: "mailbox not found" } } : { ok: true, detail: { score: 0.98 } };
      },
    });
    expect(await request(admin, { value: "ana@exito.com" })).toMatchObject({ status: "verified", provider: "fake-mail" });
    expect(await request(admin, { value: "bad@exito.com" })).toMatchObject({ status: "failed" });
    const crashed = await request(admin, { value: "boom@exito.com" });
    expect(crashed.status).toBe("failed");
    expect(seen).toEqual([["email", "ana@exito.com"], ["email", "bad@exito.com"], ["email", "boom@exito.com"]]);
    const rows = await sql`select value, status, result from kernel.verification_requests where record_id = ${recordId} and provider = 'fake-mail' and value in ('ana@exito.com', 'bad@exito.com', 'boom@exito.com') order by created_at, id`;
    expect(rows.map((r) => [r.value, r.status])).toEqual([["ana@exito.com", "queued"], ["ana@exito.com", "verified"], ["bad@exito.com", "failed"], ["boom@exito.com", "failed"]]);
    expect(rows[1]!.result).toEqual({ score: 0.98 });
    expect(rows[2]!.result).toEqual({ reason: "mailbox not found" });
    expect(rows[3]!.result).toEqual({ error: "provider down" });
  });

  it("refuses a malformed value, an unknown entity or kind, and a record the caller does not see", async () => {
    await expect(request(admin, { value: "no-es-correo" })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(request(admin, { kind: "phone", value: "3001234567" })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(request(admin, { kind: "fax" })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(request(admin, { entity: "kernel.nada" })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(request(admin, { recordId: otherRecordId })).rejects.toMatchObject({ code: "not_found" });
    expect(await request(admin, { kind: "phone", value: "+573001234567" })).toMatchObject({ status: "queued" });
    expect(await request(admin, { kind: "document", value: "31 900373115" })).toMatchObject({ status: "queued" });
    expect((await sql`select 1 from kernel.verification_requests where company_id = ${seed.companies[0]!.id} and value in ('no-es-correo', '3001234567')`).length).toBe(0);
  });

  it("needs the kernel.verify.request permission", async () => {
    await expect(request(cashier)).rejects.toMatchObject({ code: "forbidden" });
  });

  it("requests are written only through the process and are private to the company", async () => {
    await request(admin, { value: "privado@exito.com" });
    await expect(
      withClaims(sql, admin.claims, (tx) => tx`insert into kernel.verification_requests(company_id, kind, value, entity, record_id, status) values (${seed.companies[0]!.id}, 'email', 'x@y.co', 'kernel.role_probe', ${recordId}, 'verified')`),
    ).rejects.toThrow(/row-level security/);
    const seen = await withClaims(sql, otherCompanyAdmin.claims, (tx) => tx`select 1 from kernel.verification_requests where value = 'privado@exito.com'`);
    expect(seen).toHaveLength(0);
  });

  it("only the admin chooses a provider", async () => {
    // Inside kernel.verifier.set (0021); a member is refused there too.
    const inProcess = <T,>(fn: (tx: Parameters<Parameters<typeof withClaims>[2]>[0]) => Promise<T>) => async (tx: Parameters<Parameters<typeof withClaims>[2]>[0]) => {
      await tx`select set_config('erp.audit_process_id', 'kernel.verifier.set', true)`;
      return fn(tx);
    };
    await expect(
      withClaims(sql, cashier.claims, inProcess((tx) => tx`insert into kernel.verifiers(company_id, kind, provider) values (${seed.companies[0]!.id}, 'email', 'fake-mail')`)),
    ).rejects.toThrow(/row-level security/);
    await expect(
      withClaims(sql, admin.claims, (tx) => tx`insert into kernel.verifiers(company_id, kind, provider) values (${seed.companies[0]!.id}, 'phone', 'fake-sms')`),
    ).rejects.toThrow(/row-level security/);
    await withClaims(sql, admin.claims, inProcess((tx) => tx`insert into kernel.verifiers(company_id, kind, provider) values (${seed.companies[0]!.id}, 'phone', 'fake-sms')`));
    const seen = await withClaims(sql, cashier.claims, (tx) => tx`select provider from kernel.verifiers where kind = 'phone'`);
    expect(seen).toEqual([{ provider: "fake-sms" }]);
  });
});
