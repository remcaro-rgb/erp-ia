import type { Sql } from "postgres";
import { createDb } from "./client";

const LOCAL_SUPABASE_URL = "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

let service: Sql | undefined;

/**
 * The service (superuser / service-role) connection Workflow steps use, created on first call and
 * shared afterwards. Reads `DATABASE_URL`, falling back to the local Supabase database. Service role
 * stays server-side: inside Workflows and route handlers only (rule 12).
 */
export function getServiceDb(): Sql {
  service ??= createDb(process.env.DATABASE_URL ?? LOCAL_SUPABASE_URL);
  return service;
}
