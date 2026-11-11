---
tags: [resource, tooling]
date: 2026-11-07
status: active
---

# Scripts and tooling

## package.json scripts
```
"scripts": {
    "dev": "turbo run dev --filter=web",
    "build": "turbo run build",
    "test": "vitest run",
    "test:integration": "turbo run test:integration --concurrency=1",
    "test:changed": "vitest run --changed main",
    "test:integration:changed": "turbo run test:integration --concurrency=1 --affected -- --changed main",
    "lint": "eslint .",
    "typecheck": "turbo run typecheck",
    "check:rules": "tsx scripts/check-rules.ts",
    "db:reset": "tsx scripts/db-reset.ts",
    "with-env": "tsx scripts/with-env.ts",
    "hosted": "tsx scripts/with-env.ts --env apps/web/.env.hosted.local",
    "db:seed": "tsx scripts/seed.ts",
    "evals": "tsx scripts/evals.ts",
    "db:migrate:new": "tsx scripts/new-migration.ts",
    "help:index": "tsx scripts/help-index.ts",
    "docker:env": "tsx scripts/docker-env.ts",
    "docker:up": "docker compose --env-file .env.docker up -d --build --wait",
    "docker:test:up": "docker compose -f docker-compose.yml -f docker-compose.test.yml --env-file .env.docker up -d --build --wait",
    "docker:down": "docker compose -f docker-compose.yml -f docker-compose.test.yml --env-file .env.docker --profile tools down -v"
  }
```

## Files
- `.github/workflows/ci.yml`
- `.github/workflows/evals.yml`
- `.github/workflows/mirror-images.yml`
- `docker/db-init.sh`
- `docker/edge/default.conf.template`
- `docker/images.txt`
- `docker/mirror-images.sh`
- `docker/supabase/kong.yml`
- `docker/supabase/roles.sql`
- `scripts/__tests__/check-rules.test.ts`
- `scripts/__tests__/docker-env.test.ts`
- `scripts/__tests__/guide-images.test.ts`
- `scripts/__tests__/help-index.test.ts`
- `scripts/__tests__/new-migration.test.ts`
- `scripts/__tests__/seed-accounting.test.ts`
- `scripts/__tests__/seed-data.test.ts`
- `scripts/__tests__/seed-demo.integration.test.ts`
- `scripts/check-rules.ts`
- `scripts/db-reset.ts`
- `scripts/demo/accounting.ts`
- `scripts/demo/accounts.ts`
- `scripts/demo/data.ts`
- `scripts/demo/ledger-data.ts`
- `scripts/demo/sales.ts`
- `scripts/docker-env.ts`
- `scripts/env.ts`
- `scripts/evals.ts`
- `scripts/help-index.ts`
- `scripts/i18n-move.ts`
- `scripts/new-migration.ts`
- `scripts/seed.ts`
- `scripts/share/update-site.sh`
- `scripts/share/upload-dev.sh`
- `scripts/vitest.config.ts`
- `scripts/with-env.ts`

Brain sync: `scripts/sync-brain.sh`.
