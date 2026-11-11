import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { VaultSecretStore } from "@erp/infra";
import { withClaims } from "../db/client";
import { seedTenant, testDb } from "../db/test-db";

// The Vault-backed secret store (plan 2B Task 19; rule 12: DIAN certificates and provider keys live in Supabase Vault; Task 5 ruling):
// migration 0099's service-role wrappers around vault.create_secret / vault.update_secret / vault.decrypted_secrets. A secret is named
// `dian/<companyId>/<certificate | certificate-password | software-pin>` of an existing company; nothing else is stored. The authenticated
// role (a signed-in user, the assistant) can neither call the wrappers nor read the vault, and no view, audit row or log line carries a value.

let sql: ReturnType<typeof testDb>;
let seed: Awaited<ReturnType<typeof seedTenant>>;
let store: VaultSecretStore;
let companyId: string;
const VALUE = `secreto-${Math.random().toString(36).slice(2)}-ñandú`;
const name = (kind: string) => `dian/${companyId}/${kind}`;

beforeAll(async () => {
  sql = testDb();
  seed = await seedTenant(sql, { companies: 1 });
  companyId = seed.companies[0]!.id;
  store = new VaultSecretStore(sql);
});

afterAll(async () => {
  await sql`delete from vault.secrets where name like ${`dian/${companyId}/%`}`;
  await seed.cleanup();
  await sql.end();
});

describe("VaultSecretStore over the 0099 wrappers", () => {
  it("stores, reads, rotates (same secret, new value) and deletes a company's secret", async () => {
    expect(await store.get(name("software-pin"))).toBeNull();
    await store.set(name("software-pin"), VALUE);
    expect(await store.get(name("software-pin"))).toBe(VALUE);
    const [first] = await sql<{ id: string }[]>`select id from vault.secrets where name = ${name("software-pin")}`;
    // Rotation updates the same Vault secret: one row per name, the new value read back.
    await store.set(name("software-pin"), `${VALUE}-2`);
    const rows = await sql<{ id: string }[]>`select id from vault.secrets where name = ${name("software-pin")}`;
    expect(rows).toEqual([{ id: first!.id }]);
    expect(await store.get(name("software-pin"))).toBe(`${VALUE}-2`);
    await store.delete(name("software-pin"));
    expect(await store.get(name("software-pin"))).toBeNull();
    // Deleting what is not there is a no-op.
    await store.delete(name("software-pin"));
  });

  it("answers the SHA-256 of a value computed in the database (the value never leaves it), null when there is none (Task 19 fix round 2)", async () => {
    await store.set(name("certificate"), VALUE);
    expect(await store.fingerprint(name("certificate"))).toBe(createHash("sha256").update(VALUE, "utf8").digest("hex"));
    expect(await store.fingerprint(name("software-pin"))).toBeNull();
    await expect(store.fingerprint("dian/x/certificate")).rejects.toThrow(/secret name/);
  });

  it("holds a certificate (base64 of a binary file) byte for byte", async () => {
    const body = Buffer.from(Array.from({ length: 4096 }, (_, i) => i % 256)).toString("base64");
    await store.set(name("certificate"), body);
    expect(await store.get(name("certificate"))).toBe(body);
  });

  it("the value is encrypted at rest: vault.secrets never holds it in clear", async () => {
    await store.set(name("certificate-password"), VALUE);
    const [row] = await sql<{ secret: string }[]>`select secret from vault.secrets where name = ${name("certificate-password")}`;
    expect(row!.secret).not.toContain(VALUE);
  });

  it("refuses names outside dian/<company>/<certificate | certificate-password | software-pin> and unknown companies", async () => {
    for (const bad of ["dian/x/certificate", `dian/${companyId}/otra-cosa`, `bold/${companyId}/certificate`, `dian/${companyId}/certificate/extra`, "dian/00000000-0000-7000-8000-000000000000/certificate"]) {
      await expect(store.set(bad, "x")).rejects.toThrow(/secret name/);
      await expect(store.get(bad)).rejects.toThrow(/secret name/);
    }
  });

  it("the authenticated role cannot call the wrappers nor read the vault (the wrappers are the service role's only)", async () => {
    await store.set(name("software-pin"), VALUE);
    const claims = seed.claimsFor(seed.users.both, companyId);
    await expect(withClaims(sql, claims, (tx) => tx`select kernel.secret_read(${name("software-pin")})`)).rejects.toMatchObject({ code: "42501" });
    await expect(withClaims(sql, claims, (tx) => tx`select kernel.secret_write(${name("software-pin")}, 'robado')`)).rejects.toMatchObject({ code: "42501" });
    await expect(withClaims(sql, claims, (tx) => tx`select kernel.secret_remove(${name("software-pin")})`)).rejects.toMatchObject({ code: "42501" });
    await expect(withClaims(sql, claims, (tx) => tx`select kernel.secret_fingerprint(${name("software-pin")})`)).rejects.toMatchObject({ code: "42501" });
    await expect(withClaims(sql, claims, (tx) => tx`select decrypted_secret from vault.decrypted_secrets`)).rejects.toMatchObject({ code: "42501" });
    await expect(withClaims(sql, claims, (tx) => tx`select secret from vault.secrets`)).rejects.toMatchObject({ code: "42501" });
    for (const fn of ["secret_read(text)", "secret_write(text,text)", "secret_remove(text)", "secret_fingerprint(text)"]) {
      const [grant] = await sql<{ authenticated: boolean; anon: boolean; service: boolean }[]>`
        select has_function_privilege('authenticated', ${`kernel.${fn}`}, 'EXECUTE') as authenticated,
               has_function_privilege('anon', ${`kernel.${fn}`}, 'EXECUTE') as anon,
               has_function_privilege('service_role', ${`kernel.${fn}`}, 'EXECUTE') as service`;
      expect(grant).toEqual({ authenticated: false, anon: false, service: true });
    }
    // The value is still the service role's.
    expect(await store.get(name("software-pin"))).toBe(VALUE);
  });

  it("a session carrying a user's claims is refused even as the owner (the wrappers are for the server's own connection)", async () => {
    await expect(
      sql.begin(async (tx) => {
        await tx`select set_config('request.jwt.claims', ${JSON.stringify({ sub: seed.users.both, active_company_id: companyId, company_ids: [companyId] })}, true)`;
        return tx`select kernel.secret_read(${name("software-pin")})`;
      }),
    ).rejects.toThrow(/service connection/);
  });

  it("no value reaches a view, the audit or the outbox", async () => {
    await store.set(name("software-pin"), VALUE);
    // Every view of the modules, READ (each row as text), as the service connection sees it.
    const views = await sql<{ schema: string; name: string }[]>`
      select table_schema as schema, table_name as name from information_schema.views
      where table_schema in ('kernel', 'core', 'invoicing', 'accounting', 'sales', 'inventory', 'costing', 'crm')`;
    expect(views.length).toBeGreaterThan(10);
    let read = 0;
    for (const v of views) {
      const found = await sql.begin(async (tx) => {
        await tx`select set_config('request.jwt.claims', ${JSON.stringify(seed.claimsFor(seed.users.both, companyId))}, true)`;
        return tx<{ found: boolean }[]>`select exists (select 1 from ${tx(`${v.schema}.${v.name}`)} as r where r::text like ${`%${VALUE}%`}) as found`;
      }).then((rows) => rows[0]!.found, () => null);
      if (found === null) continue;
      read++;
      expect(found, `${v.schema}.${v.name}`).toBe(false);
    }
    expect(read).toBeGreaterThan(10);
    // No audit row of any company, process or row change, carries it.
    const [audit] = await sql<{ n: number }[]>`select count(*)::int as n from kernel.audit_log where coalesce(input::text, '') like ${`%${VALUE}%`} or coalesce(diff::text, '') like ${`%${VALUE}%`}`;
    expect(audit!.n).toBe(0);
    const [outbox] = await sql<{ n: number }[]>`select count(*)::int as n from kernel.outbox where payload::text like ${`%${VALUE}%`}`;
    expect(outbox!.n).toBe(0);
  });

  it("migrations 0099 and 0106 grant nothing to authenticated or anon", () => {
    for (const file of ["0099_kernel_vault_secrets.sql", "0106_kernel_secret_fingerprint.sql"]) {
      const migration = readFileSync(new URL(`../../../../supabase/migrations/${file}`, import.meta.url), "utf8");
      expect(migration).not.toMatch(/grant[^;]*to[^;]*\b(authenticated|anon|public)\b/i);
    }
  });
});
