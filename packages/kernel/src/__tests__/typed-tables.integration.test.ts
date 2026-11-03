import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { testDb, seedTenant } from "../db/test-db";
import { withClaims } from "../db/client";

// Audit rows are append-only, so this suite never deletes them; every run seeds its own tenant. The fixture tables live in schema
// `public` and are dropped afterwards (the migration carries no fixtures).
describe("typed entity tables", () => {
  let sql: ReturnType<typeof testDb>;
  let seed: Awaited<ReturnType<typeof seedTenant>>;
  const company = (i: number) => seed.companies[i]!;
  const claims = (i: number) => seed.claimsFor(seed.users.both, company(i).id);
  const suffix = Math.random().toString(36).slice(2, 8);
  const doc = `typed_doc_${suffix}`;
  const mas = `typed_mas_${suffix}`;
  const docEntity = `test.doc_${suffix}`;

  beforeAll(async () => {
    sql = testDb();
    seed = await seedTenant(sql, { companies: 2 });
    for (const t of [doc, mas]) {
      await sql.unsafe(`create table public.${t} (id uuid primary key default kernel.uuid_v7(), company_id uuid not null references kernel.companies (id), name text)`);
    }
    await sql`select kernel.typed_columns('public', ${doc}, 'documento', ${docEntity})`;
    await sql`select kernel.typed_columns('public', ${mas}, 'maestro', ${`test.mas_${suffix}`})`;
  });
  afterAll(async () => {
    await sql.unsafe(`drop table public.${doc}, public.${mas}`);
    await seed.cleanup();
    await sql.end();
  });

  it("snapshots are immutable", async () => {
    const [row] = await sql`insert into kernel.record_snapshots(company_id, entity, record_id, status, payload) values (${company(0).id}, 'core.party', gen_random_uuid(), 'saved', '{}'::jsonb) returning id, seq`;
    await expect(sql`update kernel.record_snapshots set reason = 'x' where id = ${row!.id}`).rejects.toThrow(/record_snapshots_immutable/);
    await expect(sql`delete from kernel.record_snapshots where id = ${row!.id}`).rejects.toThrow(/record_snapshots_immutable/);
    expect(Number(row!.seq)).toBeGreaterThan(0);
  });

  it("truncate is refused on snapshots and mail_log", async () => {
    await expect(sql`truncate kernel.record_snapshots`).rejects.toThrow(/record_snapshots_immutable/);
    await expect(sql`truncate kernel.mail_log`).rejects.toThrow(/mail_log_immutable/);
  });

  it("a forged created_by is refused on snapshots and mail_log", async () => {
    const forged = seed.users.onlyA;
    const asBoth = claims(0);
    await expect(
      withClaims(sql, asBoth, (tx) => tx`insert into kernel.record_snapshots(company_id, entity, record_id, status, payload, created_by) values (${company(0).id}, 'core.party', gen_random_uuid(), 'saved', '{}'::jsonb, ${forged})`),
    ).rejects.toThrow(/row-level security/);
    await expect(
      withClaims(sql, asBoth, (tx) => tx`insert into kernel.mail_log(company_id, entity, record_id, created_by) values (${company(0).id}, 'core.party', gen_random_uuid(), ${forged})`),
    ).rejects.toThrow(/row-level security/);
    const ok = await withClaims(sql, asBoth, (tx) => tx`insert into kernel.mail_log(company_id, entity, record_id) values (${company(0).id}, 'core.party', gen_random_uuid()) returning created_by`);
    expect(ok[0]!.created_by).toBe(seed.users.both);
  });

  it("typed_columns works on a table that already has rows", async () => {
    const t = `typed_pre_${suffix}`;
    await sql.unsafe(`create table public.${t} (id uuid primary key default kernel.uuid_v7(), company_id uuid not null references kernel.companies (id))`);
    try {
      await sql.unsafe(`insert into public.${t}(company_id) values ('${company(0).id}')`);
      await sql`select kernel.typed_columns('public', ${t}, 'documento', ${`test.pre_${suffix}`})`;
      const [old] = await sql.unsafe(`select status, requires_approval, posts from public.${t}`);
      expect(old).toMatchObject({ status: "draft", requires_approval: false, posts: false });
      const [col] = await sql`select column_default from information_schema.columns where table_schema = 'public' and table_name = ${t} and column_name = 'requires_approval'`;
      expect(col!.column_default).toBeNull();
    } finally {
      await sql.unsafe(`drop table public.${t}`);
    }
  });

  it("mail_log only lets status and provider_id change", async () => {
    const [row] = await sql`insert into kernel.mail_log(company_id, entity, record_id, recipients) values (${company(0).id}, 'core.party', gen_random_uuid(), ${["a@x.co"]}) returning id`;
    await sql`update kernel.mail_log set status = 'sent', provider_id = 'p1' where id = ${row!.id}`;
    await expect(sql`update kernel.mail_log set recipients = ${["b@x.co"]} where id = ${row!.id}`).rejects.toThrow(/mail_log_immutable/);
    await expect(sql`delete from kernel.mail_log where id = ${row!.id}`).rejects.toThrow(/mail_log_immutable/);
  });

  it("company B cannot read company A rows in any of the tables", async () => {
    const a = company(0).id;
    await sql`insert into kernel.entity_type_settings(company_id, entity, posts) values (${a}, ${`test.iso_${suffix}`}, true)`;
    await sql`insert into kernel.state_recipients(company_id, entity, status, emails) values (${a}, 'core.party', 'approved', ${["a@x.co"]})`;
    await sql`insert into kernel.record_snapshots(company_id, entity, record_id, status, payload) values (${a}, 'core.party', gen_random_uuid(), 'saved', '{}'::jsonb)`;
    await sql`insert into kernel.mail_log(company_id, entity, record_id) values (${a}, 'core.party', gen_random_uuid())`;
    for (const t of ["entity_type_settings", "state_recipients", "record_snapshots", "mail_log"]) {
      const asA = await withClaims(sql, claims(0), (tx) => tx`select count(*)::int as n from ${tx(`kernel.${t}`)}`);
      const asB = await withClaims(sql, claims(1), (tx) => tx`select count(*)::int as n from ${tx(`kernel.${t}`)}`);
      expect(asA[0]!.n, t).toBeGreaterThan(0);
      expect(asB[0]!.n, t).toBe(0);
    }
  });

  it("only company admins write the settings", async () => {
    const memberClaims = seed.claimsFor(seed.users.onlyA, company(0).id);
    await seed.holdRoles(seed.users.onlyA, company(0).id, [company(0).memberRoleId]);
    await expect(
      withClaims(sql, { ...memberClaims, role_ids: [company(0).memberRoleId] }, (tx) => tx`insert into kernel.entity_type_settings(company_id, entity) values (${company(0).id}, 'test.nope')`),
    ).rejects.toThrow(/row-level security|permission denied/);
  });

  it("the references registry is readable and register_reference is idempotent", async () => {
    await sql`select kernel.register_reference(${docEntity}, 'public', ${doc}, 'id')`;
    await sql`select kernel.register_reference(${docEntity}, 'public', ${doc}, 'id')`;
    const rows = await withClaims(sql, claims(1), (tx) => tx`select * from kernel."references" where entity = ${docEntity}`);
    expect(rows).toHaveLength(1);
    await expect(withClaims(sql, claims(0), (tx) => tx`select kernel.register_reference('a.b', 'x', 'y', 'z')`)).rejects.toThrow(/permission denied/);
    await expect(withClaims(sql, claims(0), (tx) => tx`insert into kernel."references"(entity, ref_schema, ref_table, ref_column) values ('a.b','x','y','z')`)).rejects.toThrow(/permission denied/);
    await sql`delete from kernel."references" where entity = ${docEntity}`;
  });

  it("typed_columns copies the flags at insert and keeps them after the setting changes", async () => {
    const a = company(0).id;
    await sql`insert into kernel.entity_type_settings(company_id, entity, requires_approval, posts) values (${a}, ${docEntity}, true, true)`;
    const [r1] = await sql.unsafe(`insert into public.${doc}(company_id, name) values ('${a}', 'one') returning *`);
    expect(r1).toMatchObject({ status: "draft", requires_approval: true, posts: true });
    await sql`update kernel.entity_type_settings set requires_approval = false, posts = false where company_id = ${a} and entity = ${docEntity}`;
    const [still] = await sql.unsafe(`select requires_approval, posts from public.${doc} where id = '${r1!.id}'`);
    expect(still).toMatchObject({ requires_approval: true, posts: true });
    const [r2] = await sql.unsafe(`insert into public.${doc}(company_id, name) values ('${a}', 'two') returning *`);
    expect(r2).toMatchObject({ requires_approval: false, posts: false });
  });

  it("an explicit value wins over the setting, and no setting means false", async () => {
    const b = company(1).id;
    const [r] = await sql.unsafe(`insert into public.${doc}(company_id, name, requires_approval) values ('${b}', 'x', true) returning *`);
    expect(r).toMatchObject({ requires_approval: true, posts: false });
    const [n] = await sql.unsafe(`insert into public.${doc}(company_id, name) values ('${b}', 'y') returning *`);
    expect(n).toMatchObject({ requires_approval: false, posts: false });
  });

  it("refuses an invalid status, and a maestro refuses posted / voided and has no posts", async () => {
    const a = company(0).id;
    await expect(sql.unsafe(`insert into public.${doc}(company_id, status) values ('${a}', 'bogus')`)).rejects.toThrow(/status_check/);
    await expect(sql.unsafe(`insert into public.${mas}(company_id, status) values ('${a}', 'posted')`)).rejects.toThrow(/status_check/);
    const [m] = await sql.unsafe(`insert into public.${mas}(company_id, name) values ('${a}', 'm') returning *`);
    expect(m).toMatchObject({ status: "draft", is_active: true, requires_approval: false });
    expect("posts" in m!).toBe(false);
    expect(m!.deleted_at).toBeNull();
    const [d] = await sql.unsafe(`insert into public.${doc}(company_id, status) values ('${a}', 'voided') returning status`);
    expect(d!.status).toBe("voided");
  });
});
