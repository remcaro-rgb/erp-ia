---
tags: [area, architecture]
date: 2026-11-07
status: active
---

# Architecture Overview

pnpm monorepo (Next.js 16 App Router, Supabase, Vercel AI SDK + Workflow DevKit, shadcn + Tailwind v4, Vitest + Playwright).

## Apps
- `apps/pos`: README.md
- `apps/web`: .DS_Store, .env.example, .env.hosted.local, .env.local, .gitignore, .next, .swc, .turbo, AGENTS.md, e2e, guide-shots, next-env.d.ts
- `apps/worker`: .DS_Store, .turbo, node_modules, package.json, src, tsconfig.json, vitest.config.ts

## Packages
- `packages/agent`
- `packages/i18n`
- `packages/infra`
- `packages/kernel`
- `packages/localization`
- `packages/modules`
- `packages/ui`

## Kernel subsystems (`packages/kernel/src`)
`admin`, `ai`, `attachments`, `audit`, `custom-fields`, `db`, `einvoice`, `entitlements`, `events`, `exports`, `files`, `help`, `home`, `import`, `index.ts`, `localization`, `module`, `posting`, `process`, `query`, `records`, `registry`, `reports`, `saved-views`, `security`, `templates`, `testing.ts`, `typed`, `user-prefs`, `users`, `validation.ts`, `verify`, `workflows.ts`, `zod-locale.ts`

Localization pack: [[Localization co]]. Modules: [[Modules]]. Data: [[Migrations Catalog]]. Rules: [[Project Rules]].
