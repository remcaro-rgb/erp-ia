import type { Sql } from "postgres";

// What an e2e fixture company leaves behind in the module schemas, found rather than listed (plan 2B Task 14b, fix round 1): every base
// table with a `company_id` column outside the platform schemas, plus the kernel's company tables, except the ones the auth fixture's own
// cleanup removes in its order (companies, memberships, roles) and the append-only audit. The rows go under the replica role, so foreign
// keys and guard triggers do not fire and the order does not matter: a module added later is cleaned without touching this file.

const PLATFORM_SCHEMAS = ["auth", "storage", "realtime", "extensions", "graphql", "graphql_public", "vault", "net", "cron", "pgsodium", "pgsodium_masks", "supabase_functions", "supabase_migrations", "information_schema", "pg_catalog", "pg_toast", "public"];
const KERNEL_KEPT = ["companies", "memberships", "roles"];

/** The `schema.table` names holding rows of a company, discovered in information_schema. */
export async function companyTables(sql: Sql): Promise<string[]> {
  const rows = await sql<{ schema: string; name: string }[]>`
    select c.table_schema as schema, c.table_name as name
    from information_schema.columns c
    join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name and t.table_type = 'BASE TABLE'
    where c.column_name = 'company_id'
      and c.table_schema <> all(${PLATFORM_SCHEMAS}::text[])
      and c.table_schema not like 'pg\\_%'
      and not (c.table_schema = 'kernel' and (c.table_name = any(${KERNEL_KEPT}::text[]) or c.table_name like 'audit%'))
    order by 1, 2`;
  return rows.map((r) => `${r.schema}.${r.name}`);
}

/** Deletes every row of `companyIds` the discovered tables hold, and the tenant's entitlements; returns how many rows went, by table. */
export async function cleanupCompanies(sql: Sql, companyIds: string[], tenantId: string): Promise<Record<string, number>> {
  const tables = await companyTables(sql);
  const deleted: Record<string, number> = {};
  await sql.begin(async (tx) => {
    await tx`set local session_replication_role = replica`;
    for (const table of tables) {
      const result = await tx`delete from ${tx(table)} where company_id = any(${companyIds}::uuid[])`;
      if (result.count > 0) deleted[table] = result.count;
    }
    const entitlements = await tx`delete from kernel.tenant_entitlements where tenant_id = ${tenantId}`;
    if (entitlements.count > 0) deleted["kernel.tenant_entitlements"] = entitlements.count;
  });
  return deleted;
}
