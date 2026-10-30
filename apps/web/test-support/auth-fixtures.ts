import { randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import * as OTPAuth from "otpauth";
import postgres, { type Sql } from "postgres";
import { loginKey, mfaKey, stepUpKey, storedKey } from "../src/lib/auth/limiter-keys";
import { testEnv } from "./env";

// Real users in the local Supabase stack for the auth tests (integration and Playwright): a tenant with
// N companies, a system `admin` role and a plain `member` role per company, and one confirmed Auth user
// holding one of them in every company. Nothing is mocked: sign-in, MFA and the access token hook are the real ones.

export interface AuthFixture {
  tenantId: string;
  companyIds: string[];
  userId: string;
  email: string;
  password: string;
  sql: Sql;
  admin: SupabaseClient;
  cleanup: () => Promise<void>;
}

export function adminClient(): SupabaseClient {
  const env = testEnv();
  return createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
}

export function anonClient(): SupabaseClient {
  const env = testEnv();
  return createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
}

export interface AuthFixtureOptions {
  /** `admin` is the system admin role (it requires MFA); `member` is a plain role. */
  role: "admin" | "member";
  companies?: number;
}

export async function seedAuthUser(options: AuthFixtureOptions): Promise<AuthFixture> {
  const env = testEnv();
  const sql = postgres(env.DATABASE_URL, { max: 2, onnotice: () => {} });
  const admin = adminClient();
  const suffix = randomUUID().slice(0, 8);
  const email = `auth-${suffix}@test.local`;
  const password = `pw-${randomUUID()}`;

  const [tenant] = await sql<{ id: string }[]>`insert into kernel.tenants(name) values (${`Auth tenant ${suffix}`}) returning id`;
  const tenantId = tenant!.id;
  const companyIds: string[] = [];
  const roleIds: string[] = [];
  for (let i = 0; i < (options.companies ?? 1); i++) {
    const [company] = await sql<{ id: string }[]>`
      insert into kernel.companies(tenant_id, legal_name, tax_id)
      values (${tenantId}, ${`Auth company ${i} ${suffix} S.A.S.`}, ${`8${suffix}${i}`}) returning id`;
    const [role] = await sql<{ id: string }[]>`
      insert into kernel.roles(company_id, name, is_system)
      values (${company!.id}, ${options.role}, ${options.role === "admin"}) returning id`;
    companyIds.push(company!.id);
    roleIds.push(role!.id);
  }

  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error || !data.user) throw new Error(`could not create the auth user: ${error?.message}`);
  const userId = data.user.id;
  await sql`insert into kernel.users(id, email, full_name) values (${userId}, ${email}, ${`Auth user ${suffix}`})`;
  for (const [i, companyId] of companyIds.entries()) {
    const [membership] = await sql<{ id: string }[]>`insert into kernel.memberships(user_id, company_id) values (${userId}, ${companyId}) returning id`;
    await sql`insert into kernel.membership_roles(membership_id, role_id) values (${membership!.id}, ${roleIds[i]!})`;
  }

  return {
    tenantId,
    companyIds,
    userId,
    email,
    password,
    sql,
    admin,
    async cleanup() {
      try {
        // The limiter stores each key hashed (final review I2).
        await sql`delete from kernel.auth_attempts where key = any(${[loginKey(email), mfaKey(userId), stepUpKey(userId)].map(storedKey)}::text[])`;
        await sql`delete from kernel.step_up_verifications where user_id = ${userId}`;
        // The outbox is shared by every suite and drained across companies: take this fixture's rows with it.
        await sql`delete from kernel.outbox where company_id = any(${companyIds}::uuid[])`;
        await sql`delete from kernel.outbox_dead_letter where company_id = any(${companyIds}::uuid[])`;
        await sql`delete from kernel.membership_roles where membership_id in (select id from kernel.memberships where user_id = ${userId})`;
        await sql`delete from kernel.memberships where user_id = ${userId}`;
        await sql`delete from kernel.roles where company_id = any(${companyIds}::uuid[])`;
        await sql`delete from kernel.companies where tenant_id = ${tenantId}`;
        await sql`delete from kernel.tenants where id = ${tenantId}`;
        await sql`delete from kernel.users where id = ${userId}`;
        await admin.auth.admin.deleteUser(userId);
      } finally {
        await sql.end({ timeout: 5 });
      }
    },
  };
}

/**
 * The 6-digit code an authenticator app shows for `secret` (base32) right now. Auth accepts the window before and
 * after as well, so a code made just before a 30-second boundary is still valid when it is checked.
 */
export function totpCode(secret: string): string {
  const totp = new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(secret), algorithm: "SHA1", digits: 6, period: 30 });
  return totp.generate({ timestamp: Date.now() });
}

/**
 * Enrols and verifies a TOTP factor for the fixture's user as the user would (Auth has no admin enrolment):
 * password sign-in, `mfa.enroll`, then a code computed from the returned secret. Returns the secret.
 */
export async function enrolTotp(fixture: Pick<AuthFixture, "email" | "password">): Promise<string> {
  const client = anonClient();
  const signedIn = await client.auth.signInWithPassword({ email: fixture.email, password: fixture.password });
  if (signedIn.error) throw new Error(`sign-in failed: ${signedIn.error.message}`);
  const enrolled = await client.auth.mfa.enroll({ factorType: "totp", friendlyName: "test" });
  if (enrolled.error) throw new Error(`enrol failed: ${enrolled.error.message}`);
  const verified = await client.auth.mfa.challengeAndVerify({ factorId: enrolled.data.id, code: totpCode(enrolled.data.totp.secret) });
  if (verified.error) throw new Error(`verify failed: ${verified.error.message}`);
  await client.auth.signOut();
  return enrolled.data.totp.secret;
}

/** Removes every TOTP factor of `userId` (verified or not) through the Auth admin API, as an admin's reset does. */
export async function removeTotpFactors(admin: SupabaseClient, userId: string): Promise<void> {
  const { data, error } = await admin.auth.admin.mfa.listFactors({ userId });
  if (error) throw new Error(`could not list the factors of ${userId}: ${error.message}`);
  for (const factor of data.factors.filter((f) => f.factor_type === "totp")) {
    const removed = await admin.auth.admin.mfa.deleteFactor({ id: factor.id, userId });
    if (removed.error) throw new Error(`could not remove factor ${factor.id}: ${removed.error.message}`);
  }
}

/** The number of verified TOTP factors of `userId`. */
export async function verifiedTotpCount(admin: SupabaseClient, userId: string): Promise<number> {
  const { data, error } = await admin.auth.admin.mfa.listFactors({ userId });
  if (error) throw new Error(`could not list the factors of ${userId}: ${error.message}`);
  return data.factors.filter((f) => f.factor_type === "totp" && f.status === "verified").length;
}
