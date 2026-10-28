import { randomUUID } from "node:crypto";
import type { Sql } from "postgres";
import { createDb, type JwtClaims } from "./client";
import { defineEntity } from "../registry/entities";
import { maskedViewSql } from "../security/masked-views";

const LOCAL_SUPABASE_URL = "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

/** Service (superuser) connection to the local Supabase database started with `supabase start`. */
export function testDb(): Sql {
  return createDb(process.env.TEST_DATABASE_URL ?? LOCAL_SUPABASE_URL);
}

export interface SeedOptions {
  companies: number;
  /**
   * Extra users; `companies` lists the company indexes they belong to and `role` the role they hold
   * there (default `admin`; `member` is a non-admin role). An empty list creates a user without memberships.
   */
  users?: { name: string; companies: number[]; role?: "admin" | "member" }[];
  /**
   * Tenant-wide entitlement keys to grant (source `manual`, valid from today). Default `['module:test']`,
   * the module the process tests declare; pass `[]` for a tenant that owns nothing.
   */
  entitlements?: string[];
}

export interface SeededCompany {
  id: string;
  adminRoleId: string;
  /** Non-admin, non-system role, for testing what a plain member may not do. */
  memberRoleId: string;
}

export interface SeededTenant {
  tenantId: string;
  companies: SeededCompany[];
  /** `both` belongs to every company, `onlyA` to company 0, plus the extra users by name. */
  users: Record<string, string> & { both: string; onlyA: string };
  claimsFor: (userId: string, activeCompanyId: string) => JwtClaims;
  /** Deletes everything this seed created. */
  cleanup: () => Promise<void>;
}

/**
 * Creates a fresh tenant with unique names and e-mails (so reruns never collide): N companies,
 * an `admin` role per company (with the Colombian required-file defaults) and users with their memberships. Uses the service connection.
 */
export async function seedTenant(sql: Sql, options: SeedOptions): Promise<SeededTenant> {
  const suffix = randomUUID().slice(0, 8);
  const [tenant] = await sql<{ id: string }[]>`insert into kernel.tenants(name) values (${`Tenant ${suffix}`}) returning id`;
  const tenantId = tenant!.id;

  for (const key of options.entitlements ?? ["module:test"]) {
    await sql`insert into kernel.tenant_entitlements(tenant_id, key, source) values (${tenantId}, ${key}, 'manual')`;
  }

  const companies: SeededCompany[] = [];
  for (let i = 0; i < options.companies; i++) {
    const [company] = await sql<{ id: string }[]>`
      insert into kernel.companies(tenant_id, legal_name, tax_id)
      values (${tenantId}, ${`Company ${i} ${suffix} S.A.S.`}, ${`9${suffix}${i}`}) returning id`;
    const [role] = await sql<{ id: string }[]>`
      insert into kernel.roles(company_id, name, is_system) values (${company!.id}, 'admin', true) returning id`;
    const [memberRole] = await sql<{ id: string }[]>`
      insert into kernel.roles(company_id, name, is_system) values (${company!.id}, 'member', false) returning id`;
    await sql`select kernel.seed_required_attachments(${company!.id})`;
    companies.push({ id: company!.id, adminRoleId: role!.id, memberRoleId: memberRole!.id });
  }

  const wanted: NonNullable<SeedOptions["users"]> = [
    { name: "both", companies: companies.map((_, i) => i) },
    { name: "onlyA", companies: [0] },
    ...(options.users ?? []),
  ];
  const users: Record<string, string> = {};
  const memberOf = new Map<string, { companies: number[]; role: "admin" | "member" }>();
  const createdUsers: string[] = [];
  for (const user of wanted) {
    const email = `${user.name.toLowerCase()}-${suffix}@test.local`;
    const [authUser] = await sql<{ id: string }[]>`
      insert into auth.users(id, email, encrypted_password, email_confirmed_at, raw_app_meta_data)
      values (gen_random_uuid(), ${email}, '', now(), '{}'::jsonb) returning id`;
    const id = authUser!.id;
    createdUsers.push(id);
    await sql`insert into kernel.users(id, email, full_name) values (${id}, ${email}, ${`User ${user.name}`})`;
    for (const index of user.companies) {
      const company = companies[index]!;
      const [membership] = await sql<{ id: string }[]>`
        insert into kernel.memberships(user_id, company_id) values (${id}, ${company.id}) returning id`;
      await sql`insert into kernel.membership_roles(membership_id, role_id)
        values (${membership!.id}, ${user.role === "member" ? company.memberRoleId : company.adminRoleId})`;
    }
    users[user.name] = id;
    memberOf.set(id, { companies: user.companies, role: user.role ?? "admin" });
  }

  const companyIds = companies.map((c) => c.id);
  return {
    tenantId,
    companies,
    users: users as SeededTenant["users"],
    claimsFor(userId, activeCompanyId) {
      const member = memberOf.get(userId);
      const memberCompanies = (member?.companies ?? []).map((i) => companies[i]!);
      return {
        sub: userId,
        tenant_id: tenantId,
        company_ids: memberCompanies.map((c) => c.id),
        active_company_id: activeCompanyId,
        role_ids: memberCompanies
          .filter((c) => c.id === activeCompanyId)
          .map((c) => (member?.role === "member" ? c.memberRoleId : c.adminRoleId)),
        locale: "es-419",
      };
    },
    async cleanup() {
      await sql`delete from kernel.export_jobs where company_id = any(${companyIds}::uuid[])`;
      await sql`delete from kernel.imports where company_id = any(${companyIds}::uuid[])`;
      await sql`delete from kernel.process_idempotency where company_id = any(${companyIds}::uuid[])`;
      await sql`delete from kernel.attachments where company_id = any(${companyIds}::uuid[])`;
      await sql`delete from kernel.required_attachments where company_id = any(${companyIds}::uuid[])`;
      await sql`delete from kernel.step_up_verifications where company_id = any(${companyIds}::uuid[])`;
      await sql`delete from kernel.custom_fields where company_id = any(${companyIds}::uuid[])`;
      await sql`delete from kernel.verification_requests where company_id = any(${companyIds}::uuid[])`;
      await sql`delete from kernel.verifiers where company_id = any(${companyIds}::uuid[])`;
      await sql`delete from kernel.company_modules where company_id = any(${companyIds}::uuid[])`;
      await sql`delete from kernel.tenant_entitlements where tenant_id = ${tenantId}`;
      await sql`delete from kernel.membership_roles where membership_id in (select id from kernel.memberships where company_id = any(${companyIds}::uuid[]))`;
      await sql`delete from kernel.memberships where company_id = any(${companyIds}::uuid[])`;
      await sql`delete from kernel.roles where company_id = any(${companyIds}::uuid[])`;
      await sql`delete from kernel.companies where tenant_id = ${tenantId}`;
      await sql`delete from kernel.tenants where id = ${tenantId}`;
      await sql`delete from kernel.users where id = any(${createdUsers}::uuid[])`;
      await sql`delete from auth.users where id = any(${createdUsers}::uuid[])`;
    },
  };
}

/** Test-only entity: a tiny company table with one secret column, read through its masked view. */
export const ROLE_PROBE = defineEntity({
  id: "kernel.role_probe",
  module: "kernel",
  schema: "kernel",
  table: "role_probe",
  label: "entity.kernel.role_probe",
  displayField: "secret",
  defaultSort: { field: "secret", dir: "asc" },
  fields: [{ name: "secret", type: "text", label: "field.secret" }],
});

/**
 * Creates `kernel.role_probe` and its masked view `kernel.v_role_probe` (generated by
 * `maskedViewSql`) when missing. Test-only: no migration ships them. Idempotent.
 */
export async function ensureRoleProbe(sql: Sql): Promise<void> {
  // Checked first so reruns do not print the "already exists, skipping" notice.
  const [probe] = await sql<{ exists: boolean }[]>`select to_regclass('kernel.role_probe') is not null as exists`;
  if (!probe!.exists) {
    await sql`create table kernel.role_probe (
      id uuid primary key default kernel.uuid_v7(),
      company_id uuid not null,
      secret text
    )`;
  }
  await sql`select kernel.enable_company_rls('kernel', 'role_probe')`;
  await sql`grant select on kernel.role_probe to authenticated`;
  await sql.unsafe(maskedViewSql(ROLE_PROBE));
}
