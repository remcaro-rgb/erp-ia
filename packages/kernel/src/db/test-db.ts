import { randomUUID } from "node:crypto";
import type { Sql } from "postgres";
import { createDb, type JwtClaims } from "./client";

const LOCAL_SUPABASE_URL = "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

/** Service (superuser) connection to the local Supabase database started with `supabase start`. */
export function testDb(): Sql {
  return createDb(process.env.TEST_DATABASE_URL ?? LOCAL_SUPABASE_URL);
}

export interface SeedOptions {
  companies: number;
  /** Extra users; `companies` lists the company indexes they belong to. */
  users?: { name: string; companies: number[] }[];
}

export interface SeededCompany {
  id: string;
  adminRoleId: string;
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
 * an `admin` role per company and users with their memberships. Uses the service connection.
 */
export async function seedTenant(sql: Sql, options: SeedOptions): Promise<SeededTenant> {
  const suffix = randomUUID().slice(0, 8);
  const [tenant] = await sql<{ id: string }[]>`insert into kernel.tenants(name) values (${`Tenant ${suffix}`}) returning id`;
  const tenantId = tenant!.id;

  const companies: SeededCompany[] = [];
  for (let i = 0; i < options.companies; i++) {
    const [company] = await sql<{ id: string }[]>`
      insert into kernel.companies(tenant_id, legal_name, tax_id)
      values (${tenantId}, ${`Company ${i} ${suffix} S.A.S.`}, ${`9${suffix}${i}`}) returning id`;
    const [role] = await sql<{ id: string }[]>`
      insert into kernel.roles(company_id, name, is_system) values (${company!.id}, 'admin', true) returning id`;
    companies.push({ id: company!.id, adminRoleId: role!.id });
  }

  const wanted = [
    { name: "both", companies: companies.map((_, i) => i) },
    { name: "onlyA", companies: [0] },
    ...(options.users ?? []),
  ];
  const users: Record<string, string> = {};
  const memberOf = new Map<string, number[]>();
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
      await sql`insert into kernel.membership_roles(membership_id, role_id) values (${membership!.id}, ${company.adminRoleId})`;
    }
    users[user.name] = id;
    memberOf.set(id, user.companies);
  }

  const companyIds = companies.map((c) => c.id);
  return {
    tenantId,
    companies,
    users: users as SeededTenant["users"],
    claimsFor(userId, activeCompanyId) {
      const memberCompanies = (memberOf.get(userId) ?? []).map((i) => companies[i]!);
      return {
        sub: userId,
        tenant_id: tenantId,
        company_ids: memberCompanies.map((c) => c.id),
        active_company_id: activeCompanyId,
        role_ids: memberCompanies.filter((c) => c.id === activeCompanyId).map((c) => c.adminRoleId),
        locale: "es-419",
      };
    },
    async cleanup() {
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
