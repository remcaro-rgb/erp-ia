# ERP-IA

A multi-tenant ERP + CRM for Latin America where the assistant is a first-class user: every action is a registered
process that the screens, the assistant, the scheduler and the API run under the same permissions and the same audit.
Phase 1 (foundation) ships the kernel, the core module (parties, products, categories), the universal grid with exports
and imports, sign-in with TOTP, administration, the audit viewer, support tickets and the assistant.

Read first: [`CLAUDE.md`](CLAUDE.md) (instructions for every contributor), [`docs/project-rules.md`](docs/project-rules.md)
(the 36 rules), the design [`docs/superpowers/specs/2026-10-26-erp-ia-design.md`](docs/superpowers/specs/2026-10-26-erp-ia-design.md),
the [roadmap](docs/roadmap.md) and the user guides in [`docs/user-guide/es-419`](docs/user-guide/es-419/README.md).

Stack: pnpm monorepo, Next.js 16 (App Router), Supabase (Postgres, Auth, Storage), Vercel AI SDK + Workflow DevKit,
shadcn + Tailwind v4, TanStack Table, Vitest and Playwright. Node 22.2 or later, pnpm 10, Docker, Supabase CLI 2.117.

## Run locally

Development runs on the local Supabase stack, in Docker through OrbStack (decision 2026-10-29, design §22.18). The hosted
project and Vercel are the shared demo and the deployed app, see "Hosted demo and Vercel" below.

```bash
pnpm install
cp apps/web/.env.example apps/web/.env.local   # the local stack's public demo keys are already in it
supabase start        # the local stack: API on 127.0.0.1:55321, database on 127.0.0.1:54322
pnpm db:reset         # migrations + supabase/seed.sql (tenant, company, roles, entitlements)
DEMO_SEED=1 pnpm db:seed   # the demo company: Auth users, people and permissions, 40 parties, 25 products, files, the 2026 ledger
pnpm dev              # http://localhost:3000
```

Every write of the demo goes through registered processes (`pnpm db:seed`, `scripts/seed.ts`): it registers the
manifests, enables the modules, creates the Auth users and lets the people, parties and products in through the same
processes the app uses, so the demo is a faithful sample of what the app can produce.

The assistant needs a model: `AI_GATEWAY_API_KEY` for the AI Gateway (metered per `kernel.model_policies`), or
`AGENT_MODEL=mock` for the AI SDK mock model, which a production server refuses unless `ALLOW_MOCK_MODEL=1` (only the
Docker test stack sets it).

### Before a commit

```bash
pnpm lint && pnpm typecheck && pnpm check:rules && pnpm test
pnpm test:integration:changed        # the integration files whose imports changed since main (all: pnpm test:integration, ~2 min)
E2E_BASE_URL=http://localhost:3100 pnpm -F web e2e e2e/<spec>.spec.ts   # the specs the change touches, against the running dev server
pnpm -F web build
```

The full integration and e2e suites and the compose stack run in GitHub Actions on every push; a task is complete only
when that run is green.

### Hosted demo and Vercel

`apps/web/.env.hosted.local` (not committed) holds the hosted project's URL, keys, password and transaction-pooler URL
(port 6543). `pnpm hosted <command>` runs anything with it: `pnpm hosted pnpm db:reset`, `DEMO_SEED=1 DEMO_SEED_REMOTE=1
pnpm hosted pnpm db:seed`, `pnpm hosted pnpm -F web dev`. The project is shared and may be wiped; it holds demo data only.
Vercel builds `apps/web` from every push to `main` (project `erpia`); the deployment is behind Vercel's login because the
demo passwords are public. The access-token hook must be enabled once in the hosted project's dashboard
(Authentication › Hooks › `kernel.custom_access_token_hook`).

### Demo accounts (local use only)

| Account | Password | Roles | Second step |
| --- | --- | --- | --- |
| `laura@demo.local` | `demo-laura-2026` | admin + gerente comercial | TOTP, secret `CAFEDELNORTEDEMOLAURATOTPSECRETX` |
| `marcela@demo.local` | `demo-marcela-2026` | cajero | none |
| `andres@demo.local` | `demo-andres-2026` | contador | none |

Company: Café del Norte S.A.S., NIT 900373115-3 (country pack `co`, COP, America/Bogota). Add Laura's secret to an
authenticator app as a manual key (TOTP, SHA1, 6 digits, 30 s). Marcela sees customers only, never the credit limit
(hidden for the cajero role), and has no write tool in the assistant. Six parties (Éxito among them) have their RUT and
Cámara de Comercio and are invoice-ready. These passwords and the secret are public: never seed them into a stack
anyone else can reach (`pnpm db:seed` needs `DEMO_SEED=1` and only accepts local hosts; the production compose file has
no seed job).

### Accounting demo walkthrough (Contabilidad)

`pnpm db:seed` also leaves the 2026 ledger of Café del Norte (`scripts/demo/accounting.ts`, every write through its process):
the Colombian chart and the seven Fuentes, three centros de costo (Tiendas holds Chapinero and Usaquén), two auxiliares
abiertos, two ítems and four unidades de negocio (the three optional masters turned on), the opening balances of 1 January,
40 posted comprobantes from January to October (invoices, receipts with retefuente and ICA, credit notes, cost of sales,
inventory adjustments and two voids, delivered to the posting engine as synthetic events), October's manual notes
(**Nómina octubre**, the accrual **Acumulación energía octubre** with its auto-reversal draft dated 01/11/2026, a deposit
in the suspense account) and **Provisión de arriendo de octubre**, which Andrés sent to approval. January to September are
closed. Four-eyes is on, and approving a comprobante asks for the TOTP code.

1. **Laura**: Contabilidad › Informes › Balance de prueba, Este período (the totals are equal); Movimientos › Agrupar por
   Cuenta, then Centro de costo (subtotals per group); Períodos (September is closed); ask the assistant «gastos de octubre
   por centro de costo» and open the result as a grid. Por aprobar shows Andrés' provision: she approves it with her code.
2. **Marcela** (cajero) has no access to 5105, class 3 or the Davivienda account: her Balance de prueba folds them into one
   **Cuentas restringidas** row with the same opening and movement totals, the Auxiliar of 510506 answers Sin acceso,
   **Nómina octubre** shows its lines masked and the account lookup of a new comprobante offers no 5105.
3. **Andrés** (contador): Comprobantes › Nuevo, a note with a centro de costo, Enviar a aprobación; the approve button is
   disabled for him, Laura approves it. Borradores holds the accrual's auto-reversal dated 01/11/2026.

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

### Base images and the GHCR mirror (CI)

The compose files and Dockerfiles pull their base images from the public registries by default (`public.ecr.aws/supabase/*`,
`nginx`, `node`), so a developer needs nothing else. GitHub's shared runners exhaust the anonymous pull quota of those
registries, so CI pulls from a mirror in GHCR instead: `ghcr.io/remcaro-rgb/erp-ia/<name>:<tag>`, filled from
`docker/images.txt` (one `<source image> <mirror name>` per line) by the `Mirror base images` workflow. Three variables
select the mirror; `docker-compose.yml` documents them and `ci.yml` sets them:

```bash
SUPABASE_IMAGE_PREFIX=ghcr.io/remcaro-rgb/erp-ia/supabase-   # default public.ecr.aws/supabase/
NGINX_IMAGE=ghcr.io/remcaro-rgb/erp-ia/nginx:1.27-alpine      # default nginx:1.27-alpine
NODE_IMAGE=ghcr.io/remcaro-rgb/erp-ia/node:22-bookworm-slim   # default node:22-bookworm-slim
```

When an image version bumps: change the tag in `docker-compose.yml` (or the `NODE_IMAGE` default in `Dockerfile.web` and
`Dockerfile.worker`), then the same tag in `docker/images.txt` and in the three variables in `ci.yml`. Push to `main`
(the workflow runs on changes to `docker/images.txt`) or run `Mirror base images` from the Actions tab, and only then
run CI: the docker job fails on a tag that is not mirrored yet. The workflow logs in to GHCR with `GITHUB_TOKEN`
(`packages: write`); the CI docker job reads with `packages: read`.

### Producción con Docker (fase 6)

El compose de producción arranca, pero todavía no se puede operar por sí solo: ningún camino crea el primer tenant, su
empresa y su administrador (no hay bootstrap del primer tenant); los enlaces de invitación y las URL de la API apuntan a
`API_EXTERNAL_URL`, que solo publica la capa de prueba (`docker-compose.test.yml`); y las URL firmadas de descarga llevan
el host interno (`kong:8000`). Úsalo para probar el arranque, no para atender usuarios. La entrega on-premise (bootstrap,
registro cerrado, URL externas detrás del edge) es la fase 6 del [roadmap](docs/roadmap.md).

Run the mirror from a developer machine, not from a runner: the public registries throttle GitHub's shared runner IPs
during the copy as well (both mirror runs of 2026-10-29 failed on it). Once, with a token that can write packages:

```bash
gh auth refresh -h github.com -s write:packages
gh auth token | docker login ghcr.io -u "$(gh api user --jq .login)" --password-stdin
docker/mirror-images.sh        # copies every image in docker/images.txt to ghcr.io/<owner>/erp-ia/<name>:<tag>
```

`mirror-images.yml` remains for a manual retry from the Actions tab.

## Deploy on Vercel

The Vercel project's root directory is `apps/web` (the Next app). Its `vercel.json` lives there and registers the cron
that drains the outbox every minute (`GET /api/internal/outbox/tick`, authorized with `CRON_SECRET`); a `vercel.json` at
the repository root would not be read, and the outbox would never drain. `src/lib/vercel-cron.test.ts` checks that every
cron path is a GET route of the app.

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
create a party through the assistant. `e2e/accounting-smoke.spec.ts` is the phase 2A smoke on the demo ledger (the walkthrough
above: Laura, Marcela and Andrés; the comprobante it writes is removed afterwards).

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
