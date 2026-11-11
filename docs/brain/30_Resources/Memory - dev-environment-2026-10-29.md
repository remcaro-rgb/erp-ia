---
tags: [resource, memory]
date: 2026-11-07
status: active
---

# Memory: dev-environment-2026-10-29

_Copied from Claude auto-memory._

Decision recorded in design §22.18 (2026-10-29). Development runs on the local Supabase CLI stack in Docker through OrbStack (VM capped 6 GB / 6 CPUs; Docker Desktop retired). The hosted project `gextacnxvjshibrjlblq` (us-east-2, transaction pooler port 6543) and the Vercel project `erpia` (GitHub `remcaro-rgb/erp-ia`, production branch `main`, deployment behind Vercel login at https://erpia-six.vercel.app, Hobby plan → daily cron only) are the shared demo and the deployed app. `apps/web/.env.local` = local; `apps/web/.env.hosted.local` = hosted, reached with `pnpm hosted <cmd>` (scripts/env.ts honours ENV_FILE). Hosted seed needs `DEMO_SEED=1 DEMO_SEED_REMOTE=1`. The hosted project's auth hook was enabled by hand in the dashboard; the Supabase CLI is logged into a different account, so `supabase link` does not work (use `--db-url`).

**Why:** the integration suites take ~2 min locally and ~65 min over the internet (one round trip per statement); the session pooler admits 15 clients.

**How to apply:** briefs say: before a commit run lint, typecheck, check:rules, unit, `pnpm test:integration:changed`, the touched e2e specs against :3100, and the build; the full suites run in GitHub Actions on the push and gate task completion. Never run the full integration suites against the hosted project. Related: [[Memory - dev-server-hygiene]], [[Memory - enforce-rules-and-design]].

Index: [[Memory Notes]].
