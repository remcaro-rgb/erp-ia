# ERP-IA

A multi-tenant ERP + CRM for Latin America where the assistant is a first-class user: every action is a registered
process that the screens, the assistant, the scheduler and the API run under the same permissions and the same audit.
Phase 1 (foundation) ships the kernel, the core module (parties, products, categories), the universal grid with exports
and imports, sign-in with TOTP, administration, the audit viewer, support tickets and the assistant.

Read first: [`CLAUDE.md`](CLAUDE.md) (instructions for every contributor), [`docs/project-rules.md`](docs/project-rules.md)
(the 36 rules), the design [`docs/superpowers/specs/2026-10-26-erp-ia-design.md`](docs/superpowers/specs/2026-10-26-erp-ia-design.md),
the [roadmap](docs/roadmap.md) and the user guides in [`docs/user-guide/es-419`](docs/user-guide/es-419/README.md).

Stack: pnpm monorepo, Next.js 16 (App Router), Supabase (Postgres, Auth, Storage), Vercel AI SDK + Workflow DevKit,
shadcn + Tailwind v4, TanStack Table, Vitest and Playwright. Node 22 or later, pnpm 10, Docker, Supabase CLI 2.117.

## Run locally

```bash
pnpm install
cp apps/web/.env.example apps/web/.env.local   # the CLI stack's public demo keys; set a gateway key or AGENT_MODEL=mock
supabase start        # the local stack: API on 127.0.0.1:55321, database on 127.0.0.1:54322
pnpm db:reset         # migrations + supabase/seed.sql (tenant, company, roles, entitlements)
DEMO_SEED=1 pnpm db:seed   # the demo company: Auth users, people and permissions, 40 parties, 25 products, files
pnpm help:index       # the assistant's help index (deterministic embeddings without AI_GATEWAY_API_KEY)
pnpm dev              # http://localhost:3000
```

The seed has two halves. `supabase/seed.sql` holds what needs no registry and runs with every `supabase db reset` (and
in the Docker init job). `pnpm db:seed` (`scripts/seed.ts`) does the rest the way the app would: it registers the
modules' manifests, enables the modules, creates the Auth users through the Auth Admin API, and sets the permissions and
creates the master data and the required files through the registered processes, signed in as Laura with her TOTP code,
so the audit, the outbox and the consecutive numbers are real (only Laura's first admin membership is written directly).
It is idempotent, runs only with `DEMO_SEED=1` and refuses any stack that is not local.

The assistant's model: set `AI_GATEWAY_API_KEY` to use the AI Gateway with the models of `kernel.model_policies`, or
`AGENT_MODEL=mock` to run every turn with the AI SDK mock model (a test double, no provider). The mock answers «busca el
cliente Éxito» and «crea el cliente Panadería La Espiga, NIT 800197268-4» (a wrong DV is refused by the country pack),
refuses what the user's role may not do, and is metered as `mock/agent` at no cost. A production server refuses it
unless `ALLOW_MOCK_MODEL=1` (only the Docker test stack sets it).

### Demo accounts (local use only)

| Account | Password | Roles | Second step |
| --- | --- | --- | --- |
| `laura@demo.local` | `demo-laura-2026` | admin + gerente comercial | TOTP, secret `CAFEDELNORTEDEMOLAURATOTPSECRETX` |
| `marcela@demo.local` | `demo-marcela-2026` | cajero | none |

Company: Café del Norte S.A.S., NIT 900373115-3 (country pack `co`, COP, America/Bogota). Add Laura's secret to an
authenticator app as a manual key (TOTP, SHA1, 6 digits, 30 s). Marcela sees customers only, never the credit limit
(hidden for the cajero role), and has no write tool in the assistant. Six parties (Éxito among them) have their RUT and
Cámara de Comercio and are invoice-ready. These passwords and the secret are public: never seed them into a stack
anyone else can reach (`pnpm db:seed` needs `DEMO_SEED=1` and only accepts local hosts; the production compose file has
no seed job).

## Run in Docker

The Docker target (design §21) runs the self-hosted Supabase services, the web app behind an nginx edge, the Workflow
worker and the init jobs (migrations, the Workflow schema, the help index). `docker-compose.yml` alone (`pnpm
docker:up`) brings up a stack with no demo data. `docker-compose.test.yml` (`pnpm docker:test:up`) adds the test pieces:
the published ports, `supabase/seed.sql` and the `seed` job (the demo company and accounts) and the mock model.

```bash
pnpm docker:env       # once: .env.docker with fresh local-only secrets (never commit it)
pnpm docker:test:up   # the test stack: demo company, mock model, database (56322), API (56321), Mailpit (56324)
# the app: http://127.0.0.1:56300 (the edge, the only port docker:up publishes), demo accounts as above
pnpm docker:down      # stop and drop the volumes
```

`pnpm docker:up` starts the production stack: no published test ports, no demo, the gateway for the assistant (set
`AI_GATEWAY_API_KEY` in `.env.docker`; `AGENT_MODEL=mock` makes the web app refuse to start there).

## Run the tests

```bash
pnpm lint && pnpm typecheck && pnpm check:rules   # lint, types, the mechanical rules (docs/project-rules.md)
pnpm test                                        # unit tests (Vitest)
pnpm test:integration                            # against the CLI stack, one package at a time
pnpm db:reset && DEMO_SEED=1 pnpm db:seed && pnpm -F web e2e   # Playwright, every spec, `next dev` on 3217
pnpm -F web build                                # the production build
```

The end-to-end specs start `next dev` on port 3217 themselves with `AGENT_MODEL=mock` (unless `AI_GATEWAY_API_KEY` is
set); outside CI they reuse a server already running on that port. `e2e/smoke.spec.ts` is the phase 1 smoke on the demo company: Laura
signs in with her TOTP code, filters Terceros, exports to Excel, asks the assistant, confirms a party it prepares and
finds that write in Administración › Auditoría with origin `agent`; Marcela never sees the credit limit and cannot
create a party through the assistant.

The same smoke against the Docker stack (after `pnpm docker:test:up`):

```bash
set -a; . ./.env.docker; set +a
E2E_BASE_URL="http://127.0.0.1:${WEB_HOST_PORT}" \
DATABASE_URL="postgresql://postgres:${POSTGRES_PASSWORD}@127.0.0.1:${DB_HOST_PORT}/postgres" \
  pnpm -F web exec playwright test e2e/smoke.spec.ts
```

CI (`.github/workflows/ci.yml`) runs the unit job, the integration job on the CLI stack, the e2e job (CLI stack, demo
seed, every spec) and the Docker job (worker smoke, this smoke through the edge, the integration suites on the compose
stack).
