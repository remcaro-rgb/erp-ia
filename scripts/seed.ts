/**
 * The demo company: `DEMO_SEED=1 pnpm db:seed` (Task 22). LOCAL USE ONLY: it runs only with DEMO_SEED=1 and against a
 * local stack (the CLI stack, or the Docker test stack from its own network or its published ports); the production
 * docker-compose.yml has no seed job, docker-compose.test.yml adds it.
 *
 * Run it after `pnpm db:reset` (which applied the migrations and supabase/seed.sql) on the CLI stack. Idempotent: what
 * exists is kept, what is missing is created. In order:
 *
 *  1. supabase/seed.sql again (idempotent): tenant, company, roles, required files, the starter plan's entitlements.
 *  2. The manifests of the modules the app loads registered in SQL (`syncRegistry`, what the app does at boot) and the
 *     modules core and support enabled for the company (`enableModule`).
 *  3. The Auth users laura@demo.local and marcela@demo.local through the Auth Admin API (never an insert into
 *     auth.users); Laura's bootstrap as the company's admin (her profile, membership and admin role: the only direct
 *     SQL, somebody must be admin before an admin process can run) and her TOTP factor with the documented secret.
 *  4. The company's defaults (`kernel.seed_company_defaults`: every process to admin, the baseline and the consults to
 *     the other roles, confidential fields masked, admin processes sensitive).
 *  5. As Laura, signed in with her password and TOTP code, through the kernel.admin.* processes, each with a fresh
 *     step-up (rules 1, 15): her gerente comercial role, Marcela as a member with the cajero role, the gerente
 *     comercial's writes, credit_limit hidden for the cajero, core.party.deactivate sensitive.
 *  6. As Laura, through core.category.create, core.party.create and core.product.create: 6 categories, 40 parties and
 *     25 products (scripts/demo/data.ts), so audit, outbox and consecutive numbers are real; then the required files
 *     (placeholder PDFs) of 6 parties through kernel.attachment.add, so they are invoice-ready.
 *  7. Two recommendations for Laura, with the evidence computed in SQL (rule 29).
 *
 * The help index is built apart: `pnpm help:index` (the compose `help-index` job).
 */
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import * as OTPAuth from "otpauth";
import type { Sql } from "postgres";
import { co } from "@erp/loc-co";
import { accounting } from "@erp/module-accounting";
import { core } from "@erp/module-core";
import { support } from "@erp/module-support";
import { SupabaseAuthAdmin, SupabaseFileStore, type FileStore } from "@erp/infra";
import {
  enableModule,
  getServiceDb,
  kernelModule,
  loadModules,
  precheckAttachment,
  registerCountryPack,
  Registry,
  runProcess,
  setAuthAdmin,
  syncRegistry,
  type Caller,
  type JwtClaims,
  type RunProcessDeps,
} from "@erp/kernel";
import { CATEGORIES, INVOICE_READY_PARTIES, PARTIES, PRODUCTS } from "./demo/data";
import { ANDRES, DEMO_ACCOUNTS, DEMO_COMPANY_ID, DEMO_ROLE_IDS, LAURA, MARCELA, type DemoAccount } from "./demo/accounts";
import { seedAccounting } from "./demo/accounting";

const ROOT = join(fileURLToPath(import.meta.url), "..", "..");
const SEED_SQL = join(ROOT, "supabase", "seed.sql");

/** The local Supabase CLI stack (`supabase start`): its public demo keys, not secrets. */
const LOCAL = {
  supabaseUrl: "http://127.0.0.1:55321",
  anonKey:
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0",
  serviceKey:
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU",
  databaseUrl: "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
};

export interface SeedTarget {
  supabaseUrl: string;
  databaseUrl: string;
}

export interface SeedEnv extends SeedTarget {
  anonKey: string;
  serviceKey: string;
}

/** The stack to seed: the process environment (as the app and the compose jobs name it) over the CLI stack's defaults. */
export function seedEnv(env: Record<string, string | undefined>): SeedEnv {
  return {
    supabaseUrl: env.SUPABASE_URL ?? env.NEXT_PUBLIC_SUPABASE_URL ?? LOCAL.supabaseUrl,
    anonKey: env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? env.ANON_KEY ?? LOCAL.anonKey,
    serviceKey: env.SUPABASE_SERVICE_ROLE_KEY ?? env.SERVICE_ROLE_KEY ?? LOCAL.serviceKey,
    databaseUrl: env.DATABASE_URL ?? LOCAL.databaseUrl,
  };
}

/** Hosts of a local stack: this machine, and the compose services `kong` and `db` on the stack's own network. */
const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]", "kong", "db"]);
const isLocalHost = (host: string) => LOCAL_HOSTS.has(host) || host.endsWith(".localhost");

/**
 * Throws unless the run asked for the demo explicitly (DEMO_SEED=1) and both the Supabase API and the database are a
 * local stack: the demo accounts have public passwords and must never reach a stack anyone else uses. The owner's
 * hosted development project (2026-10-29, shared and wipeable, demo data only) is the one exception: it takes
 * DEMO_SEED_REMOTE=1 too, so a production URL in the environment can never be seeded by mistake.
 */
export function assertSeedAllowed(target: SeedTarget, env: Record<string, string | undefined>): void {
  if (env.DEMO_SEED !== "1") {
    throw new Error("db:seed creates demo accounts with public passwords: run it only on a local or test stack, with DEMO_SEED=1");
  }
  for (const [what, url] of [["Supabase URL", target.supabaseUrl], ["database URL", target.databaseUrl]] as const) {
    let host: string;
    try {
      host = new URL(url).hostname;
    } catch {
      throw new Error(`db:seed: the ${what} is not a URL`);
    }
    if (!isLocalHost(host) && env.DEMO_SEED_REMOTE !== "1") {
      throw new Error(`db:seed only seeds a local stack (the demo accounts have public passwords); the ${what} points at ${host}. A shared development project the owner may wipe takes DEMO_SEED_REMOTE=1 as well.`);
    }
  }
}

/** The ids supabase/seed.sql writes (the test checks they are the ones scripts/demo/accounts.ts names). */
export function seedSqlIds(): Set<string> {
  return new Set(readFileSync(SEED_SQL, "utf8").match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g) ?? []);
}

/** The 6-digit code an authenticator app shows for `secret` right now. */
export function totpCode(secret: string): string {
  return new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(secret), algorithm: "SHA1", digits: 6, period: 30 }).generate();
}

/** What the gerente comercial may do besides the role defaults (prototype v5 `perms.gerente`). */
export const GERENTE_PROCESSES = [
  "core.party.create",
  "core.party.update",
  "core.product.create",
  "core.product.update",
  "core.category.create",
  "core.category.update",
  "kernel.import.run",
  "support.ticket.create",
];

const noSession = { auth: { persistSession: false, autoRefreshToken: false } } as const;

/** The Auth user of `account`, created through the Admin API when missing; its documented password is set. */
async function ensureAuthUser(sql: Sql, admin: SupabaseClient, account: DemoAccount): Promise<string> {
  const [found] = await sql<{ id: string }[]>`select id from auth.users where lower(email) = lower(${account.email})`;
  let userId = found?.id;
  if (userId) {
    const { error } = await admin.auth.admin.updateUserById(userId, { password: account.password, email_confirm: true });
    if (error) throw new Error(`db:seed: could not reset ${account.email}: ${error.message}`);
  } else {
    const { data, error } = await admin.auth.admin.createUser({ email: account.email, password: account.password, email_confirm: true, user_metadata: { full_name: account.fullName } });
    if (error || !data.user) throw new Error(`db:seed: could not create ${account.email}: ${error?.message}`);
    userId = data.user.id;
  }
  return userId;
}

/** The admin's `kernel.users` row: her name and her mobile (+57), as kernel.admin.user.create writes the others'. */
export function adminProfile(userId: string, account: DemoAccount) {
  return { id: userId, email: account.email, full_name: account.fullName, mobile_cc: "57", mobile: account.mobile };
}

/**
 * The company's first admin: profile, membership and the system admin role, written directly (the bootstrap: the admin
 * processes need an admin to run). Everything else about people goes through kernel.admin.* as this admin. A profile
 * from an earlier run without a mobile gets it; one the admin changed keeps hers.
 */
async function bootstrapAdmin(sql: Sql, userId: string, account: DemoAccount): Promise<void> {
  await sql`
    insert into kernel.users ${sql(adminProfile(userId, account))}
    on conflict (id) do update set mobile_cc = coalesce(kernel.users.mobile_cc, excluded.mobile_cc), mobile = coalesce(kernel.users.mobile, excluded.mobile)`;
  await sql`insert into kernel.memberships (user_id, company_id) values (${userId}, ${DEMO_COMPANY_ID}) on conflict (user_id, company_id) do nothing`;
  const [membership] = await sql<{ id: string }[]>`select id from kernel.memberships where user_id = ${userId} and company_id = ${DEMO_COMPANY_ID}`;
  await sql`insert into kernel.membership_roles (membership_id, role_id) values (${membership!.id}, ${DEMO_ROLE_IDS.admin}) on conflict do nothing`;
}

/** The role ids `userId` holds in the demo company (none when not a member). */
async function rolesOf(sql: Sql, userId: string): Promise<string[] | null> {
  const [membership] = await sql<{ id: string }[]>`select id from kernel.memberships where user_id = ${userId} and company_id = ${DEMO_COMPANY_ID}`;
  if (!membership) return null;
  return (await sql<{ role_id: string }[]>`select role_id from kernel.membership_roles where membership_id = ${membership.id}`).map((r) => r.role_id);
}

/**
 * The account's verified TOTP factor with its documented secret. Auth enrols a factor only for the signed-in user and
 * draws its secret itself: the factor is enrolled as the user would, its secret is replaced by the documented one while
 * it is still unverified (the one write into the auth schema, local stacks only), and it is verified with a code of that
 * secret, which proves Auth accepts it. A factor with another secret is removed through the Admin API first.
 */
async function ensureTotp(sql: Sql, env: SeedEnv, admin: SupabaseClient, account: DemoAccount, userId: string): Promise<void> {
  const secret = account.totpSecret!;
  const factors = await sql<{ id: string; status: string; secret: string | null }[]>`
    select id, status::text as status, secret from auth.mfa_factors where user_id = ${userId} and factor_type = 'totp'`;
  if (factors.some((f) => f.status === "verified" && f.secret === secret)) return;
  for (const factor of factors) {
    const { error } = await admin.auth.admin.mfa.deleteFactor({ id: factor.id, userId });
    if (error) throw new Error(`db:seed: could not remove an old factor of ${account.email}: ${error.message}`);
  }
  const client = createClient(env.supabaseUrl, env.anonKey, noSession);
  const signedIn = await client.auth.signInWithPassword({ email: account.email, password: account.password });
  if (signedIn.error) throw new Error(`db:seed: ${account.email} could not sign in: ${signedIn.error.message}`);
  const enrolled = await client.auth.mfa.enroll({ factorType: "totp", friendlyName: "Demo" });
  if (enrolled.error) throw new Error(`db:seed: could not enrol a factor for ${account.email}: ${enrolled.error.message}`);
  await sql`update auth.mfa_factors set secret = ${secret} where id = ${enrolled.data.id} and status = 'unverified'`;
  const verified = await client.auth.mfa.challengeAndVerify({ factorId: enrolled.data.id, code: totpCode(secret) });
  if (verified.error) throw new Error(`db:seed: Auth refused the documented TOTP secret of ${account.email}: ${verified.error.message}`);
  await client.auth.signOut();
}

/** The kernel claims of an access token (the custom access token hook wrote them). */
function claimsOf(accessToken: string): JwtClaims {
  const payload = JSON.parse(Buffer.from(accessToken.split(".")[1]!, "base64url").toString("utf8")) as Record<string, unknown>;
  const { sub, tenant_id, company_ids, active_company_id, role_ids, locale } = payload;
  if (typeof sub !== "string" || typeof tenant_id !== "string" || typeof active_company_id !== "string") throw new Error("db:seed: the session has no company claims");
  return { sub, tenant_id, company_ids: company_ids as string[], active_company_id, role_ids: role_ids as string[], locale: typeof locale === "string" ? locale : "es-419" };
}

export interface Session {
  caller: Caller;
  /** A fresh step-up of the account (a correct TOTP code, then the verification row, as POST /api/auth/step-up does); only for an account with a second step. */
  stepUp(): Promise<Caller>;
}

/** The account signed in with its password and TOTP code, acting through the processes with `origin`. */
async function signIn(sql: Sql, env: SeedEnv, account: DemoAccount): Promise<Session> {
  const client = createClient(env.supabaseUrl, env.anonKey, noSession);
  const signedIn = await client.auth.signInWithPassword({ email: account.email, password: account.password });
  if (signedIn.error) throw new Error(`db:seed: ${account.email} could not sign in: ${signedIn.error.message}`);
  if (!account.totpSecret) {
    // An account without a second step acts with the session it just got; it has no step-up to raise.
    return {
      caller: { claims: claimsOf(signedIn.data.session.access_token), origin: "api" },
      async stepUp() {
        throw new Error(`db:seed: ${account.email} has no second step to raise a step-up with`);
      },
    };
  }
  const { data: factors, error } = await client.auth.mfa.listFactors();
  const factor = factors?.totp[0];
  if (error || !factor) throw new Error(`db:seed: ${account.email} has no verified TOTP factor`);
  const verify = async () => {
    const result = await client.auth.mfa.challengeAndVerify({ factorId: factor.id, code: totpCode(account.totpSecret!) });
    if (result.error) throw new Error(`db:seed: the TOTP code of ${account.email} was refused: ${result.error.message}`);
    return result.data.access_token;
  };
  const caller: Caller = { claims: claimsOf(await verify()), origin: "api" };
  return {
    caller,
    async stepUp() {
      await verify();
      const token = randomBytes(32).toString("base64url");
      await sql`insert into kernel.step_up_verifications (user_id, company_id, token) values (${caller.claims.sub}, ${DEMO_COMPANY_ID}, ${token})`;
      return { ...caller, stepUpToken: token };
    },
  };
}

/** People and permissions, each through its admin process as Laura when it is not in place yet. */
async function seedPermissions(sql: Sql, deps: RunProcessDeps, laura: Session, ids: Map<string, string>): Promise<number> {
  let runs = 0;
  const admin = async (processId: string, input: unknown) => {
    runs++;
    await runProcess(deps, await laura.stepUp(), processId, input);
  };
  // Every account holds exactly its documented roles; Marcela becomes a member through kernel.admin.user.create (her
  // Auth user exists, so no invitation goes out).
  for (const account of DEMO_ACCOUNTS) {
    const userId = ids.get(account.email)!;
    const wanted = account.roles.map((role) => DEMO_ROLE_IDS[role]);
    const held = await rolesOf(sql, userId);
    if (held === null) {
      await admin("kernel.admin.user.create", { name: account.fullName, email: account.email, mobileCc: "57", mobile: account.mobile, roleIds: wanted });
    } else if (wanted.some((role) => !held.includes(role))) {
      await admin("kernel.admin.user_role.set", { userId, roleIds: [...new Set([...held, ...wanted])] });
    }
  }
  for (const processId of GERENTE_PROCESSES) {
    const [granted] = await sql`
      select 1 from kernel.process_permissions where company_id = ${DEMO_COMPANY_ID} and role_id = ${DEMO_ROLE_IDS.gerente_comercial} and process_id = ${processId} and allowed`;
    if (!granted) await admin("kernel.admin.permission.set", { roleId: DEMO_ROLE_IDS.gerente_comercial, processId, allowed: true });
  }
  const [mode] = await sql<{ mode: string }[]>`
    select mode from kernel.field_permissions where company_id = ${DEMO_COMPANY_ID} and role_id = ${DEMO_ROLE_IDS.cajero} and entity = 'core.party' and field = 'credit_limit'`;
  if (mode?.mode !== "hidden") await admin("kernel.admin.field_permission.set", { roleId: DEMO_ROLE_IDS.cajero, entity: "core.party", field: "credit_limit", mode: "hidden" });
  const [sensitive] = await sql`select 1 from kernel.sensitive_processes where company_id = ${DEMO_COMPANY_ID} and process_id = 'core.party.deactivate'`;
  if (!sensitive) await admin("kernel.admin.sensitive_process.set", { processId: "core.party.deactivate", sensitive: true });
  return runs;
}

/** Categories, parties and products through their processes, as Laura; what exists (by name, document, SKU) is kept. */
async function seedMasterData(sql: Sql, deps: RunProcessDeps, caller: Caller): Promise<{ categories: number; parties: number; products: number }> {
  const created = { categories: 0, parties: 0, products: 0 };
  const run = (processId: string, input: unknown) => runProcess<never>(deps, caller, processId, input) as Promise<{ id: string }>;

  const categoryIds = new Map((await sql<{ id: string; name: string }[]>`select id, name from core.product_categories where company_id = ${DEMO_COMPANY_ID}`).map((c) => [c.name, c.id]));
  for (const category of CATEGORIES) {
    if (categoryIds.has(category.name)) continue;
    const { id } = await run("core.category.create", category);
    categoryIds.set(category.name, id);
    created.categories++;
  }

  const partyIds = new Map(
    (await sql<{ id: string; document_number: string }[]>`select id, document_number from core.parties where company_id = ${DEMO_COMPANY_ID}`).map((p) => [p.document_number, p.id]),
  );
  for (const party of PARTIES) {
    if (partyIds.has(party.documentNumber)) continue;
    const { id } = await run("core.party.create", { ...party, countryCode: "CO" });
    partyIds.set(party.documentNumber, id);
    created.parties++;
  }

  const skus = new Set((await sql<{ sku: string }[]>`select sku from core.products where company_id = ${DEMO_COMPANY_ID}`).map((p) => p.sku));
  for (const { category, supplier, ...product } of PRODUCTS) {
    if (skus.has(product.sku)) continue;
    await run("core.product.create", { ...product, categoryId: categoryIds.get(category)!, ...(supplier ? { supplierId: partyIds.get(supplier)! } : {}) });
    created.products++;
  }
  return created;
}

/** A one-page PDF that says it stands in for the document (the required files need a real PDF). */
function placeholderPdf(title: string): Buffer {
  const text = title.replace(/[()\\]/g, "");
  const stream = `BT /F1 14 Tf 72 720 Td (${text} - documento de demostracion) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let body = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((object, i) => {
    offsets.push(body.length);
    body += `${i + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, "latin1");
}

/**
 * The required files of the INVOICE_READY_PARTIES (RUT, and Cámara de Comercio for a company), as Laura, the way the
 * Archivos tab adds them (POST /api/attachments): precheck, the bytes in the store, then kernel.attachment.add. A tag
 * the party already has is skipped.
 */
async function seedRequiredFiles(sql: Sql, deps: RunProcessDeps, caller: Caller, store: FileStore): Promise<number> {
  let added = 0;
  for (const document of INVOICE_READY_PARTIES) {
    const party = PARTIES.find((p) => p.documentNumber === document)!;
    const [row] = await sql<{ id: string }[]>`select id from core.parties where company_id = ${DEMO_COMPANY_ID} and document_number = ${document}`;
    const tags = party.personType === "1" ? ["RUT", "Cámara de Comercio"] : ["RUT"];
    for (const tag of tags) {
      const [present] = await sql`
        select 1 from kernel.attachments where company_id = ${DEMO_COMPANY_ID} and entity = 'core.party' and record_id = ${row!.id} and tag = ${tag} and removed_at is null`;
      if (present) continue;
      const bytes = placeholderPdf(`${tag} ${party.legalName ?? `${party.firstName} ${party.firstSurname}`}`);
      const fileName = `${tag === "RUT" ? "rut" : "camara-de-comercio"}-${document}.pdf`;
      const target = { entity: "core.party", recordId: row!.id, tag, fileName, mimeType: "application/pdf", sizeBytes: bytes.length };
      await precheckAttachment(deps, caller, target);
      const storagePath = `${caller.claims.tenant_id}/${DEMO_COMPANY_ID}/core.party/${row!.id}/${randomBytes(8).toString("hex")}-${fileName}`;
      await store.put(storagePath, bytes, "application/pdf");
      await runProcess(deps, caller, "kernel.attachment.add", { ...target, storagePath });
      added++;
    }
  }
  return added;
}

/** Two recommendations for Laura (Task 20's inbox), from numbers computed in SQL; once each, by title. */
async function seedRecommendations(sql: Sql, lauraId: string, marcelaId: string): Promise<number> {
  const [parties] = await sql<{ total: number; not_ready: number; dian_complete: number }[]>`
    select count(*)::int as total, count(*) filter (where not invoice_ready)::int as not_ready,
           count(*) filter (where not invoice_ready and dian_status = 'complete')::int as dian_complete
    from core.parties where company_id = ${DEMO_COMPANY_ID}`;
  const [mfa] = await sql<{ factors: number }[]>`select count(*)::int as factors from auth.mfa_factors where user_id = ${marcelaId} and status = 'verified'`;
  const offers = [
    {
      audience_role_id: DEMO_ROLE_IDS.admin,
      user_id: null,
      title: "Terceros que no se pueden facturar",
      body: `${parties!.not_ready} de ${parties!.total} terceros todavía no se pueden usar en facturas: ${parties!.dian_complete} tienen sus datos DIAN completos pero les falta el RUT o la Cámara de Comercio en Archivos. Cárgalos desde la ficha de cada tercero.`,
      evidence: {
        parties: parties!.total,
        invoice_ready: parties!.total - parties!.not_ready,
        not_invoice_ready: parties!.not_ready,
        dian_complete_missing_files: parties!.dian_complete,
      },
      suggested_actions: [{ label: "Ver terceros", href: "/parties" }],
      confidence: 0.9,
    },
    {
      audience_role_id: null,
      user_id: lauraId,
      title: "Marcela aún no activa la verificación en dos pasos",
      body: "Como cajera tendrá procesos sensibles cuando actives Punto de venta. Revisa su usuario en Administración y pídele que active la verificación en dos pasos.",
      evidence: { user: MARCELA.email, verified_factors: mfa!.factors },
      suggested_actions: [{ label: "Ver usuarios", href: "/admin/users" }],
      confidence: 0.8,
    },
  ];
  let inserted = 0;
  for (const offer of offers) {
    const [exists] = await sql`select 1 from kernel.recommendations where company_id = ${DEMO_COMPANY_ID} and title = ${offer.title}`;
    if (exists) continue;
    await sql`
      insert into kernel.recommendations (company_id, audience_role_id, user_id, agent_profile, title, body, evidence, suggested_actions, confidence)
      values (${DEMO_COMPANY_ID}, ${offer.audience_role_id}, ${offer.user_id}, 'seed', ${offer.title}, ${offer.body},
              ${sql.json(offer.evidence)}, ${sql.json(offer.suggested_actions)}, ${offer.confidence})`;
    inserted++;
  }
  return inserted;
}

export async function seed(env: SeedEnv, flags: Record<string, string | undefined> = process.env): Promise<void> {
  assertSeedAllowed(env, flags);
  process.env.DATABASE_URL = env.databaseUrl;
  const sql = getServiceDb();
  try {
    await sql.file(SEED_SQL);

    const registry = new Registry();
    loadModules(registry, [kernelModule, core, accounting, support]);
    registerCountryPack(co);
    await syncRegistry(sql, registry);
    for (const moduleId of ["core", "support", "accounting"]) await enableModule(sql, DEMO_COMPANY_ID, moduleId, registry);

    const admin = createClient(env.supabaseUrl, env.serviceKey, noSession);
    // kernel.admin.user.create looks people up through the AuthAdmin adapter: this stack's.
    setAuthAdmin(new SupabaseAuthAdmin(admin));
    const ids = new Map<string, string>();
    for (const account of DEMO_ACCOUNTS) ids.set(account.email, await ensureAuthUser(sql, admin, account));
    await bootstrapAdmin(sql, ids.get(LAURA.email)!, LAURA);
    await ensureTotp(sql, env, admin, LAURA, ids.get(LAURA.email)!);

    await sql`select kernel.seed_company_defaults(${DEMO_COMPANY_ID})`;

    const deps: RunProcessDeps = { sql, registry };
    const laura = await signIn(sql, env, LAURA);
    const adminRuns = await seedPermissions(sql, deps, laura, ids);
    const created = await seedMasterData(sql, deps, laura.caller);
    const files = await seedRequiredFiles(sql, deps, laura.caller, new SupabaseFileStore(admin));
    const recommendations = await seedRecommendations(sql, ids.get(LAURA.email)!, ids.get(MARCELA.email)!);
    const andres = await signIn(sql, env, ANDRES);
    const ledger = await seedAccounting(sql, deps, { laura, andres, ids }, ids.get(LAURA.email)!);

    console.log(
      `db:seed done: Café del Norte S.A.S. · ${adminRuns} admin change(s), ${created.categories} categories, ${created.parties} parties, ` +
        `${created.products} products, ${files} required file(s) and ${recommendations} recommendation(s) created (existing ones kept).`,
    );
    console.log(`  Contabilidad: ${ledger.entriesFromEvents} document(s) posted from events, ${ledger.periodsClosed} period(s) closed (existing ones kept).`);
    console.log("Demo accounts (LOCAL USE ONLY):");
    console.log(`  ${LAURA.email} / ${LAURA.password} · admin + gerente comercial · TOTP secret ${LAURA.totpSecret}`);
    console.log(`  ${MARCELA.email} / ${MARCELA.password} · cajero · no second step`);
    console.log(`  ${ANDRES.email} / ${ANDRES.password} · contador · no second step`);
  } finally {
    await sql.end();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await import("./env");
  seed(seedEnv(process.env)).catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}
