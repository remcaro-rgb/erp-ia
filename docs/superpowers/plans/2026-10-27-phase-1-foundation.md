# ERP-IA Phase 1: Foundation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Enforcement (owner order, 2026-10-28):** every implementer and reviewer, whatever model runs it, reads `docs/project-rules.md` and the design sections the task touches before starting, and the brief given to any subagent says so. Work that passes its tests but breaks a rule or deviates from the design is rejected. Task 1 installs the mechanical checks (lint rules, CI gates) listed in its steps.

**Goal:** Stand up the kernel (tenancy, RLS, process registry, permissions, step-up 2FA, audit, outbox, entitlements), the core and support modules, the application shell with the universal grid and exports, and a permission-bounded chat agent, so that a user can log in with MFA, work a grid, export it, and have the agent run a consult or confirmed write process that lands in the audit log.

**Architecture:** pnpm + Turborepo monorepo. Postgres on Supabase is the system of record with one schema per module and RLS driven by JWT claims. Every state change is a `Process` executed by `runProcess`, which gates entitlement → permission → step-up → validation and writes audit and outbox rows in the same transaction. Durable work (outbox dispatch, large exports, agent turns) runs on Vercel Workflow DevKit; the same code runs on the Workflow Postgres World in Docker for CI and on-prem.

**Tech Stack:** TypeScript 5.x, Next.js 16 (App Router, Server Actions), React 19, Supabase (Postgres 15+, Auth with TOTP MFA, Storage), `postgres` (porsager) for kernel DB access, Zod 4, Vercel AI SDK with `@ai-sdk/gateway` and `@ai-sdk/anthropic`, Workflow DevKit (`workflow`, `@workflow/ai`, `@workflow/world-postgres`, `@workflow/vitest`), shadcn/ui + Tailwind CSS v4, TanStack Table v8, next-intl, exceljs, `@react-pdf/renderer`, Vitest, Playwright, pgvector.

**Spec:** `docs/superpowers/specs/2026-10-26-erp-ia-design.md` (sections 4, 5, 6, 7, 8 core/support, 9, 15, 16, 17 phase 1, 19a, 21, 22). Companion renders in the same folder.

## Scope of this plan and the plans that follow

This plan is phase 1 only. Later phases are separate plans, each producing working software on its own, written when the previous one is done:

| Plan | Spec phase | Content |
|---|---|---|
| **1 (this)** | Foundation | kernel, core, support, shell, grid, exports, auth + MFA, agent chat (consult, navigate, help, support, confirmed writes), entitlements, i18n plumbing, docker-compose in CI |
| 2 | Order to cash | posting engine, accounting, CRM, sales, invoicing with DIAN (port Serena `src/lib/dian`), inventory, warehouse, costing, payments; Colombia pack taxes and sequences |
| 2b | Onboarding | import framework (§5.11), onboarding agent (§7.3), Siigo/Alegra connectors |
| 3 | Procure to pay and money | purchases, bank reconciliation, finance, assets, scheduler, messaging, background agents, multi-company UI, English locale, Bold billing (port Serena `src/lib/payments/bold*.ts`) |
| 4 | People | timekeeping, payroll with nómina electrónica and PILA |
| 5 | POS and builders | offline POS PWA, forms and reports builders from chat, simulations, ESC/POS printing |
| 6 | Second country pack and on-prem delivery | |

Call made here: the posting engine (§5.6) moves from phase 1 to plan 2, because it cannot be tested without the accounting module's journal tables; the outbox and consumer registry it depends on are built here.

## Global Constraints

- Monorepo layout exactly as spec §16: `apps/web`, `apps/pos` (empty placeholder in phase 1), `packages/kernel`, `packages/agent`, `packages/ui`, `packages/modules/*`, `packages/localization/*`, `packages/i18n`, `packages/infra`, `supabase/`.
- Every business table has `company_id uuid not null`, `created_at timestamptz default now()`, `updated_at timestamptz`, `created_by uuid`, `updated_by uuid`; primary keys are UUID v7 (`kernel.uuid_v7()`); money is `numeric(18,4)`; timestamps are `timestamptz`.
- One Postgres schema per module: `kernel`, `core`, `support`; cross-module reads only through views the owning module publishes.
- RLS enabled on every table in every module schema; policies read JWT claims through `kernel.current_company_ids()`, `kernel.current_role_ids()`, `kernel.current_tenant_id()`, `kernel.current_user_id()`.
- Every state change goes through `runProcess`; no module code writes tables outside a process handler; the agent has no tool outside the registry.
- Default locale `es-419`; every UI string through `packages/i18n`; `en` catalogue exists with the same keys (English copy may be machine-drafted in phase 1).
- Default currency COP; default country pack `co`. Money renders as `$ 1.234.567,00` (`Intl.NumberFormat('es-CO', { minimumFractionDigits: 2 })`, right-aligned, tabular figures) in grids, cards, forms and assistant replies; `packages/ui` exports `formatMoney(n, currency)` and `MoneyInput` and no component formats money any other way.
- No Vercel-only runtime APIs in business code: no Edge runtime, no `@vercel/blob`, no `@vercel/edge-config`. Durable work only through `workflow`; scheduling only through the kernel scheduler tables (plan 3).
- Models through the AI SDK only; model ids live only in `kernel.model_policies` seed: chat/planning `anthropic/claude-opus-5.5`, classification `anthropic/claude-haiku-5.5`, embeddings `openai/text-embedding-3-small` via the gateway.
- Audit log is append-only: insert-only grants, trigger raising on UPDATE/DELETE.
- Agent write-kind tools never execute without an explicit user confirmation; step-up processes require a fresh TOTP verification (≤ 5 minutes old) recorded in `kernel.step_up_verifications`.
- UI tokens from spec §19a (navy top bar `#1E3A8A`, primary `#1D4ED8`, grid rows 36px, Source Sans 3 + JetBrains Mono); light and dark themes from the same tokens with automatic mode.
- Every business row has a UUID v7 id **and** a per-entity gap-free `seq bigint` from `core.next_sequence(entity)` (spec §5.15); every entity has `extra jsonb` + `extra_free jsonb` (spec §5.14); every record form uses the shared record frame with tabs and open-in-new-tab (spec §5.16).
- Phone columns are stored as `(*_cc text, * text)` pairs validated by `validatePhone(cc, number)`; e-mails by `validateEmail`; both exposed from `packages/kernel/src/validation.ts` and used by parties, contacts and users.
- `invoice_ready` (spec §5.17) is a stored boolean on parties and products recomputed by trigger on the row and on `kernel.attachments` changes; no process may put a non-ready record on an invoice.
- `docker-compose.yml` with the Supabase stack, web, workflow worker runs the integration test job in CI on every push.
- Commits: conventional commits, one per task step that says Commit; end commit messages with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

## Review Focus

1. A user who belongs to two companies and switches the active company mid-session must never see or write rows of the other company (claims refresh and all grid, export and agent calls take the active company). Test in Task 2 (`rls.test.ts: switching active company changes visible rows`) and Task 13 (`grid-route.test.ts: company header must be in caller's claims`).
2. A process whose handler throws after writing rows must leave no audit row and no outbox row (whole pipeline in one transaction). Test in Task 5 (`runProcess rolls back audit and outbox on handler error`).
3. A masked field must stay masked in the grid, in every export format and in the agent's `data.query` result, including when the user sorts or filters by that field (filtering by a hidden field must be refused, not silently ignored). Tests in Task 4, Task 13 (`filter on hidden field returns 403`), Task 14, Task 18.
4. An agent confirmation card resumed twice (double click, reconnect) must execute the process once (idempotency key = confirmation token). Test in Task 17 (`resuming a confirmation twice runs the process once`).
5. A step-up verification must be bound to the user who verified and expire; a TOTP verified by user A must not authorize user B's process, and a verification older than 5 minutes must be rejected. Tests in Task 5 (`step-up: foreign or stale verification rejected`) and Task 10.

- Attachments: a 25 MB file uploaded twice with the same name, or a file whose MIME type does not match its content, must be rejected or renamed, never silently overwritten (Task 9b).
- Required files: removing the only `RUT` attachment of a Colombian party must flip `invoice_ready` to false in the same transaction, and the lookup must stop offering that party for invoices (Task 9b).
- Import: a CSV whose header is missing a required column, or whose rows mix valid and invalid data, must import only the valid rows and return the rejected ones with the reason, never a partial row (Task 13b).
- Custom fields: a required custom field defined after records exist must mark those records as missing data without failing their next unrelated update (Task 9c).

---

## Task 1: Monorepo scaffold and CI

**Mechanical enforcement of `docs/project-rules.md` (added 2026-10-28):** `eslint.config.js` with `no-restricted-imports` banning `@vercel/blob`, `@vercel/kv`, `@vercel/edge-config` and any `runtime = 'edge'` export in `apps/**` and `packages/**` (rule 6); a repo script `pnpm check:rules` that fails CI when a migration file name does not match `^\d{4}_[a-z]+_[a-z0-9_]+\.sql$` (rule 34; purely numeric 4-digit prefix, since the Supabase CLI skips non-numeric versions), when a `.tsx` under `apps/web` contains a Spanish string literal outside `packages/i18n` catalogues (rule 24, heuristic: `/[áéíóñ¿¡]/` in JSX text), or when a module package writes to a table of another schema (write verbs `insert into|update|delete from|truncate|alter table|create …` on `<other>.` or `from("<other>.…").insert|update|upsert|delete` in `packages/modules/*/src/processes`; reads through views are allowed, rule 3); `CLAUDE.md` and `AGENTS.md` at the root are part of the scaffold and are kept identical. Test: `scripts/__tests__/check-rules.test.ts` with one fixture per violation.

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `turbo.json`, `tsconfig.base.json`, `.gitignore`, `.nvmrc` (`22`), `.github/workflows/ci.yml`, `vitest.workspace.ts`
- Create: `apps/web/` (Next.js 16 app via `pnpm dlx create-next-app@latest apps/web --ts --app --tailwind --eslint --src-dir --import-alias "@/*"`), `apps/pos/README.md` (placeholder)
- Create: `packages/kernel/package.json`, `packages/kernel/src/index.ts`, `packages/kernel/tsconfig.json`, `packages/kernel/vitest.config.ts`, same skeleton for `packages/agent`, `packages/ui`, `packages/i18n`, `packages/infra`, `packages/modules/core`, `packages/modules/support`, `packages/localization/co`
- Create: `supabase/config.toml` (via `supabase init`), `supabase/migrations/.keep`, `supabase/seed.sql`
- Test: `packages/kernel/src/__tests__/smoke.test.ts`

**Interfaces:**
- Produces: workspace package names `@erp/kernel`, `@erp/agent`, `@erp/ui`, `@erp/i18n`, `@erp/infra`, `@erp/module-core`, `@erp/module-support`, `@erp/loc-co`; root scripts `pnpm dev`, `pnpm build`, `pnpm test`, `pnpm test:integration`, `pnpm lint`, `pnpm db:reset` (`supabase db reset`), `pnpm db:migrate:new <name>`.

- [ ] **Step 1: Initialise git and the workspace**

Run: `git init && pnpm init` then write `pnpm-workspace.yaml` with `packages: ["apps/*", "packages/*", "packages/modules/*", "packages/localization/*"]` and `turbo.json` with pipelines `build` (dependsOn `^build`), `test`, `lint`, `typecheck`.

- [ ] **Step 2: Write the failing smoke test**

```ts
// packages/kernel/src/__tests__/smoke.test.ts
import { describe, it, expect } from "vitest";
import { KERNEL_VERSION } from "../index";
describe("kernel package", () => {
  it("exports a version", () => expect(KERNEL_VERSION).toBe("0.1.0"));
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `pnpm -F @erp/kernel test`
Expected: FAIL, `KERNEL_VERSION` is not exported.

- [ ] **Step 4: Create the package skeletons**

Each package: `package.json` with `"name"`, `"type": "module"`, `"exports": {".": "./src/index.ts"}`, scripts `test: vitest run`, `typecheck: tsc --noEmit`; `tsconfig.json` extending `../../tsconfig.base.json` (strict, `moduleResolution: bundler`, `target: ES2022`). `packages/kernel/src/index.ts` exports `KERNEL_VERSION = "0.1.0"`.

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm -F @erp/kernel test`
Expected: PASS.

- [ ] **Step 6: Add Supabase local config and the CI workflow**

Run `supabase init` in the repo root. `ci.yml`: job `unit` (pnpm install, lint, typecheck, test); job `integration` (services: none; steps `supabase start`, `pnpm test:integration`, `supabase stop`). Pin `supabase/setup-cli@v1`.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "chore: scaffold monorepo, packages, supabase config and CI"
```

---

## Task 2: Tenancy tables, JWT claims and RLS helpers

**Files:**
- Create: `supabase/migrations/0001_kernel_tenancy.sql`
- Create: `packages/kernel/src/db/client.ts`, `packages/kernel/src/db/test-db.ts`
- Test: `packages/kernel/src/__tests__/rls.test.ts` (integration, needs `supabase start`)

**Interfaces:**
- Produces (SQL): `kernel.uuid_v7()`; tables `kernel.tenants(id, name, created_at)`, `kernel.companies(id, tenant_id, legal_name, trade_name, tax_id, country_code char(2) default 'CO', currency_code char(3) default 'COP', timezone text default 'America/Bogota', created_at)`, `kernel.users(id uuid pk references auth.users, email, full_name, locale text default 'es-419', created_at)`, `kernel.roles(id, company_id, name, is_system bool)`, `kernel.memberships(id, user_id, company_id, created_at, unique(user_id, company_id))`, `kernel.membership_roles(membership_id, role_id)`; functions `kernel.current_user_id() uuid`, `kernel.current_tenant_id() uuid`, `kernel.current_company_ids() uuid[]`, `kernel.current_company_id() uuid` (the `active_company_id` claim), `kernel.current_role_ids() uuid[]`; `kernel.enable_company_rls(schema text, tbl text)` which enables RLS and creates policy `company_isolation` for select/insert/update/delete using `company_id = kernel.current_company_id()`; auth hook `kernel.custom_access_token_hook(event jsonb) returns jsonb` adding claims `tenant_id`, `company_ids`, `active_company_id`, `role_ids`, `locale`.
- Produces (TS): `createDb(url: string): Sql` (porsager `postgres`), `withClaims(sql: Sql, claims: JwtClaims, fn: (tx: Sql) => Promise<T>): Promise<T>` which opens a transaction, runs `select set_config('request.jwt.claims', $1, true)` and `set local role authenticated`; type `JwtClaims = { sub: string; tenant_id: string; company_ids: string[]; active_company_id: string; role_ids: string[]; locale: string }`; `testDb()` returning a `Sql` to the local Supabase (`postgresql://postgres:postgres@127.0.0.1:54322/postgres`) and `seedTenant(sql, { companies: 2, users: [...] })`.

- [ ] **Step 1: Write the failing RLS test**

```ts
// packages/kernel/src/__tests__/rls.test.ts
import { describe, it, expect, beforeAll } from "vitest";
import { testDb, seedTenant } from "../db/test-db";
import { withClaims } from "../db/client";

describe("company isolation", () => {
  let sql: ReturnType<typeof testDb>; let seed: Awaited<ReturnType<typeof seedTenant>>;
  beforeAll(async () => { sql = testDb(); seed = await seedTenant(sql, { companies: 2 }); });

  it("a member of both companies sees only the active company's roles", async () => {
    const rows = await withClaims(sql, seed.claimsFor(seed.users.both, seed.companies[0].id),
      (tx) => tx`select company_id from kernel.roles`);
    expect(new Set(rows.map(r => r.company_id))).toEqual(new Set([seed.companies[0].id]));
  });

  it("switching active company changes visible rows", async () => {
    const rows = await withClaims(sql, seed.claimsFor(seed.users.both, seed.companies[1].id),
      (tx) => tx`select company_id from kernel.roles`);
    expect(rows.every(r => r.company_id === seed.companies[1].id)).toBe(true);
  });

  it("a non-member cannot insert into a company", async () => {
    await expect(withClaims(sql, seed.claimsFor(seed.users.onlyA, seed.companies[1].id),
      (tx) => tx`insert into kernel.roles(company_id, name) values (${seed.companies[1].id}, 'x')`))
      .rejects.toThrow(/row-level security/);
  });

  it("the access token hook adds company and role claims", async () => {
    const [{ hook }] = await sql`select kernel.custom_access_token_hook(${JSON.stringify({ user_id: seed.users.both, claims: {} })}::jsonb) as hook`;
    expect(hook.claims.company_ids).toHaveLength(2);
    expect(hook.claims.active_company_id).toBeDefined();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `supabase start && pnpm -F @erp/kernel test:integration`
Expected: FAIL, relation `kernel.roles` does not exist.

- [ ] **Step 3: Write migration `0001_kernel_tenancy.sql`**

Create schema `kernel`, extension `pgcrypto`, the `uuid_v7()` function (timestamp-prefixed random UUID), the tables and functions listed in Interfaces, `grant usage on schema kernel to authenticated, service_role`, `kernel.enable_company_rls` applied to `roles`, `memberships` (policy on `company_id`), `membership_roles` (via join to memberships). `custom_access_token_hook` reads memberships and roles for `event->>'user_id'`; `active_company_id` = the claim already present in `event->'claims'->'app_metadata'->>'active_company_id'` if the user is a member, else the first membership. Register the hook in `supabase/config.toml` under `[auth.hook.custom_access_token]`.

- [ ] **Step 4: Implement `client.ts` and `test-db.ts`**

`withClaims` sets `request.jwt.claims` and `role authenticated` inside `sql.begin`. `seedTenant` inserts one tenant, N companies, users `both` (member of all), `onlyA` (member of company 0), one `admin` role per company, and returns `claimsFor(userId, activeCompanyId)`.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm -F @erp/kernel test:integration`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/0001_kernel_tenancy.sql packages/kernel/src/db packages/kernel/src/__tests__/rls.test.ts supabase/config.toml
git commit -m "feat(kernel): tenancy tables, JWT claims hook and RLS helpers"
```

---

## Task 3: Audit log and outbox

**Files:**
- Create: `supabase/migrations/0002_kernel_audit_outbox.sql`
- Create: `packages/kernel/src/audit/audit.ts`, `packages/kernel/src/events/outbox.ts`
- Test: `packages/kernel/src/__tests__/audit.test.ts` (integration)

**Interfaces:**
- Produces (SQL): `kernel.audit_log(id, company_id, occurred_at, actor_user_id, origin text check in ('ui','agent','scheduler','event','api','db'), process_id text, entity text, row_id uuid, action text check in ('insert','update','delete','consult'), input jsonb, diff jsonb, chain_id uuid, conversation_id uuid, agent_run_id text)`; trigger function `kernel.audit_row_change()` attached by `kernel.enable_row_audit(schema, tbl)` recording column-level `diff` as `{col: {old, new}}` with origin `db` unless `current_setting('erp.audit_origin', true)` is set; `kernel.outbox(id, company_id, event text, payload jsonb, chain_id uuid, created_at, dispatched_at, attempts int default 0, last_error text)`; `kernel.outbox_dead_letter` same shape plus `failed_at`; audit_log has only INSERT granted to `authenticated` and a trigger `kernel.audit_log_immutable()` raising on update/delete.
- Produces (TS): `writeAudit(tx: Sql, entry: AuditEntry): Promise<void>`; `enqueueEvent(tx: Sql, evt: { companyId: string; event: string; payload: unknown; chainId: string }): Promise<string>`; `setAuditContext(tx: Sql, ctx: { origin: Origin; processId?: string; chainId: string; actorUserId: string; conversationId?: string }): Promise<void>` (uses `set_config('erp.audit_*', ..., true)`).

- [ ] **Step 1: Write the failing audit test**

```ts
// packages/kernel/src/__tests__/audit.test.ts
it("a direct update produces an audit row with a column diff and origin db", async () => {
  await withClaims(sql, claims, async (tx) => {
    await tx`update kernel.roles set name = 'renamed' where id = ${roleId}`;
  });
  const [row] = await sql`select * from kernel.audit_log where row_id = ${roleId} order by occurred_at desc limit 1`;
  expect(row.origin).toBe("db");
  expect(row.diff).toEqual({ name: { old: "admin", new: "renamed" } });
});
it("audit rows cannot be updated or deleted", async () => {
  await expect(sql`delete from kernel.audit_log`).rejects.toThrow(/append-only/);
});
it("enqueueEvent writes an undispatched outbox row", async () => {
  const id = await sql.begin((tx) => enqueueEvent(tx, { companyId, event: "core.party.created", payload: { id: "x" }, chainId }));
  const [row] = await sql`select dispatched_at, attempts from kernel.outbox where id = ${id}`;
  expect(row.dispatched_at).toBeNull(); expect(row.attempts).toBe(0);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm -F @erp/kernel test:integration -t audit`
Expected: FAIL, relation `kernel.audit_log` does not exist.

- [ ] **Step 3: Write migration `0002_kernel_audit_outbox.sql` and the TS helpers**

Apply `kernel.enable_row_audit` to `kernel.roles`, `kernel.memberships`, `kernel.companies`. Diff computed with `hstore`-free JSON: `jsonb_each` over `to_jsonb(OLD)` and `to_jsonb(NEW)`, skipping `updated_at`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm -F @erp/kernel test:integration -t audit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/0002_kernel_audit_outbox.sql packages/kernel/src/audit packages/kernel/src/events packages/kernel/src/__tests__/audit.test.ts
git commit -m "feat(kernel): append-only audit log with row triggers and outbox"
```

---

## Task 4: Entity metadata registry and field-level masking

**Files:**
- Create: `packages/kernel/src/registry/entities.ts`, `packages/kernel/src/registry/fields.ts`, `packages/kernel/src/registry/index.ts`
- Create: `supabase/migrations/0003_kernel_field_permissions.sql`
- Create: `packages/kernel/src/security/masked-views.ts`
- Test: `packages/kernel/src/__tests__/registry.test.ts` (unit), `packages/kernel/src/__tests__/masking.test.ts` (integration)

**Interfaces:**
- Produces (TS):
  ```ts
  type FieldType = "text"|"number"|"money"|"date"|"datetime"|"boolean"|"enum"|"uuid"|"json"|"ref";
  interface FieldDef { name: string; type: FieldType; label: string /* i18n key */; required?: boolean; enumValues?: string[]; ref?: { entity: string; display: string }; sensitivity?: "normal"|"confidential"; sortable?: boolean /* default true */; filterable?: boolean /* default true */; exportable?: boolean /* default true */ }
  interface EntityDef { id: string /* "core.party" */; module: string; schema: string; table: string; label: string; fields: FieldDef[]; displayField: string; defaultSort: { field: string; dir: "asc"|"desc" } }
  function defineEntity(def: EntityDef): EntityDef
  class Registry { registerEntity(e: EntityDef): void; entity(id: string): EntityDef; entities(module?: string): EntityDef[]; registerProcess(p: ProcessDef): void; process(id: string): ProcessDef; processes(filter?: { module?: string }): ProcessDef[]; registerModule(m: ModuleDef): void; modules(): ModuleDef[] }
  export const registry: Registry
  function maskedViewSql(entity: EntityDef): string  // "create or replace view <schema>.v_<table> as select ... case when kernel.field_visible('<entity>', '<field>') then col else null end as col ..."
  ```
- Produces (SQL): `kernel.field_permissions(id, company_id, role_id, entity text, field text, mode text check in ('visible','masked','hidden'), unique(company_id, role_id, entity, field))`; `kernel.field_visible(entity text, field text) boolean` = true unless any of the caller's roles has `hidden` or `masked` for that field (most restrictive wins); `kernel.field_mode(entity, field) text`.

- [ ] **Step 1: Write the failing registry unit test**

```ts
// packages/kernel/src/__tests__/registry.test.ts
it("defineEntity validates fields and registers", () => {
  const e = defineEntity({ id: "core.party", module: "core", schema: "core", table: "parties", label: "entity.core.party",
    displayField: "name", defaultSort: { field: "name", dir: "asc" },
    fields: [{ name: "name", type: "text", label: "field.name", required: true }, { name: "credit_limit", type: "money", label: "field.credit_limit", sensitivity: "confidential" }] });
  registry.registerEntity(e);
  expect(registry.entity("core.party").fields).toHaveLength(2);
  expect(() => registry.registerEntity(e)).toThrow(/already registered/);
});
it("maskedViewSql wraps every field in a visibility case", () => {
  const sql = maskedViewSql(registry.entity("core.party"));
  expect(sql).toContain("create or replace view core.v_parties");
  expect(sql).toContain("kernel.field_visible('core.party', 'credit_limit')");
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm -F @erp/kernel test -t registry`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement the registry, field definitions and `maskedViewSql`**

- [ ] **Step 4: Run the unit tests to verify they pass**

Run: `pnpm -F @erp/kernel test -t registry`
Expected: PASS.

- [ ] **Step 5: Write the failing masking integration test**

```ts
// packages/kernel/src/__tests__/masking.test.ts
it("a role with mode hidden reads null for that field through the view", async () => {
  await sql`insert into kernel.field_permissions(company_id, role_id, entity, field, mode) values (${companyId}, ${cashierRole}, 'kernel.role_probe', 'secret', 'hidden')`;
  const [row] = await withClaims(sql, cashierClaims, (tx) => tx`select secret from kernel.v_role_probe limit 1`);
  expect(row.secret).toBeNull();
  const [adminRow] = await withClaims(sql, adminClaims, (tx) => tx`select secret from kernel.v_role_probe limit 1`);
  expect(adminRow.secret).toBe("s3");
});
```
(`kernel.role_probe` is a tiny test-only table created in `test-db.ts` with `id, company_id, secret` and a view generated by `maskedViewSql`.)

- [ ] **Step 6: Run it to verify it fails, write migration `0003`, run again**

Run: `pnpm -F @erp/kernel test:integration -t masking`
Expected: FAIL then PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/kernel/src/registry packages/kernel/src/security supabase/migrations/0003_kernel_field_permissions.sql packages/kernel/src/__tests__/registry.test.ts packages/kernel/src/__tests__/masking.test.ts packages/kernel/src/db/test-db.ts
git commit -m "feat(kernel): entity registry and field-level masked views"
```

---

## Task 5: Process registry and `runProcess` pipeline

**Files:**
- Create: `packages/kernel/src/process/define.ts`, `packages/kernel/src/process/run.ts`, `packages/kernel/src/process/errors.ts`, `packages/kernel/src/process/context.ts`
- Create: `supabase/migrations/0004_kernel_process_security.sql`
- Test: `packages/kernel/src/__tests__/run-process.test.ts` (integration)

**Interfaces:**
- Produces (TS):
  ```ts
  type ProcessKind = "create"|"update"|"delete"|"consult";
  interface ProcessDef<I extends z.ZodTypeAny = z.ZodTypeAny, O extends z.ZodTypeAny = z.ZodTypeAny> {
    id: string; module: string; kind: ProcessKind; input: I; output: O; description: string /* Spanish, used as the agent tool description */;
    feature?: string; sensitivity?: "normal"|"step-up"; idempotencyKey?: (input: z.infer<I>) => string;
    handler: (ctx: ProcessContext, input: z.infer<I>) => Promise<z.infer<O>>;
  }
  interface ProcessContext { tx: Sql; companyId: string; tenantId: string; userId: string; roleIds: string[]; locale: string; origin: Origin; chainId: string; conversationId?: string; emit(event: string, payload: unknown): Promise<void>; audit(entry: Partial<AuditEntry>): Promise<void> }
  interface Caller { claims: JwtClaims; origin: Origin; conversationId?: string; stepUpToken?: string; chainId?: string }
  function defineProcess<I, O>(def: ProcessDef<I, O>): ProcessDef<I, O>
  function runProcess<I, O>(deps: { sql: Sql; registry: Registry }, caller: Caller, processId: string, input: unknown): Promise<z.infer<O>>
  class ProcessError extends Error { code: "not_entitled"|"forbidden"|"step_up_required"|"invalid_input"|"not_found"|"handler_failed"|"idempotent_replay" }
  ```
- Produces (SQL): `kernel.process_permissions(id, company_id, role_id, process_id text, allowed bool default true, unique(company_id, role_id, process_id))`; `kernel.sensitive_processes(company_id, process_id, mode text check in ('self_2fa','supervisor'), primary key(company_id, process_id))`; `kernel.step_up_verifications(id, user_id, company_id, verified_at, token text unique, consumed_at)`; `kernel.process_idempotency(company_id, process_id, key text, result jsonb, created_at, primary key(company_id, process_id, key))`; `kernel.can_run_process(process_id text) boolean` (any caller role allowed).
- Consumes: `withClaims`, `writeAudit`, `enqueueEvent`, `setAuditContext` (Tasks 2–3), `registry` (Task 4), `entitled()` (Task 6, stub returning true until then).

- [ ] **Step 1: Write the failing pipeline tests**

```ts
// packages/kernel/src/__tests__/run-process.test.ts
const probe = defineProcess({ id: "test.probe.create", module: "test", kind: "create", description: "crea un probe",
  input: z.object({ name: z.string().min(1), fail: z.boolean().optional() }), output: z.object({ id: z.string() }),
  handler: async (ctx, input) => { const [r] = await ctx.tx`insert into kernel.role_probe(company_id, secret) values (${ctx.companyId}, ${input.name}) returning id`;
    await ctx.emit("test.probe.created", { id: r.id }); if (input.fail) throw new Error("boom"); return { id: r.id }; } });
beforeAll(() => registry.registerProcess(probe));

it("forbidden when no role permits the process", async () => {
  await expect(runProcess(deps, callerWith(cashierClaims), "test.probe.create", { name: "a" })).rejects.toMatchObject({ code: "forbidden" });
});
it("invalid input is rejected before the handler runs", async () => {
  await grant(adminRole, "test.probe.create");
  await expect(runProcess(deps, callerWith(adminClaims), "test.probe.create", { name: "" })).rejects.toMatchObject({ code: "invalid_input" });
});
it("success writes the row, one audit row with origin ui and one outbox row sharing chain_id", async () => {
  const out = await runProcess(deps, { claims: adminClaims, origin: "ui" }, "test.probe.create", { name: "ok" });
  const [a] = await sql`select * from kernel.audit_log where process_id = 'test.probe.create' and row_id = ${out.id}`;
  const [o] = await sql`select * from kernel.outbox where event = 'test.probe.created'`;
  expect(a.origin).toBe("ui"); expect(o.chain_id).toBe(a.chain_id);
});
it("runProcess rolls back audit and outbox on handler error", async () => {
  await expect(runProcess(deps, callerWith(adminClaims), "test.probe.create", { name: "x", fail: true })).rejects.toMatchObject({ code: "handler_failed" });
  expect((await sql`select count(*)::int as n from kernel.role_probe where secret = 'x'`)[0].n).toBe(0);
  expect((await sql`select count(*)::int as n from kernel.audit_log where input->>'name' = 'x'`)[0].n).toBe(0);
});
it("step-up: sensitive process requires a fresh verification by the same user", async () => {
  await sql`insert into kernel.sensitive_processes values (${companyId}, 'test.probe.create', 'self_2fa')`;
  await expect(runProcess(deps, callerWith(adminClaims), "test.probe.create", { name: "s" })).rejects.toMatchObject({ code: "step_up_required" });
  const token = await insertVerification(adminUserId, companyId, new Date());
  await expect(runProcess(deps, { ...callerWith(adminClaims), stepUpToken: token }, "test.probe.create", { name: "s" })).resolves.toBeDefined();
});
it("step-up: foreign or stale verification rejected", async () => {
  const foreign = await insertVerification(otherUserId, companyId, new Date());
  await expect(runProcess(deps, { ...callerWith(adminClaims), stepUpToken: foreign }, "test.probe.create", { name: "f" })).rejects.toMatchObject({ code: "step_up_required" });
  const stale = await insertVerification(adminUserId, companyId, new Date(Date.now() - 6 * 60_000));
  await expect(runProcess(deps, { ...callerWith(adminClaims), stepUpToken: stale }, "test.probe.create", { name: "f" })).rejects.toMatchObject({ code: "step_up_required" });
});
it("idempotency key replays the stored result without re-running", async () => {
  const p = defineProcess({ ...probe, id: "test.probe.idem", idempotencyKey: (i) => i.name }); registry.registerProcess(p); await grant(adminRole, p.id);
  const a = await runProcess(deps, callerWith(adminClaims), p.id, { name: "same" });
  const b = await runProcess(deps, callerWith(adminClaims), p.id, { name: "same" });
  expect(b).toEqual(a);
  expect((await sql`select count(*)::int as n from kernel.role_probe where secret = 'same'`)[0].n).toBe(1);
});
it("consult-kind processes are audited with action consult", async () => { /* define test.probe.list kind consult, run, assert audit action === 'consult' */ });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm -F @erp/kernel test:integration -t run-process`
Expected: FAIL, `runProcess` not found.

- [ ] **Step 3: Write migration `0004` and implement the pipeline in `run.ts`**

Order inside `runProcess`: resolve def (`not_found`) → `entitled(companyId, "process:"+id)` and `"module:"+def.module` (`not_entitled`) → `kernel.can_run_process` under claims (`forbidden`) → step-up check (`step_up_required`: when `sensitive_processes` has the process and no verification with `token = stepUpToken and user_id = caller and company_id = companyId and verified_at > now() - interval '5 minutes' and consumed_at is null`; mark consumed on success) → `def.input.safeParse` (`invalid_input`) → idempotency lookup → `withClaims` transaction: `setAuditContext`, handler, `writeAudit` (action from kind, `row_id` from `output.id` when present), store idempotency result → return. Consult kind skips the transaction but still audits.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm -F @erp/kernel test:integration -t run-process`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/kernel/src/process supabase/migrations/0004_kernel_process_security.sql packages/kernel/src/__tests__/run-process.test.ts
git commit -m "feat(kernel): process registry and runProcess pipeline with permissions, step-up and idempotency"
```

---

## Task 6: Module manifests and tenant entitlements

**Files:**
- Create: `packages/kernel/src/module/define.ts`, `packages/kernel/src/entitlements/resolver.ts`, `packages/kernel/src/module/loader.ts`
- Create: `supabase/migrations/0005_kernel_entitlements.sql`
- Test: `packages/kernel/src/__tests__/entitlements.test.ts` (integration), `packages/kernel/src/__tests__/module-loader.test.ts` (unit)

**Interfaces:**
- Produces (TS):
  ```ts
  interface FeatureDef { id: string /* "core.parties" */; label: string; processes: string[]; entities: string[]; nav?: NavItem[] }
  interface NavItem { id: string; label: string; href: string; icon: string; feature?: string }
  interface ModuleDef { id: string; version: string; dependsOn: string[]; entities: EntityDef[]; processes: ProcessDef[]; features: FeatureDef[]; events: { emits: string[]; consumes: Record<string, EventConsumer> }; navigation: NavItem[]; migrationsDir?: string }
  type EventConsumer = (ctx: ConsumerContext, payload: unknown) => Promise<void>
  function defineModule(def: ModuleDef): ModuleDef
  function loadModules(registry: Registry, modules: ModuleDef[]): void   // topological by dependsOn, throws on cycle or missing dependency
  function entitled(sql: Sql, companyId: string, key: string): Promise<boolean>   // module:x, feature:x.y, process:x.y.z, limit:x
  function entitlementLimit(sql: Sql, companyId: string, key: string): Promise<number | null>
  function enableModule(sql: Sql, companyId: string, moduleId: string, registry: Registry): Promise<void>  // validates dependsOn are enabled
  ```
- Produces (SQL): `kernel.plans(id, name, included_keys text[], limits jsonb)`, `kernel.tenant_entitlements(id, tenant_id, company_id null, key text, enabled bool, limit_value numeric null, valid_from date, valid_to date null, source text check in ('plan','addon','trial','manual','license'))`, `kernel.company_modules(company_id, module_id, enabled bool, enabled_at, primary key(company_id, module_id))`, `kernel.entitled(company_id uuid, key text) boolean` (process key falls back to its feature then module; `company_id null` rows apply to the whole tenant; validity dates respected).
- Consumes: `registry` (Task 4), `runProcess` now calls the real `entitled` (replace the Task 5 stub).

- [ ] **Step 1: Write the failing tests**

```ts
// module-loader.test.ts
it("loads modules in dependency order and rejects cycles", () => {
  const a = defineModule({ id: "a", version: "1", dependsOn: [], ... }); const b = defineModule({ id: "b", version: "1", dependsOn: ["a"], ... });
  expect(() => loadModules(new Registry(), [b, a])).not.toThrow();
  expect(() => loadModules(new Registry(), [{ ...a, dependsOn: ["b"] }, b])).toThrow(/cycle/);
});
// entitlements.test.ts
it("process key resolves through feature and module", async () => {
  await sql`insert into kernel.tenant_entitlements(tenant_id, key, enabled, valid_from, source) values (${tenantId}, 'module:core', true, current_date, 'plan')`;
  expect(await entitled(sql, companyId, "process:core.party.create")).toBe(true);
  expect(await entitled(sql, companyId, "process:support.ticket.create")).toBe(false);
});
it("expired entitlement is not active", async () => { /* valid_to yesterday → false */ });
it("runProcess returns not_entitled before forbidden", async () => { /* no entitlement for module test, admin has permission → code not_entitled */ });
it("enableModule refuses when a dependency is disabled", async () => { await expect(enableModule(sql, companyId, "support", registry)).rejects.toThrow(/requires core/); });
```

- [ ] **Step 2: Run to verify they fail, then write migration `0005` and the TS**

Run: `pnpm -F @erp/kernel test && pnpm -F @erp/kernel test:integration -t entitlements`
Expected: FAIL then PASS after implementation.

- [ ] **Step 3: Commit**

```bash
git add packages/kernel/src/module packages/kernel/src/entitlements supabase/migrations/0005_kernel_entitlements.sql packages/kernel/src/__tests__/entitlements.test.ts packages/kernel/src/__tests__/module-loader.test.ts packages/kernel/src/process/run.ts
git commit -m "feat(kernel): module manifests, loader and tenant entitlements"
```

---

## Task 7: Outbox dispatch workflow and consumer registry

**Files:**
- Create: `packages/kernel/src/events/consumers.ts`, `packages/kernel/src/events/dispatch.workflow.ts`, `packages/kernel/src/events/drain.ts`
- Create: `packages/kernel/vitest.integration.config.ts` (with `@workflow/vitest` plugin)
- Test: `packages/kernel/src/__tests__/dispatch.integration.test.ts`

**Interfaces:**
- Produces (TS):
  ```ts
  class ConsumerRegistry { register(moduleId: string, event: string, fn: EventConsumer): void; for(event: string): Array<{ moduleId: string; fn: EventConsumer }> }
  interface ConsumerContext { sql: Sql; companyId: string; chainId: string; runProcess: (processId: string, input: unknown) => Promise<unknown> /* origin "event", actor = system user */ }
  export async function dispatchOutboxRow(outboxId: string): Promise<void>   // "use workflow": loads the row, runs every consumer as a step, marks dispatched_at; RetryableError on transient failure, FatalError → dead letter
  export async function drainOutbox(sql: Sql, limit = 100): Promise<number>  // claims undispatched rows with `for update skip locked`, starts dispatchOutboxRow per row via start(); returns count
  ```
  Consumers of a module whose `company_modules.enabled = false` are skipped and the row stays undispatched with `last_error = 'module_disabled'` (spec §5.12).
- Consumes: `enqueueEvent` (Task 3), `loadModules` (Task 6).

- [ ] **Step 1: Write the failing integration test**

```ts
it("drains the outbox and runs consumers with the same chain id", async () => {
  const seen: string[] = [];
  consumers.register("test", "test.probe.created", async (ctx, p) => { seen.push(ctx.chainId); });
  await sql.begin((tx) => enqueueEvent(tx, { companyId, event: "test.probe.created", payload: {}, chainId }));
  const n = await drainOutbox(sql);
  expect(n).toBe(1);
  await vi.waitFor(async () => expect((await sql`select dispatched_at from kernel.outbox where chain_id = ${chainId}`)[0].dispatched_at).not.toBeNull());
  expect(seen).toEqual([chainId]);
});
it("a FatalError moves the row to the dead letter table", async () => { /* consumer throws FatalError → row in kernel.outbox_dead_letter with last_error */ });
it("consumers of a disabled module are skipped", async () => { /* company_modules.enabled=false → dispatched_at null, last_error module_disabled */ });
```

- [ ] **Step 2: Run to verify it fails, implement, run to verify it passes**

Run: `pnpm -F @erp/kernel test:integration -t dispatch`
Expected: FAIL (`drainOutbox` undefined) then PASS. `dispatchOutboxRow` is `"use workflow"`; each consumer call is a `"use step"` function `runConsumer(outboxId, moduleId)`; `drainOutbox` is plain Node (called from the route handler in Task 21 and from the Postgres World worker).

- [ ] **Step 3: Commit**

```bash
git add packages/kernel/src/events packages/kernel/vitest.integration.config.ts packages/kernel/src/__tests__/dispatch.integration.test.ts
git commit -m "feat(kernel): durable outbox dispatch with consumer registry and dead letters"
```

---

## Task 8: Colombia pack skeleton with NIT validation

**Files:**
- Create: `packages/localization/co/src/index.ts`, `packages/localization/co/src/nit.ts` (port from `/Volumes/SATECHI2TB/Serena/serena-app/src/lib/dian/nit.ts` and its test), `packages/localization/co/src/document-types.ts` (the 12 DIAN codes of spec §5.8a with charset, max length and allowed person types), `packages/localization/co/src/tax-tables.ts` (`TAX_RESPONSIBILITIES` O-13/O-15/O-23/O-47/R-99-PN, `TAX_SCHEMES` 01/04/ZA/ZZ, `DIAN_COUNTRY_CODES` ISO → DIAN numeric, seed from Serena `src/lib/dian/constants.ts`), `packages/localization/co/src/dane.ts` (full DANE department and municipality tables as data, loaded from `data/dane.json`), `packages/localization/co/src/validate-party.ts`, `packages/localization/co/src/item-tables.ts` (`ITEM_ID_SCHEMES` 999/010/001/020, `UOM_CODES` from DIAN table 13.3.6 loaded from `data/uom.json`, `IVA_RATES` 19/5/0/EXC, `INC_RATES`, `OTHER_TAXES` 22/32/33/34/35/23, `PRICE_TYPES` 1/2/3), `packages/localization/co/src/gtin.ts` (`gtinValid`, GS1 mod-10), `packages/localization/co/src/validate-product.ts`
- Create: `packages/kernel/src/localization/country-pack.ts`
- Test: `packages/localization/co/src/__tests__/nit.test.ts`, `packages/localization/co/src/__tests__/validate-party.test.ts`, `packages/localization/co/src/__tests__/validate-product.test.ts`

**Interfaces:**
- Produces (TS):
  ```ts
  interface CountryPack { code: "CO"; validateTaxId(id: string, type: DocumentType): { ok: true; normalized: string } | { ok: false; reason: string }; documentTypes: DocumentType[]; defaultCurrency: "COP"; locale: "es-CO"; /* phase 2 adds taxes, sequences, eInvoicing, payroll hooks */ }
  type DocumentType = "11"|"12"|"13"|"21"|"22"|"31"|"41"|"42"|"47"|"48"|"50"|"91";   // DIAN codes, spec §5.8a
  function nitCheckDigit(nitWithoutDv: string): number
  type PartyFiscalInput = { personType: "1"|"2"; documentType: DocumentType; documentNumber: string; legalName?: string; firstSurname?: string; secondSurname?: string; firstName?: string; otherNames?: string; tradeName?: string; taxResponsibilities: string[]; taxScheme: "01"|"04"|"ZA"|"ZZ"; ciiu?: string; countryCode: string; departmentCode?: string; municipalityCode?: string; addressLine?: string; postalCode?: string; invoiceEmail?: string; phone?: string; kind: ("customer"|"supplier"|"employee")[] }
  type ProductFiscalInput = { sku: string; description: string; kind: "good"|"service"; idScheme: "999"|"010"|"001"|"020"; standardCode?: string; brand?: string; model?: string; uomCode: string; ivaRate: "19"|"5"|"0"|"EXC"; incRate?: "2"|"4"|"8"|"16"; otherTaxes: string[]; listPrice: number; isFreeSample: boolean; referencePriceType?: "1"|"2"|"3"; referencePrice?: number; standardCost?: number; trackStock: boolean; minStock?: number }
  function validateProduct(input: ProductFiscalInput): { errors: string[]; missing: string[]; normalized: ProductFiscalInput }   // spec §5.8b; GTIN padded to 14
  function validateParty(input: PartyFiscalInput): { errors: string[]; missing: string[]; normalized: PartyFiscalInput & { checkDigit: string | null; legalName: string } }   // errors = format/length/coherence (block); missing = data required for e-invoicing or exógena (warn)
  export const co: CountryPack
  function countryPack(code: string): CountryPack   // kernel: registry of packs, throws for unknown
  ```

- [ ] **Step 1: Write the failing NIT test** (values: `900373115` → check digit `6`; `800197268` → `4`; `"900373115-3"` normalizes to `9003731156`; letters rejected)

```ts
// validate-party.test.ts
const base = { personType: "1", documentType: "31", documentNumber: "900373115", legalName: "Café del Norte S.A.S.", taxResponsibilities: ["O-23"], taxScheme: "01", countryCode: "CO", departmentCode: "11", municipalityCode: "11001", addressLine: "Cll 1 # 2-3", invoiceEmail: "fe@cafedelnorte.co", kind: ["customer"] } as const;
it("computes the DV for a NIT and reports no errors or missing data", () => { const r = validateParty(base); expect(r.errors).toEqual([]); expect(r.missing).toEqual([]); expect(r.normalized.checkDigit).toBe("3"); });
it("rejects a cédula with letters, a NIT with dots, and the reserved 222222222222", () => {
  expect(validateParty({ ...base, personType: "2", documentType: "13", documentNumber: "12AB", firstSurname: "Gómez", firstName: "Ana" }).errors).toContain("13: solo dígitos");
  expect(validateParty({ ...base, documentNumber: "900.373.115" }).errors.length).toBeGreaterThan(0);
  expect(validateParty({ ...base, documentNumber: "222222222222" }).errors[0]).toMatch(/consumidor final/);
});
it("composes legal name from split names for natural persons and limits each part to 60", () => { const r = validateParty({ ...base, personType: "2", documentType: "13", documentNumber: "79456123", firstSurname: "Jaramillo", firstName: "Andrés" }); expect(r.normalized.legalName).toBe("Jaramillo Andrés"); expect(validateParty({ ...base, personType: "2", documentType: "13", documentNumber: "1", firstSurname: "x".repeat(61), firstName: "A" }).errors).toContain("Primer apellido: máximo 60 caracteres"); });
it("R-99-PN is exclusive, foreign document types need a foreign country, municipality must belong to department", () => {
  expect(validateParty({ ...base, taxResponsibilities: ["R-99-PN", "O-23"] }).errors.length).toBe(1);
  expect(validateParty({ ...base, documentType: "50", documentNumber: "B123" }).errors[0]).toMatch(/exterior/);
  expect(validateParty({ ...base, municipalityCode: "05001" }).errors[0]).toMatch(/departamento/);
});
it("lists missing data without blocking: customer without invoice e-mail, domestic party without municipality", () => { const r = validateParty({ ...base, invoiceEmail: undefined, municipalityCode: undefined }); expect(r.errors).toEqual([]); expect(r.missing).toEqual(["Municipio (DANE)", "Correo para recibir facturas electrónicas"]); });
```

```ts
// validate-product.test.ts
const good = { sku: "CAF-500", description: "Café tostado molido 500 g", kind: "good", idScheme: "010", standardCode: "7702001005000", uomCode: "94", ivaRate: "5", otherTaxes: [], listPrice: 28500, isFreeSample: false, standardCost: 16200, trackStock: true } as const;
it("accepts a valid GTIN and pads it to 14 digits", () => { const r = validateProduct(good); expect(r.errors).toEqual([]); expect(r.normalized.standardCode).toBe("07702001005000"); });
it("rejects a GTIN with a wrong check digit, a UNSPSC that is not 8 digits, and an unknown unit code", () => {
  expect(validateProduct({ ...good, standardCode: "7702001005001" }).errors[0]).toMatch(/GTIN/);
  expect(validateProduct({ ...good, idScheme: "001", standardCode: "9010170" }).errors[0]).toMatch(/UNSPSC/);
  expect(validateProduct({ ...good, uomCode: "PCS" }).errors[0]).toMatch(/unidad/i);
});
it("requires price > 0 unless free sample, and a reference price > 0 when free", () => {
  expect(validateProduct({ ...good, listPrice: 0 }).errors[0]).toMatch(/Precio/);
  expect(validateProduct({ ...good, listPrice: 0, isFreeSample: true, referencePriceType: "1", referencePrice: 0 }).errors[0]).toMatch(/referencia/);
  expect(validateProduct({ ...good, listPrice: 0, isFreeSample: true, referencePriceType: "1", referencePrice: 3500 }).errors).toEqual([]);
});
it("services cannot track stock; missing standard code with scheme 010 is pending, not an error", () => {
  expect(validateProduct({ ...good, kind: "service", trackStock: true }).errors[0]).toMatch(/servicio/);
  const r = validateProduct({ ...good, standardCode: undefined }); expect(r.errors).toEqual([]); expect(r.missing).toEqual(["Código GTIN"]);
});
```

- [ ] **Step 2: Run to verify it fails, port `nit.ts`, run to verify it passes**

Run: `pnpm -F @erp/loc-co test`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/localization/co packages/kernel/src/localization
git commit -m "feat(loc-co): country pack interface and Colombian tax id validation"
```

---

## Task 9: Core module: parties, products, sequences

**Files:**
- Create: `packages/modules/core/src/index.ts` (the `defineModule`), `packages/modules/core/src/entities.ts`, `packages/modules/core/src/processes/party.ts`, `packages/modules/core/src/processes/product.ts`, `packages/modules/core/src/processes/sequence.ts`, `packages/modules/core/src/features.ts`
- Create: `supabase/migrations/0006_core_master_data.sql`
- Create: `packages/modules/core/src/processes/contact.ts`, `packages/modules/core/src/processes/category.ts`
- Test: `packages/modules/core/src/__tests__/party.test.ts`, `product.test.ts`, `sequence.test.ts`, `contact.test.ts`, `category.test.ts` (integration)

**Additions decided 2026-10-27 (spec §5.15–§5.18):** every `core` table gets `seq bigint not null` from `core.next_sequence(entity)`; `core.parties` adds `invoice_email`, `supplier_email` (required by kind: customer → invoice_email, supplier → supplier_email, both → both), `phone_cc`, `phone`, `invoice_ready bool`, `extra jsonb`, `extra_free jsonb`; `core.party_contacts(id, seq, company_id, party_id, name, job_title, email, phone_cc, phone, ext, mobile_cc, mobile)` with processes `core.contact.create/update/delete`; `core.product_categories(id, seq, company_id, name, iva_rate, inc_rate, other_taxes text[], default_uom, income_account, status)` with `core.category.create/update/read`; `core.products` adds `category_id`, `tax_override bool`, `supplier_id`, `invoice_ready`, `extra`, `extra_free`. `core.product.create` copies the category taxes unless the input overrides them. `kernel.roles.party_scope` filters `core.v_parties` (clientes / proveedores / ambos / ninguno). Tests to add: `creating a party of kind customer+supplier without supplier_email stores dian_missing containing "Correo para enviar documentos al proveedor"`, `phone "12" with cc 57 is rejected with invalid_input`, `product created with category Café inherits iva_rate 5 and tax_override false; setting ivaRate 19 stores tax_override true`, `a vendedor with party_scope clientes cannot read a supplier through core.party.read`, `seq is gap-free under 20 concurrent party.create`.

**Interfaces:**
- Produces (SQL, schema `core`, all with company RLS, row audit and masked views `core.v_*`): `parties(id, company_id, kind text[] check <@ '{customer,supplier,employee}', person_type text check in ('1','2'), document_type text, document_number text, check_digit text null, legal_name text, first_surname text null, second_surname text null, first_name text null, other_names text null, trade_name text null, tax_responsibilities text[] not null default '{R-99-PN}', tax_scheme text not null default 'ZZ', ciiu text null, country_code text not null default 'CO', department_code text null, municipality_code text null, address_line text null, postal_code text null, invoice_email text null, phone text null, contact_name text null, dian_status text not null, dian_missing text[] not null default '{}', is_active, credit_limit numeric(18,4), unique(company_id, document_type, document_number))` (columns per spec §5.8a; `dian_status`/`dian_missing` are written by the process from `validateParty`, never by the client); `uoms(id, company_id, code, name)`; `products(id, company_id, sku text, description text, kind text check in ('good','service'), id_scheme text not null default '999', standard_code text null, brand text null, model text null, category text null, uom_code text not null, iva_rate text not null, inc_rate text null, other_taxes text[] not null default '{}', list_price numeric(18,4) not null, is_free_sample boolean not null default false, reference_price_type text null, reference_price numeric(18,4) null, standard_cost numeric(18,4) null, track_stock boolean not null, min_stock numeric(18,4) null, dian_status text not null, dian_missing text[] not null default '{}', is_active, unique(company_id, sku))` (columns per spec §5.8b; `uoms` becomes the DIAN UoM table seeded from the pack); `price_lists(id, company_id, name, currency_code)`, `price_list_items(price_list_id, product_id, price)`; `currencies(code pk, name, symbol)` seeded COP, USD; `document_sequences(id, company_id, document_type, prefix, next_number bigint, padding int, resolution jsonb null, unique(company_id, document_type, prefix))`; function `core.next_sequence(p_company uuid, p_type text, p_prefix text) returns text` (row lock, returns `prefix || lpad(n)`).
- Produces (processes, ids): `core.party.create` (input: `PartyFiscalInput` from Task 8 plus `creditLimit?`, `contactName?`; runs `countryPack(company.country_code).validateParty`, rejects with `invalid_input` listing `errors`, stores `normalized` plus `dian_status`/`dian_missing`), `core.party.update`, `core.party.deactivate` (kind delete), `core.party.consult` (input: `{ id }`), `core.product.create/update/deactivate/consult` (create/update take `ProductFiscalInput` from Task 8, run `validateProduct`, reject `errors` with `invalid_input`, store `dian_status`/`dian_missing`), `core.sequence.next` (kind update, input `{ documentType, prefix }`, output `{ number }`). Events: `core.party.created`, `core.party.updated`, `core.product.created`, `core.product.updated`. Features: `core.parties`, `core.products`, `core.settings`. Navigation: `core.parties` → `/parties`, `core.products` → `/products`. Entities: `core.party`, `core.product`, `core.uom`, `core.price_list`.
- Consumes: Tasks 4–8.

- [ ] **Step 1: Write the failing tests**

```ts
// party.test.ts
it("creates a customer with a valid NIT and emits core.party.created", async () => {
  const out = await runProcess(deps, admin, "core.party.create", { kind: ["customer"], personType: "1", documentType: "31", documentNumber: "900373115", legalName: "Supermercados Éxito", taxResponsibilities: ["O-13"], taxScheme: "01", countryCode: "CO", departmentCode: "11", municipalityCode: "11001", addressLine: "Cra 1 # 2-3", invoiceEmail: "fe@exito.com" });
  const [row] = await sql`select document_number, check_digit, dian_status from core.parties where id = ${out.id}`; expect(row).toMatchObject({ document_number: "900373115", check_digit: "3", dian_status: "complete" });
  expect((await sql`select 1 from kernel.outbox where event = 'core.party.created' and payload->>'id' = ${out.id}`).length).toBe(1);
});
it("rejects format errors with invalid_input and stores missing data as dian_status", async () => {
  await expect(runProcess(deps, admin, "core.party.create", { kind: ["customer"], personType: "1", documentType: "31", documentNumber: "900.373.115", legalName: "x", taxResponsibilities: ["R-99-PN"], taxScheme: "ZZ", countryCode: "CO" })).rejects.toMatchObject({ code: "invalid_input" });
  const out = await runProcess(deps, admin, "core.party.create", { kind: ["customer"], personType: "1", documentType: "31", documentNumber: "900373115", legalName: "x", taxResponsibilities: ["R-99-PN"], taxScheme: "ZZ", countryCode: "CO" });
  const [row] = await sql`select dian_status, dian_missing from core.parties where id = ${out.id}`; expect(row.dian_status).toBe("missing: 4"); expect(row.dian_missing).toContain("Correo para recibir facturas electrónicas");
});
it("rejects a duplicate tax id in the same company but allows it in another company", async () => { ... });
// product.test.ts
it("creates a product with a GTIN and stores dian_status complete; rejects price 0 without free-sample flag", async () => {
  const out = await runProcess(deps, admin, "core.product.create", { sku: "CAF-500", description: "Café tostado molido 500 g", kind: "good", idScheme: "010", standardCode: "7702001005000", uomCode: "94", ivaRate: "5", otherTaxes: [], listPrice: 28500, isFreeSample: false, standardCost: 16200, trackStock: true });
  const [row] = await sql`select standard_code, dian_status from core.products where id = ${out.id}`; expect(row).toMatchObject({ standard_code: "07702001005000", dian_status: "complete" });
  await expect(runProcess(deps, admin, "core.product.create", { sku: "X", description: "x", kind: "good", idScheme: "999", uomCode: "94", ivaRate: "19", otherTaxes: [], listPrice: 0, isFreeSample: false, trackStock: true })).rejects.toMatchObject({ code: "invalid_input" });
});
// sequence.test.ts
it("next_sequence is gap-free under 20 concurrent calls", async () => {
  await sql`insert into core.document_sequences(company_id, document_type, prefix, next_number, padding) values (${companyId}, 'FE', 'FE-', 1, 5)`;
  const numbers = await Promise.all(Array.from({ length: 20 }, () => runProcess(deps, admin, "core.sequence.next", { documentType: "FE", prefix: "FE-" })));
  expect(new Set(numbers.map(n => n.number)).size).toBe(20); expect(numbers.map(n => n.number)).toContain("FE-00001");
});
```

- [ ] **Step 2: Run to verify they fail, write migration `0006` and the module, run to verify they pass**

Run: `pnpm -F @erp/module-core test:integration`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/modules/core supabase/migrations/0006_core_master_data.sql
git commit -m "feat(core): parties, products, price lists and gap-free document sequences"
```

---

## Task 9b: Attachments on any entity

**Additions decided 2026-10-27:** `kernel.attachments.tag text not null`; `kernel.required_attachments(id, company_id, entity, tag, kind, required, condition, description)` seeded for Colombia with `RUT` (pdf, `co`) and `Cámara de Comercio` (pdf, `co-juridica`) on parties; `missingAttachments(entity, record) → string[]` in `packages/kernel/src/attachments/required.ts`, used by the `invoice_ready` trigger; `AttachmentsPanel` offers drag-and-drop and a chooser, asks a tag per file (defined tags or free text), and confirms before `kernel.attachment.remove`. Tests to add: `upload without tag is rejected`, `a Colombian juridical party without a Cámara de Comercio pdf has invoice_ready false and missingAttachments returns ['Cámara de Comercio']`, `removing the RUT flips invoice_ready to false`.

**Files:**
- Create: `supabase/migrations/0007_kernel_attachments.sql` (`kernel.attachments` per spec §5.13, company RLS, row audit; Storage bucket `attachments` private with a policy that allows reads only through signed URLs issued by the server)
- Create: `packages/kernel/src/attachments/index.ts`, `packages/kernel/src/attachments/processes.ts` (`kernel.attachment.add`, `kernel.attachment.remove`, `kernel.attachment.list`), `packages/infra/src/file-store.ts` (`FileStore` interface: `put`, `signedUrl`, `remove`; Supabase implementation), `apps/web/src/app/api/attachments/route.ts` (POST multipart upload → `FileStore.put` → `kernel.attachment.add`; GET `?id=` → signed URL)
- Create: `packages/ui/src/attachments-panel.tsx` (`AttachmentsPanel({ entity, recordId, readOnly })`), used by Task 12's record form shell and Task 13's grid as a count column (`attachments_count` view per entity)
- Test: `packages/kernel/src/__tests__/attachments.integration.test.ts`

**Interfaces:**
- Consumes: `runProcess`, `defineProcess` (Task 5), registry entities (Task 4), `FileStore` (Task 21 moves it to `packages/infra`; this task creates the interface there).
- Produces: `kernel.attachment.add` (kind update on the owning entity's update permission; input `{ entity, recordId, fileName, mimeType, sizeBytes, storagePath }`; rejects `invalid_input` over 25 MB), `kernel.attachment.remove` (soft delete: sets `removed_at`, keeps the row), `kernel.attachment.list` (consult; excludes removed), view `kernel.v_attachment_counts(entity, record_id, count)`.

- [ ] **Step 1: Write the failing tests**

```ts
it("adds an attachment to a party, lists it, and requires core.party.update permission", async () => {
  const party = await runProcess(deps, admin, "core.party.create", validPartyInput);
  const att = await runProcess(deps, admin, "kernel.attachment.add", { entity: "core.party", recordId: party.id, fileName: "RUT.pdf", mimeType: "application/pdf", sizeBytes: 184320, storagePath: `t/c/core.party/${party.id}/RUT.pdf` });
  expect((await runProcess(deps, admin, "kernel.attachment.list", { entity: "core.party", recordId: party.id })).length).toBe(1);
  await expect(runProcess(deps, cashier, "kernel.attachment.add", { entity: "core.party", recordId: party.id, fileName: "x.pdf", mimeType: "application/pdf", sizeBytes: 10, storagePath: "x" })).rejects.toMatchObject({ code: "forbidden" });
  await expect(runProcess(deps, admin, "kernel.attachment.add", { ...attInput, sizeBytes: 26 * 1024 * 1024 })).rejects.toMatchObject({ code: "invalid_input" });
});
it("remove is a soft delete that keeps the row and writes audit", async () => { await runProcess(deps, admin, "kernel.attachment.remove", { id: att.id }); const [row] = await sql`select removed_at from kernel.attachments where id = ${att.id}`; expect(row.removed_at).not.toBeNull(); expect((await sql`select 1 from kernel.audit_log where process_id = 'kernel.attachment.remove'`).length).toBe(1); });
it("another company cannot list the attachment (RLS)", async () => { await withClaims(sql, otherCompanyClaims, async () => { expect((await sql`select 1 from kernel.attachments`).length).toBe(0); }); });
```

- [ ] **Step 2: Run to verify they fail, write migration, processes, FileStore and panel, run to verify they pass**

Run: `pnpm -F @erp/kernel test:integration`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/0007_kernel_attachments.sql packages/kernel/src/attachments packages/infra/src/file-store.ts packages/ui/src/attachments-panel.tsx apps/web/src/app/api/attachments
git commit -m "feat(kernel): attachments on any entity with soft delete and signed downloads"
```

---

## Task 9c: Custom fields (Datos adicionales) and the record frame

**Files:**
- Create: `supabase/migrations/0008_kernel_custom_fields.sql` (`kernel.custom_fields` per spec §5.14; `extra jsonb not null default '{}'`, `extra_free jsonb not null default '[]'` on `core.parties`, `core.products`, `core.product_categories`, `support.tickets`)
- Create: `packages/kernel/src/custom-fields/validate.ts` (`validateCustomFields(defs, extra, caller) → { errors: string[]; missing: string[] }`), `packages/kernel/src/custom-fields/visibility.ts` (strips keys the caller's roles cannot view, mirrors field masking)
- Create: `packages/ui/src/record/RecordFrame.tsx` (title, N.º, UUID, open-in-new-tab, tabs `datos | contactos | fotos | extra | archivos`, status footer), `packages/ui/src/record/ExtraDataTab.tsx`, `packages/ui/src/record/ContactsTab.tsx`, `packages/ui/src/record/PhotosTab.tsx`, `packages/ui/src/fields/PhoneField.tsx`, `packages/ui/src/fields/EmailField.tsx`, `packages/ui/src/fields/VerifyBadge.tsx`, `apps/web/src/app/(app)/r/[entity]/[id]/page.tsx` (full-page record for deep links)
- Create: `supabase/migrations/0009_kernel_verifiers.sql` (`kernel.verifiers(kind, provider, config jsonb)`, `kernel.verification_requests(id, company_id, kind, value, entity, record_id, status, provider, result jsonb, created_at)`), `packages/kernel/src/verify/index.ts` (`verify(kind, value, ctx)` queues when no provider; provider adapters are empty interfaces in phase 1)
- Test: `packages/kernel/src/__tests__/custom-fields.test.ts`, `packages/kernel/src/__tests__/verify.test.ts`, `packages/ui/src/record/__tests__/RecordFrame.test.tsx`

**Interfaces:**
- Consumes: entity registry (Task 4), `runProcess` (Task 5), attachments (Task 9b).
- Produces: `validateCustomFields`, `RecordFrame`, `PhoneField`, `EmailField`, `verify`. Every create/update process of a registered entity calls `validateCustomFields` after the pack validator and merges `missing` into `dian_missing`.

- [ ] **Step 1: Write the failing tests** (`list field with value outside options → errors`; `required number field empty → missing`; `a role not in roles_view does not receive the key from the masked view`; `verify('email', x) with no provider inserts a verification_request with status queued`; `RecordFrame renders the five tabs for a party and the open-in-new-tab link /r/parties/<id>`)
- [ ] **Step 2: Run to verify they fail, implement, run to verify they pass**

Run: `pnpm -F @erp/kernel test && pnpm -F @erp/ui test`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/0008_kernel_custom_fields.sql supabase/migrations/0009_kernel_verifiers.sql packages/kernel/src/custom-fields packages/kernel/src/verify packages/ui/src/record packages/ui/src/fields "apps/web/src/app/(app)/r"
git commit -m "feat(kernel): custom fields, record frame with tabs and deep links, phone/e-mail fields with verification hooks"
```

---

## Task 10: Auth in the web app: login, TOTP MFA, step-up endpoint

**Addition decided 2026-10-27:** the login form has a show/hide password toggle (eye icon, `aria-pressed`, `aria-label` Mostrar/Ocultar contraseña) and a **Recordarme en este dispositivo** checkbox: checked → persistent Supabase session (refresh token in a 30-day cookie, `persistSession: true`) and the e-mail prefilled next time; unchecked → session cookie only. The audit row for `auth.login` records which mode was used. Test to add: `login with remember=false sets a session cookie without Max-Age; with remember=true sets Max-Age 30 days`.

**Files:**
- Create: `apps/web/src/lib/supabase/server.ts`, `client.ts`, `middleware.ts` (Supabase SSR session refresh + locale), `apps/web/src/app/(auth)/login/page.tsx`, `apps/web/src/app/(auth)/mfa/enroll/page.tsx`, `apps/web/src/app/(auth)/mfa/verify/page.tsx`, `apps/web/src/app/api/auth/step-up/route.ts`, `apps/web/src/lib/auth/claims.ts`, `apps/web/src/lib/auth/step-up.ts`
- Test: `apps/web/src/lib/auth/__tests__/step-up.test.ts` (integration), `apps/web/e2e/auth.spec.ts` (Playwright)

**Interfaces:**
- Produces: `getCallerClaims(): Promise<JwtClaims>` (server, from the Supabase session JWT; throws `Unauthenticated`); `requireCaller(): Promise<Caller>` (origin `ui`); `POST /api/auth/step-up` body `{ code: string }` → verifies the TOTP factor through `supabase.auth.mfa.challengeAndVerify`, inserts `kernel.step_up_verifications`, returns `{ token }`; `setActiveCompany(companyId)` server action updating `app_metadata.active_company_id` via the service client and refreshing the session.
- Consumes: Task 2 hook, Task 5 verification table.

- [ ] **Step 1: Write the failing step-up test** (`POST /api/auth/step-up` with a wrong code → 401 and no row; with a valid code from a test TOTP secret generated with `otpauth` → 200 and a row for the caller)

- [ ] **Step 2: Write the Playwright e2e** (`auth.spec.ts`: login with seeded user, enrol TOTP, verify, land on `/`; second test: user with MFA required by role is redirected to `/mfa/verify` until verified)

- [ ] **Step 3: Run both to verify they fail, implement, run to verify they pass**

Run: `pnpm -F web test:integration -t step-up && pnpm -F web e2e -g auth`
Expected: PASS. Supabase MFA must be enabled in `supabase/config.toml` (`[auth.mfa.totp] enroll_enabled = true, verify_enabled = true`).

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/lib/supabase apps/web/src/middleware.ts "apps/web/src/app/(auth)" apps/web/src/app/api/auth apps/web/src/lib/auth apps/web/e2e/auth.spec.ts supabase/config.toml
git commit -m "feat(web): Supabase auth with TOTP MFA, active company and step-up endpoint"
```

---

## Task 11: i18n package and locale plumbing

**Files:**
- Create: `packages/i18n/src/index.ts`, `packages/i18n/messages/es-419.json`, `packages/i18n/messages/en.json`, `packages/i18n/src/__tests__/catalogue.test.ts`
- Modify: `apps/web/src/middleware.ts` (next-intl locale from `kernel.users.locale` claim, default `es-419`), `apps/web/src/i18n/request.ts`

**Interfaces:**
- Produces: `locales = ["es-419", "en"] as const`, `defaultLocale = "es-419"`, `messages(locale)`, `t` via next-intl `useTranslations`/`getTranslations`; namespaces `common`, `nav`, `entity`, `field`, `process`, `grid`, `agent`, `auth`, `errors`. Every `EntityDef.label`, `FieldDef.label`, `NavItem.label` is a key in `entity.*`, `field.*`, `nav.*`; `ProcessError.code` maps to `errors.<code>`.

- [ ] **Step 1: Write the failing catalogue test** (`en` has exactly the keys of `es-419`; every registered entity, field and nav label key exists in `es-419`; no value is empty)

- [ ] **Step 2: Run to verify it fails, write catalogues and wiring, run to verify it passes**

Run: `pnpm -F @erp/i18n test`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/i18n apps/web/src/i18n apps/web/src/middleware.ts
git commit -m "feat(i18n): es-419 default catalogue with en mirror and locale plumbing"
```

---

## Task 12: UI package tokens and application shell

**Files:**
- Create: `packages/ui/src/styles/tokens.css` (§19a values as CSS variables, light and dark), `packages/ui/src/styles/globals.css` (Tailwind v4 `@theme` mapping), `packages/ui/components.json` (shadcn), shadcn components `button`, `input`, `select`, `dialog`, `dropdown-menu`, `command`, `sheet`, `table`, `badge`, `tabs`, `tooltip`, `toast`
- Create: `packages/ui/src/shell/AppShell.tsx`, `TopBar.tsx` (Módulos menu lists modules only), `ModuleBar.tsx` (horizontal items of the active module, from the module manifest `menu` entries), `TabsBar.tsx` (rendered under the top bar on the tinted band; "Cerrar todas" with confirmation keeps only Inicio), `ThemeToggle.tsx` (`auto | light | dark`, `data-theme` on `<html>`, persisted in `kernel.user_prefs`), `CommandPalette.tsx`, `AssistantDrawer.tsx` (placeholder content until Task 17), `packages/ui/src/shell/tabs-store.ts` (zustand, persisted per user in `localStorage` key `erp.tabs.<userId>`), `packages/ui/src/shell/types.ts`
- Create: `apps/web/src/app/(app)/layout.tsx` using `AppShell`, `apps/web/src/app/(app)/page.tsx` (home, Task 20 fills it)
- Test: `packages/ui/src/shell/__tests__/tabs-store.test.ts`, `packages/ui/src/shell/__tests__/CommandPalette.test.tsx` (vitest + @testing-library/react, jsdom)

**Interfaces:**
- Produces:
  ```ts
  interface Tab { id: string; title: string; href: string; kind: "home"|"grid"|"record"|"report"|"admin"; pinned?: boolean }
  useTabs(): { tabs: Tab[]; activeId: string; open(tab: Omit<Tab,"id"> & { id?: string }): void; close(id: string): void; activate(id: string): void }
  <AppShell company={...} companies={[...]} user={...} nav={NavItem[]} assistant={ReactNode}>{children}</AppShell>
  <CommandPalette items={CommandItem[]} onAsk={(text) => void} />   // ⌘K; items from navigation + "create" processes; free text → onAsk opens the assistant with the text
  ```
- Consumes: `NavItem` (Task 6), i18n (Task 11).

- [ ] **Step 1: Write the failing tests** (`tabs-store`: open same href twice activates instead of duplicating; close active tab activates the neighbour; home tab cannot be closed. `CommandPalette`: typing "clientes" lists the Parties nav item; Enter on free text calls `onAsk` with the text)

- [ ] **Step 2: Run to verify they fail, implement tokens, shadcn install and the shell, run to verify they pass**

Run: `pnpm -F @erp/ui test`
Expected: PASS. Visual check: `pnpm dev`, open `/`, compare with `docs/superpowers/specs/2026-10-26-erp-ia-ui-CA-home-blue.png` (navy bar, tabs, ⌘K, drawer).

- [ ] **Step 3: Commit**

```bash
git add packages/ui "apps/web/src/app/(app)"
git commit -m "feat(ui): design tokens, shadcn base and application shell with tabs and command palette"
```

---

## Task 12b: Wire the record tabs (added 2026-10-28)

Controller addition during execution: Task 16's guides found the record page renders Contactos and Datos adicionales read-only, PhotosTab without `onReorder`/`onSuggest`, and AttachmentsPanel without `requiredTags`. Task 12b wires them: editable contacts (`core.contact.*`), extra data saved through `<entity>.update`, `kernel.attachment.reorder` with a `position` column (0007 edited in place), `kernel.ai.image_suggest` with a phase-1 placeholder image tagged `Foto · IA` (real model in phase 5), `kernel.v_required_attachments` feeding the required-files checklist, guides updated. Full brief in the SDD workspace (`task-12b-brief.md`); tests: wiring integration test, reorder integration test, Playwright `record.spec.ts`.

## Task 13: Universal DataGrid with server-side query builder

**Files:**
- Create: `packages/kernel/src/query/grid-state.ts`, `packages/kernel/src/query/build-query.ts`
- Create: `apps/web/src/app/api/grid/[entity]/route.ts`
- Create: `packages/ui/src/grid/DataGrid.tsx`, `FilterRow.tsx`, `ColumnChooser.tsx`, `GridFooter.tsx` (pager 10/25/50/100 + page buttons), `packages/ui/src/grid/use-grid.ts`, `packages/ui/src/grid/saved-views.ts`, `packages/ui/src/grid/ExportButtons.tsx` (PDF / Excel / CSV with icons), `packages/ui/src/grid/AdvancedFilter.tsx` (popup condition builder over every registry field, operators by type, Y/O joins with AND precedence, live results table with row pick (fills the lookup or opens the record), chips; opened by DataGrid's button and by the magnifier icon of EntityLookup), `packages/ui/src/lookup/EntityLookup.tsx` (autocomplete over `searchable` fields + the same AdvancedFilter inline + `forInvoice` disabling non-ready rows, spec §9), `packages/ui/src/grid/PartyScopeSwitches.tsx` (Mostrar clientes / proveedores within the role's `party_scope`)
- Create: `supabase/migrations/0011_kernel_saved_views.sql` (`kernel.saved_views(id, company_id, user_id, entity, name, state jsonb, is_default)`)
- Create: `apps/web/src/app/(app)/parties/page.tsx`, `apps/web/src/app/(app)/products/page.tsx`, `apps/web/src/app/(app)/categories/page.tsx`
- Test: `packages/kernel/src/__tests__/build-query.test.ts` (unit), `apps/web/src/app/api/grid/__tests__/grid-route.test.ts` (integration), `packages/ui/src/grid/__tests__/DataGrid.test.tsx`

**Interfaces:**
- Produces:
  ```ts
  const GridState = z.object({
    filters: z.array(z.object({ field: z.string(), op: z.enum(["eq","neq","contains","ncontains","starts","ends","gt","gte","lt","lte","between","in","is_null","not_null"]), value: z.unknown().optional(), value2: z.unknown().optional(), join: z.enum(["and","or"]).optional() })),  // join applies to the previous condition; AND binds tighter than OR. `field` may be `extra.<key>` for custom fields (spec §5.14); the builder UI (`AdvancedFilter.tsx`) offers every registry field with the operators of its type
    sort: z.array(z.object({ field: z.string(), dir: z.enum(["asc","desc"]) })),
    page: z.number().int().min(1), pageSize: z.number().int().min(1).max(500),
    columns: z.array(z.string()).optional(), groupBy: z.string().optional(),
    aggregates: z.array(z.object({ field: z.string(), fn: z.enum(["sum","avg","min","max","count"]) })).optional() });
  type GridState = z.infer<typeof GridState>;
  function buildQuery(entity: EntityDef, state: GridState, visibleFields: (f: string) => boolean): { sql: string; params: unknown[]; countSql: string }
    // selects from <schema>.v_<table>; throws QueryError("field_not_filterable"|"field_hidden"|"unknown_field"|"bad_operator") — filtering or sorting a hidden field is refused
  // route: POST /api/grid/:entity  body GridState  → { rows, total, aggregates? }  (403 when the entity's module is not entitled or a hidden field is used; 400 on invalid state)
  <DataGrid entity="core.party" initialState={...} onRowOpen={(row) => ...} toolbar={ReactNode} />
  ```
  Grid behaviour: filter row under the header with an operator per type (text `contains`, number/money/date `between`, enum/boolean `in`), click-to-sort with multi-sort on shift, column chooser, row selection with selection totals for money columns in the footer, saved views per user.

- [ ] **Step 1: Write the failing query builder tests**

```ts
it("builds a filtered, sorted, paged select over the masked view", () => {
  const q = buildQuery(partyEntity, { filters: [{ field: "name", op: "contains", value: "éxito" }], sort: [{ field: "name", dir: "asc" }], page: 2, pageSize: 50 }, () => true);
  expect(q.sql).toMatch(/from core\.v_parties/); expect(q.sql).toMatch(/"name" ilike \$1/); expect(q.params[0]).toBe("%éxito%");
  expect(q.sql).toMatch(/order by "name" asc/); expect(q.sql).toMatch(/limit 50 offset 50/);
});
it("refuses a filter on a hidden field", () => { expect(() => buildQuery(partyEntity, { filters: [{ field: "credit_limit", op: "gt", value: 1 }], sort: [], page: 1, pageSize: 50 }, (f) => f !== "credit_limit")).toThrow(/field_hidden/); });
it("refuses unknown fields and non-filterable fields", () => { ... });
it("between on a money field uses two parameters", () => { ... });
```

- [ ] **Step 2: Write the failing route and component tests** (`grid-route.test.ts`: as cashier with `credit_limit` hidden, rows have `credit_limit: null`; `filter on hidden field returns 403`; `company header must be in caller's claims`: an `x-company-id` header not in `company_ids` → 403. `DataGrid.test.tsx`: renders the filter row with one input per filterable column; typing in a filter calls the fetcher with the new state after debounce)

- [ ] **Step 3: Run to verify they fail, implement, run to verify they pass**

Run: `pnpm -F @erp/kernel test -t build-query && pnpm -F web test:integration -t grid-route && pnpm -F @erp/ui test -t DataGrid`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/kernel/src/query packages/ui/src/grid apps/web/src/app/api/grid "apps/web/src/app/(app)/parties" "apps/web/src/app/(app)/products" supabase/migrations/0011_kernel_saved_views.sql
git commit -m "feat(grid): universal DataGrid with server-side filters, sort, masking and saved views"
```

---

## Task 13b: Mass import from Excel / CSV on any entity

**Files:**
- Create: `supabase/migrations/0012_kernel_imports.sql` (`kernel.imports(id, company_id, entity, file_attachment_id, status, rows_total, rows_ok, rows_failed, errors_attachment_id, started_by, finished_at)`)
- Create: `packages/kernel/src/import/template.ts` (`buildTemplate(entity, format: 'xlsx'|'csv')` from the registry: one column per writable field, list columns as dropdowns in xlsx), `packages/kernel/src/import/parse.ts` (CSV with `;` or `,`, UTF-8; xlsx via SheetJS), `packages/kernel/src/import/run.ts` (`"use workflow"`: validate every row with the entity's create process in dry-run, insert the valid rows in batches of 500, write `errores.csv` to Storage), `packages/modules/core/src/processes/import.ts` (`kernel.import.template`, `kernel.import.preview`, `kernel.import.run` — the last is `step-up` by default)
- Create: `packages/ui/src/import/ImportDialog.tsx` (template buttons, drop zone, preview with per-row status, "Importar filas válidas"), `apps/web/src/app/(app)/import/page.tsx` (entity cards + history)
- Test: `packages/kernel/src/__tests__/import.test.ts` (unit parse + template), `packages/modules/core/src/__tests__/import.integration.test.ts`

**Interfaces:**
- Consumes: `runProcess` dry-run flag (add `{ dryRun: true }` option to Task 5's pipeline: validates and returns `errors/missing` without writing), attachments (Task 9b), workflow (Task 7).
- Produces: `kernel.import.*` processes; `ImportDialog`.

- [ ] **Step 1: Write the failing tests** (`template for parties has the 24 columns of spec §5.8a in order`; `a 4-row CSV with one bad NIT imports 3 rows, writes errores.csv with 1 line naming the NIT error, and audit shows "3 creadas · 1 rechazada"`; `duplicate document in the file and in the table are both rejected`; `import by a role without kernel.import.run is forbidden`)
- [ ] **Step 2: Run to verify they fail, implement, run to verify they pass**

Run: `pnpm -F @erp/kernel test && pnpm -F @erp/module-core test:integration -t import`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/0012_kernel_imports.sql packages/kernel/src/import packages/modules/core/src/processes/import.ts packages/ui/src/import "apps/web/src/app/(app)/import"
git commit -m "feat(kernel): mass import from Excel/CSV templates with per-row validation"
```

---

## Task 14: Exports (CSV, XLSX, PDF) as a consult process

**Files:**
- Create: `packages/kernel/src/exports/csv.ts`, `xlsx.ts`, `pdf.tsx`, `packages/kernel/src/exports/export.process.ts`, `packages/kernel/src/exports/export.workflow.ts`
- Create: `apps/web/src/app/api/export/route.ts`, `apps/web/src/app/api/export/[jobId]/route.ts`
- Create: `supabase/migrations/0013_kernel_export_jobs.sql` (`kernel.export_jobs(id, company_id, user_id, entity, format, state jsonb, status text check in ('queued','running','done','failed'), storage_path, row_count, error, created_at, finished_at)`)
- Modify: `packages/ui/src/grid/DataGrid.tsx` (toolbar buttons PDF / Excel / CSV)
- Test: `packages/kernel/src/__tests__/exports.test.ts` (unit on writers), `apps/web/src/app/api/export/__tests__/export-route.test.ts` (integration)

**Interfaces:**
- Produces: process `kernel.export.run` (kind consult; input `{ entity, format: "csv"|"xlsx"|"pdf", state: GridState, title?: string }`; output `{ mode: "inline"; filename; contentType } | { mode: "job"; jobId }`); threshold 10,000 rows (count query) switches to the job mode, run by `exportJobWorkflow(jobId)` (`"use workflow"`) that streams rows in pages of 1,000 through a step and uploads to Supabase Storage bucket `exports` at `<company>/<jobId>.<ext>`; `GET /api/export/:jobId` → status and a 10-minute signed URL when done. Writers: `writeCsv(columns, rows): ReadableStream`, `writeXlsx(columns, rows, { title, locale }): Promise<Buffer>` (typed cells: dates as dates, money as numbers with format `#,##0.00`, frozen header, autofilter), `writePdf(columns, rows, { title, company, locale }): Promise<Buffer>` (landscape, repeated header, page numbers, money totals row). Masked values export as `••••••` in all three formats; hidden fields are omitted.
- Consumes: `buildQuery` (Task 13), `runProcess` (Task 5).

- [ ] **Step 1: Write the failing writer tests** (CSV: UTF-8 BOM, `;` separator for `es-419`, quoted values; XLSX: header frozen, money cell is numeric; PDF: buffer starts with `%PDF`; a masked column value is `••••••` in all three)

- [ ] **Step 2: Write the failing route test** (`export-route.test.ts`: 20 parties, csv → inline response with 20 data lines; seeded 10,001 rows → `{ mode: "job" }` and the job reaches `done` with a signed URL; audit log has a `consult` row for `kernel.export.run`)

- [ ] **Step 3: Run to verify they fail, implement, run to verify they pass**

Run: `pnpm -F @erp/kernel test -t exports && pnpm -F web test:integration -t export-route`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/kernel/src/exports apps/web/src/app/api/export supabase/migrations/0013_kernel_export_jobs.sql packages/ui/src/grid/DataGrid.tsx
git commit -m "feat(exports): CSV, XLSX and PDF export process with durable job for large sets"
```

---

## Task 15: Support module (tickets)

**Files:**
- Create: `packages/modules/support/src/index.ts`, `entities.ts`, `processes/ticket.ts`
- Create: `supabase/migrations/0014_support_tickets.sql` (`support.tickets(id, company_id, reporter_user_id, kind text check in ('bug','question','request'), title, body, context jsonb, status text check in ('open','answered','closed'), priority, created_at, updated_at)`, `support.ticket_messages(id, ticket_id, author_user_id, body, is_internal, created_at)`)
- Create: `apps/web/src/app/(app)/support/page.tsx` (grid of tickets + detail sheet)
- Test: `packages/modules/support/src/__tests__/ticket.test.ts`

**Interfaces:**
- Produces processes: `support.ticket.create` (input `{ kind, title, body, context?: { route, selection, lastAuditIds, consoleErrors } }`), `support.ticket.reply`, `support.ticket.close`, `support.ticket.consult`; event `support.ticket.created`; feature `support.tickets`; nav `/support`. Entities `support.ticket`, `support.ticket_message`.

- [ ] **Step 1: Write the failing tests** (create stores context JSON and emits the event; reporter sees own tickets, a `support_agent` role sees all tickets of the company through an ownership RLS predicate `reporter_user_id = kernel.current_user_id() or kernel.has_role('support_agent')`)

- [ ] **Step 2: Run to verify they fail, implement, run to verify they pass**

Run: `pnpm -F @erp/module-support test:integration`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/modules/support supabase/migrations/0014_support_tickets.sql "apps/web/src/app/(app)/support"
git commit -m "feat(support): tickets with captured context and role-scoped visibility"
```

---

## Task 16: Help knowledge index (pgvector)

**Files:**
- Create: `supabase/migrations/0015_kernel_help_index.sql` (`create extension vector`; `kernel.help_chunks(id, scope text check in ('platform','company'), company_id null, source text, title, body, embedding vector(1536), locale, updated_at)`; ivfflat index)
- Create: `packages/kernel/src/help/embedder.ts`, `packages/kernel/src/help/index-builder.ts`, `packages/kernel/src/help/search.ts`, `packages/kernel/src/help/help.process.ts`
- Create: `docs/user-guide/es-419/*.md` (first guides: `inicio.md`, `grids.md`, `exportar.md`, `asistente.md`, `seguridad-2fa.md`, written for users, Spanish)
- Test: `packages/kernel/src/__tests__/help.test.ts` (integration with `FakeEmbedder`)

**Interfaces:**
- Produces: `interface Embedder { embed(texts: string[]): Promise<number[][]> }`; `GatewayEmbedder` (AI SDK `embedMany` with the model from `kernel.model_policies` task `embeddings`); `FakeEmbedder` (deterministic hash vectors, tests); `buildHelpIndex(sql, embedder, { guidesDir, registry })` chunks guides (≈500 tokens) and one chunk per registered process (`description` + input field names) with `scope platform`; process `kernel.help.search` (consult; input `{ query, limit? }`; output `{ results: { title, snippet, source, href? }[] }`) using cosine distance and filtering `scope = 'platform' or company_id = current`.

- [ ] **Step 1: Write the failing test** (index 3 guide chunks + registered processes with `FakeEmbedder`; search "cómo exporto a excel" returns `exportar.md` first; search "crear cliente" returns the `core.party.create` chunk with `href: "/parties?new=1"`)

- [ ] **Step 2: Run to verify it fails, implement, run to verify it passes**

Run: `pnpm -F @erp/kernel test:integration -t help`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/0015_kernel_help_index.sql packages/kernel/src/help docs/user-guide
git commit -m "feat(help): pgvector knowledge index over user guides and process registry"
```

---

## Task 17: Agent runtime: tool generation, durable turn, confirmations, model policy, usage log

**Files:**
- Create: `supabase/migrations/0016_kernel_agent.sql` (`kernel.model_policies(id, tenant_id null, task text, primary_model text, fallbacks text[], max_cost_usd numeric null)` seeded per Global Constraints; `kernel.agent_conversations(id, company_id, user_id, title, created_at)`, `kernel.agent_messages(id, conversation_id, role, parts jsonb, created_at)`, `kernel.agent_confirmations(id, conversation_id, process_id, input jsonb, token text unique, status text check in ('pending','confirmed','rejected','executed'), result jsonb, created_at, decided_at)`, `kernel.llm_usage(id, company_id, user_id, conversation_id, provider, model, input_tokens, output_tokens, cached_tokens, cost_usd, task, created_at)`)
- Create: `packages/agent/src/tools/from-registry.ts`, `packages/agent/src/tools/builtin.ts` (`data.query`, `ui.navigate`, `help.search`, `support.ticket.create`, `ui.open_record`), `packages/agent/src/runtime/system-prompt.ts`, `packages/agent/src/runtime/turn.workflow.ts`, `packages/agent/src/runtime/confirm.ts`, `packages/agent/src/runtime/model-policy.ts`, `packages/agent/src/runtime/usage.ts`, `packages/agent/src/runtime/limits.ts`
- Create: `apps/web/src/app/api/agent/turn/route.ts` (POST, starts the workflow, returns the run's readable stream of `UIMessageChunk`), `apps/web/src/app/api/agent/confirm/route.ts` (POST `{ token, decision: "confirm"|"reject", stepUpToken? }`)
- Test: `packages/agent/src/__tests__/tools.test.ts` (unit), `packages/agent/src/__tests__/turn.integration.test.ts` (`@workflow/vitest` + AI SDK `MockLanguageModelV2`), `packages/agent/src/__tests__/limits.test.ts`

**Interfaces:**
- Produces:
  ```ts
  function buildTools(deps, caller: Caller, opts: { registry: Registry; screen?: ScreenContext }): Promise<ToolSet>
    // one tool per registered process the caller is entitled to and permitted for; name = process id with "." → "__"; description = ProcessDef.description; inputSchema = ProcessDef.input
    // consult-kind tools execute runProcess directly (a "use step"); write-kind tools create a kernel.agent_confirmations row and return { confirmationRequired: true, token, preview } without executing
  async function agentTurn(args: { conversationId: string; caller: Caller; userText: string; screen?: ScreenContext }): Promise<void>  // "use workflow": DurableAgent with model from policy, streams to getWritable<UIMessageChunk>(), persists messages, logs usage
  async function decideConfirmation(deps, caller: Caller, token: string, decision: "confirm"|"reject", stepUpToken?: string): Promise<{ status; result? }>
    // confirm → runProcess(origin "agent", conversationId, idempotency key = token); second call with same token returns the stored result (status executed) without running again
  function resolveModel(sql, tenantId: string, task: "chat"|"planning"|"classification"|"embeddings"): Promise<{ primary: string; fallbacks: string[] }>
  function checkTokenBudget(sql, companyId): Promise<{ allowed: boolean; used: number; limit: number | null }>  // limit from entitlementLimit("limit:ai_tokens_month"), used from llm_usage this calendar month in the company timezone
  ```
  System prompt (Spanish) assembled from: company facts, user name, role names, permission summary (counts per module), locale, screen context (route, selected record), 5 best `help.search` chunks for the user text, and the rule that write actions always require confirmation. Over budget → the turn replies with `errors.ai_budget_exceeded` and no model call.
- Consumes: Tasks 5, 6, 13 (`buildQuery` for `data.query`), 15, 16.

- [ ] **Step 1: Write the failing tool tests**

```ts
it("generates one tool per permitted process and none for forbidden or unentitled ones", async () => {
  const tools = await buildTools(deps, cashier, { registry });
  expect(Object.keys(tools)).toContain("core__party__consult"); expect(Object.keys(tools)).not.toContain("core__party__create");
});
it("a write-kind tool returns a confirmation instead of executing", async () => {
  const tools = await buildTools(deps, admin, { registry });
  const r = await tools.core__party__create.execute({ kind: ["customer"], documentType: "NIT", taxId: "900373115-3", name: "Éxito" }, toolCtx);
  expect(r).toMatchObject({ confirmationRequired: true }); expect((await sql`select count(*)::int as n from core.parties where name = 'Éxito'`)[0].n).toBe(0);
});
it("data.query applies field masks and refuses hidden fields", async () => { ... });
```

- [ ] **Step 2: Write the failing turn and confirmation tests**

```ts
it("a turn streams text, persists messages and logs usage", async () => {
  const run = await start(agentTurn, [{ conversationId, caller: admin, userText: "¿cuántos clientes hay?" }]);  // model = MockLanguageModelV2 answering with a data.query tool call then text
  await run.returnValue;
  expect((await sql`select count(*)::int as n from kernel.agent_messages where conversation_id = ${conversationId}`)[0].n).toBe(2);
  expect((await sql`select sum(input_tokens)::int as t from kernel.llm_usage where conversation_id = ${conversationId}`)[0].t).toBeGreaterThan(0);
});
it("resuming a confirmation twice runs the process once", async () => {
  const token = await createPendingConfirmation("core.party.create", input);
  const a = await decideConfirmation(deps, admin, token, "confirm"); const b = await decideConfirmation(deps, admin, token, "confirm");
  expect(b.result).toEqual(a.result); expect((await sql`select count(*)::int as n from core.parties where tax_id = '9003731156'`)[0].n).toBe(1);
  const [audit] = await sql`select origin, conversation_id from kernel.audit_log where process_id = 'core.party.create' order by occurred_at desc limit 1`;
  expect(audit.origin).toBe("agent"); expect(audit.conversation_id).toBe(conversationId);
});
it("a step-up process confirmation without a step-up token returns step_up_required", async () => { ... });
it("over the monthly token limit the turn makes no model call", async () => { /* limit:ai_tokens_month = 10, llm_usage seeded 11 → reply errors.ai_budget_exceeded, mock model not called */ });
```

- [ ] **Step 3: Run to verify they fail, implement, run to verify they pass**

Run: `pnpm -F @erp/agent test && pnpm -F @erp/agent test:integration`
Expected: PASS. `agentTurn` uses the AI SDK `WorkflowAgent` from `@ai-sdk/workflow` (the former `DurableAgent` of `@workflow/ai` is deprecated and pinned to ai@6) with `maxSteps: 12`; tool `execute` functions that touch the DB are `"use step"`; the model string comes from `resolveModel` (gateway ids like `anthropic/claude-opus-5.5`); usage is read from the step result and written by `recordUsage`.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/0016_kernel_agent.sql packages/agent apps/web/src/app/api/agent
git commit -m "feat(agent): registry-generated tools, durable turns, confirmations, model policy and usage limits"
```

---

## Task 18: Assistant drawer UI with confirmation and step-up cards

**Files:**
- Create: `packages/ui/src/assistant/AssistantDrawer.tsx` (replaces the Task 12 placeholder), `MessageList.tsx`, `ConfirmationCard.tsx`, `StepUpField.tsx`, `ResultTable.tsx`, `Composer.tsx`, `packages/ui/src/assistant/use-assistant.ts` (AI SDK `useChat` against `/api/agent/turn`, screen context from the active tab)
- Test: `packages/ui/src/assistant/__tests__/ConfirmationCard.test.tsx`, `use-assistant.test.tsx`

**Interfaces:**
- Produces: `<AssistantDrawer conversationId screen={ScreenContext} />`; `ConfirmationCard` props `{ processId, preview: { title, effects: {label, value}[], permission: string, stepUp: boolean }, onDecide(decision, stepUpToken?) }` renders the card from the mockup (light-blue header, effects grid, Confirmar / Editar / Cancelar; when `stepUp` shows `StepUpField` that POSTs `/api/auth/step-up` and passes the token); `ResultTable` renders a `data.query` result with buttons "Abrir como grid" (opens a tab with the state), "Excel" (calls export), "Guardar reporte" (plan 5, disabled with tooltip).

- [ ] **Step 1: Write the failing component tests** (card shows every effect row and calls `onDecide("confirm")`; with `stepUp` the Confirmar button is disabled until a 6-digit code is verified; `use-assistant` sends `screen.route` with each turn)

- [ ] **Step 2: Run to verify they fail, implement, run to verify they pass**

Run: `pnpm -F @erp/ui test -t assistant`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/ui/src/assistant packages/ui/src/shell/AppShell.tsx
git commit -m "feat(ui): assistant drawer with streaming, confirmation and step-up cards"
```

---

## Task 19: Admin: companies, users and roles, permissions, field visibility, sensitive processes, modules, AI usage

> **Controller ruling (2026-10-28):** the admin processes write kernel tables, so rule 3 places them in the kernel module as `kernel.admin.*` (feature `kernel.admin`, step-up by default, files `packages/kernel/src/admin/*`); `core.admin.custom_field.*` → `kernel.custom_field.*`, `core.admin.required_file.*` → `kernel.required_file.*`, `core.admin.verifier.set` → `kernel.verifier.set`; migration `0021_kernel_admin.sql`; new roles get baseline grants and `masked` rows for every `confidential` field through `kernel.seed_role_defaults`; test file `admin.integration.test.ts`. Read `core.admin.` below as `kernel.admin.`.


**Files:**
- Create: `packages/modules/core/src/processes/admin.ts` (processes below), `apps/web/src/app/(app)/admin/{companies,users,roles,permissions,fields,extra,required-files,sensitive,verifiers,modules,ai-usage}/page.tsx`
- Additions decided 2026-10-27: `core.admin.role.create/update` take `{ name, description, partyScope }` and `core.admin.user_role.set` assigns from either side; `core.admin.user.create` takes `{ name, email, mobileCc, mobile, roleIds[], photo? }` (validated with `validateEmail`/`validatePhone`, at least one role) and sends the invitation; `core.admin.custom_field.set/remove` (spec §5.14), `core.admin.required_file.set/remove` (spec §5.13), `core.admin.verifier.set` (spec §5.16); the permission matrix page shows the entity name from `ENTITY_NAMES` beside each process id. Tests to add: `user.create without mobile → invalid_input`, `role.create with partyScope clientes hides suppliers from that role in core.v_parties`, `required_file.set then a party without that file has invoice_ready false`.
- Test: `packages/modules/core/src/__tests__/admin.test.ts`

**Interfaces:**
- Produces processes (module `core`, feature `core.admin`, all `step-up` sensitivity by default seed): `core.admin.company.update`, `core.admin.user.invite` (Supabase admin invite + membership), `core.admin.role.create/update`, `core.admin.permission.set` (input `{ roleId, processId, allowed }`), `core.admin.permission.matrix` (consult: processes × roles for the company), `core.admin.field_permission.set`, `core.admin.sensitive_process.set`, `core.admin.module.enable/disable` (wraps `enableModule`), `core.admin.ai_usage.consult` (monthly tokens and cost per user, against limit). Pages: permission matrix grid (roles as columns, processes grouped by module, checkbox per kind), field visibility editor per entity and role, modules page with on/off and dependency hints, AI usage page with the allowance bar.

- [ ] **Step 1: Write the failing tests** (`permission.set` by a non-admin → forbidden; `module.disable core` → refused because support depends on it; `ai_usage.consult` sums the seeded `llm_usage`; every admin process is listed in `sensitive_processes` after seed)

- [ ] **Step 2: Run to verify they fail, implement, run to verify they pass**

Run: `pnpm -F @erp/module-core test:integration -t admin`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/modules/core/src/processes/admin.ts "apps/web/src/app/(app)/admin" packages/modules/core/src/__tests__/admin.test.ts
git commit -m "feat(admin): roles, permission matrix, field visibility, sensitive processes, modules and AI usage"
```

---

## Task 20: Home screen (KPIs, recommendations inbox, recent grid)

**Addition decided 2026-10-27:** the home is a widget dashboard (`packages/ui/src/home/Dashboard.tsx`, `Widget.tsx`): 4-column CSS grid, widgets draggable by header (HTML5 drag and drop) to relocate and resizable from the corner (span 1–4, free height), layout persisted per user in `kernel.user_prefs(user_id, key 'home_layout', value jsonb)` through `kernel.user_prefs.set`, with reset to the role default. Tests to add: `dropping widget 5 on slot 1 reorders and persists`, `resizing to span 2 persists and survives reload`, `an unknown widget id in saved prefs falls back to the default layout`.

**Files:**
- Create: `supabase/migrations/0017_kernel_recommendations.sql` (`kernel.recommendations(id, company_id, audience_role_id null, user_id null, agent_profile text, title, body, evidence jsonb, suggested_actions jsonb, confidence numeric, status text check in ('new','accepted','dismissed'), created_at, decided_at)`; background agents that fill it arrive in plan 3; phase 1 seeds two example rows for the demo company)
- Create: `packages/kernel/src/home/kpis.ts` (`kernel.home.kpis` consult process: counts of parties and products, open tickets, AI tokens used; sales KPIs arrive in plan 2 through a `HomeKpiProvider` interface modules register), `apps/web/src/app/(app)/page.tsx`, `packages/ui/src/home/KpiCard.tsx`, `RecommendationCard.tsx`
- Test: `packages/kernel/src/__tests__/home.test.ts`, `packages/ui/src/home/__tests__/RecommendationCard.test.tsx`

**Interfaces:**
- Produces: `interface HomeKpiProvider { id: string; feature: string; compute(ctx: ProcessContext): Promise<Kpi[]> }`, `registry.registerKpiProvider(p)`; `kernel.recommendation.decide` process (input `{ id, decision: "accepted"|"dismissed" }`; an accepted suggested action opens the assistant with that process pre-filled as a confirmation).

- [ ] **Step 1: Write the failing tests** (KPI process returns providers whose feature is entitled only; `RecommendationCard` renders actions and calls `onAction(processId, input)`)

- [ ] **Step 2: Run to verify they fail, implement, run to verify they pass**

Run: `pnpm -F @erp/kernel test:integration -t home && pnpm -F @erp/ui test -t Recommendation`
Expected: PASS. Visual check against the blue mockup.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/0017_kernel_recommendations.sql packages/kernel/src/home packages/ui/src/home "apps/web/src/app/(app)/page.tsx"
git commit -m "feat(home): KPI providers, recommendations inbox and recent grid on the home screen"
```

---

## Task 21: Outbox tick route, docker-compose with Postgres World, CI integration job

**Files:**
- Create: `apps/web/src/app/api/internal/outbox/tick/route.ts` (POST, header `x-internal-token`, calls `drainOutbox`; `vercel.json` cron `* * * * *` on Vercel, pg_cron/`curl` loop in Docker)
- Create: `packages/infra/src/index.ts` (`DurableRunner`, `Scheduler`, `ModelProvider`, `FileStore`, `Mailer` interfaces with `cloud` and `docker` implementations chosen by `ERP_TARGET=vercel|docker`), `apps/worker/` (Node 22 container: `start()` of the Workflow Postgres World, outbox tick loop every 30 s)
- Create: `docker-compose.yml` (self-hosted Supabase services from the official compose, `web` built from `apps/web` with `output: "standalone"`, `worker`, `workflow-web` on an internal network), `Dockerfile.web`, `Dockerfile.worker`, `.env.docker.example`
- Modify: `.github/workflows/ci.yml` (job `docker-integration`: `docker compose up -d`, wait for health, run `pnpm test:integration` against the compose Postgres with `WORKFLOW_TARGET_WORLD=postgres`)
- Test: `packages/infra/src/__tests__/target.test.ts`, `apps/web/src/app/api/internal/__tests__/tick.test.ts`

**Interfaces:**
- Produces: `infra.target(): "vercel"|"docker"`; `WORKFLOW_TARGET_WORLD`, `WORKFLOW_POSTGRES_URL` env wiring per the Workflow docs (`node_modules/workflow/docs/` is authoritative at implementation time; run `npx workflow health` in the worker container as the compose healthcheck).

- [ ] **Step 1: Write the failing tests** (tick without the token → 401; with it → drains and returns `{ dispatched: n }`; `target()` reads `ERP_TARGET` and defaults to `vercel`)

- [ ] **Step 2: Run to verify they fail, implement, run locally with `docker compose up`, run to verify they pass**

Run: `pnpm -F web test:integration -t tick && docker compose up -d && pnpm test:integration && docker compose down`
Expected: PASS in both environments; CI shows `unit`, `integration`, `docker-integration` green.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/app/api/internal packages/infra apps/worker docker-compose.yml Dockerfile.web Dockerfile.worker .env.docker.example .github/workflows/ci.yml vercel.json
git commit -m "feat(infra): outbox tick, docker-compose with Workflow Postgres World and CI integration job"
```

---

## Task 22: Seed, demo company and end-to-end smoke

**Files:**
- Create: `supabase/seed.sql` (tenant "Demo", company "Café del Norte S.A.S." NIT 900373115-3, roles `admin`, `gerente_comercial`, `contador`, `cajero`, users `laura@demo.local` (admin + gerente), `marcela@demo.local` (cajero), permissions: admin all; cajero consult only on `core.*`; `credit_limit` hidden for cajero; `core.party.deactivate` sensitive; entitlements `module:core`, `module:support`, `limit:ai_tokens_month = 2000000`; 40 parties, 25 products, 2 recommendations), `scripts/seed-help-index.ts`
- Create: `apps/web/e2e/smoke.spec.ts`
- Modify: `README.md` (run locally, run in Docker, run tests)

- [ ] **Step 1: Write the failing e2e**

```ts
test("login, grid, export, agent consult, agent confirmed write, audit", async ({ page }) => {
  await login(page, "laura@demo.local");                       // includes TOTP from the seeded secret
  await page.getByRole("link", { name: "Clientes" }).click();   // opens a tab
  await page.getByLabel("Filtrar nombre").fill("Éxito");
  await expect(page.getByRole("row")).toHaveCount(2);           // header + 1
  await page.getByRole("button", { name: "Excel" }).click();    // download event with .xlsx
  await page.getByRole("button", { name: "Asistente" }).click();
  await page.getByLabel("Pide algo").fill("crea el cliente Panadería La Espiga, NIT 800197268-4");
  await page.keyboard.press("Enter");
  await expect(page.getByText("Confirmar")).toBeVisible();
  await page.getByRole("button", { name: "Confirmar" }).click();
  await expect(page.getByText(/creado/i)).toBeVisible();
  await page.goto("/admin/audit");
  await expect(page.getByRole("row", { name: /core\.party\.create.*agent/ })).toBeVisible();
});
test("cajero never sees credit_limit and cannot run party.create through the agent", async ({ page }) => { ... });
```
(The e2e runs the agent against the real gateway in CI only when `AI_GATEWAY_API_KEY` is set; otherwise `AGENT_MODEL=mock` makes `resolveModel` return a mock model with a scripted tool call. Add `kernel.audit.consult` and an `/admin/audit` grid in this task.)

- [ ] **Step 2: Run to verify it fails, write the seed and the audit page, run to verify it passes**

Run: `pnpm db:reset && pnpm -F web e2e`
Expected: PASS.

- [ ] **Step 3: Commit and tag**

```bash
git add supabase/seed.sql scripts apps/web/e2e/smoke.spec.ts README.md "apps/web/src/app/(app)/admin/audit"
git commit -m "feat: demo seed, audit viewer and end-to-end smoke for phase 1"
git tag phase-1-foundation
```

---

## Self-review notes

- Spec coverage for phase 1: §5.1–5.5, 5.7 (sequences), 5.9, 5.10 partially (tick route; scheduler tables in plan 3), 5.12, §6 all rows, §7.1 tool families process/query/help/support/navigation (forms, reports, docs, sim, messaging, scheduler are plans 2b–5), §7.4 model policy, §7.5 guardrails (budget, masks, no free SQL; the `analyst` read-only SQL tool is deferred to plan 5), §8 core and support rows, §9, §15, §16, §19a, §21 CI path, §22 decisions 1, 3, 4, 6. Posting engine (§5.6) explicitly moved to plan 2.
- Names used across tasks: `runProcess`, `Caller`, `JwtClaims`, `withClaims`, `registry`, `entitled`, `enableModule`, `enqueueEvent`, `drainOutbox`, `buildQuery`, `GridState`, `buildTools`, `decideConfirmation`, `resolveModel` are defined once and reused by those names.
- Review Focus tests are placed in Tasks 2, 4, 5, 10, 13, 14, 17, 18.
