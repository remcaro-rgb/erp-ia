import type { Sql } from "postgres";
import { createDb } from "./client";

const LOCAL_SUPABASE_URL = "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

let service: Sql | undefined;

/**
 * The service connection string: `DATABASE_URL`, or the local Supabase database outside production. A production
 * server without it refuses (final review M5) rather than silently reaching for a database that is not there.
 */
export function serviceDbUrl(env: Record<string, string | undefined> = process.env): string {
  if (env.DATABASE_URL) return env.DATABASE_URL;
  if (env.NODE_ENV === "production") {
    throw new Error("DATABASE_URL is required in production: set it to the service connection string of the database");
  }
  return LOCAL_SUPABASE_URL;
}

/**
 * The service (superuser / service-role) connection Workflow steps use, created on first call and
 * shared afterwards. Reads `DATABASE_URL` (see `serviceDbUrl`). Service role stays server-side: inside
 * Workflows and route handlers only (rule 12).
 */
export function getServiceDb(): Sql {
  service ??= createDb(serviceDbUrl());
  return service;
}
