---
tags: [inbox, sync]
date: 2026-11-07
status: active
---

# Inbox Log

Back to [[000_Index]].

## Initial technical summary (2026-11-07)

pnpm monorepo (Next.js 16 web, POS and worker apps), Supabase Postgres with forward-only migrations and RLS, Vercel AI SDK. Packages: agent, i18n, infra, kernel, localization, modules, ui. About 1,090 .ts, 340 .tsx and 125 .sql files tracked. Current branch `phase-2b-sales-chain`, phase 2B work. Rules: `docs/project-rules.md`; roadmap: `docs/roadmap.md`. See [[10_Projects]] and [[20_Areas]].

## Sync 2026-11-07 08:40 (branch `phase-2b-sales-chain`)

### Recent commits
- `af8b1bf` feat(kernel): recommendation API, consumed by auto-invoice refusals and costing (2B.2 task 38) (2026-11-07)
- `65d0579` feat(core): price list create and item processes, seeded Mayoristas list (2B.2 task 51) (2026-11-06)
- `eb7b362` feat(demo): tercero on NC-18, real 1007 XML in the e2e, seed from zero (2B.2 tasks 46, 47) (2026-11-06)
- `7957b95` docs(2b): expand demo-batch tasks 46, 47, 51 and settle owner items 55, 56; record item 57 (2026-11-06)
- `406435d` feat: module needs and shortcuts, small-fixes batch (2B.2 tasks 41, 42, 50) (2026-11-06)
- `7013f87` docs(2b): expand small-batch tasks 40, 41, 42, 48, 50 and record new owner items 42-54 (2026-11-06)
- `72d8d42` feat(worker): refuse or warn on a stale module list (2B.2 task 48) (2026-11-06)
- `7be2f41` test(rules): guard unmasked module views (2B.2 task 40) (2026-11-06)
- `5d36bb9` docs(rules): rule 16 dry-run denial exception (owner 2026-11-06, design §22.28) (2026-11-06)
- `dbad54e` docs(2b): owner decisions round two, design §22.28, 2B.2 plan tasks 32-50 (2026-11-06)
- `25f56e1` docs(2b): record causal chain ratification and document link table (design §22.27, plan Task 31) (2026-11-06)
- `d87e2fe` docs(2b): record owner confirmation of design §22 item 26 (2026-11-06)
- `60afa3a` docs(2b): phase 2B.1 user guides, roadmap, design §22 items, owner decisions pending (2026-11-06)
- `bf53d9d` feat(2b): sales-to-ledger chain, web (module pages, record frame, Terceros UI) (2026-11-06)
- `083164d` feat(2b): sales-to-ledger chain, backend (inventory, costing, crm, sales, invoicing, payments) (2026-11-06)

### Architecture
- `apps/`: pos web worker 
- `packages/modules/`: accounting core costing crm inventory invoicing payments sales support 
- tracked files: 1841 (.ts 1086, .tsx 340, .sql 125, .md 118)

## Sync 2026-11-07 09:24 (branch `phase-2b-sales-chain`)

### Recent commits
- `af8b1bf` feat(kernel): recommendation API, consumed by auto-invoice refusals and costing (2B.2 task 38) (2026-11-07)
- `65d0579` feat(core): price list create and item processes, seeded Mayoristas list (2B.2 task 51) (2026-11-06)
- `eb7b362` feat(demo): tercero on NC-18, real 1007 XML in the e2e, seed from zero (2B.2 tasks 46, 47) (2026-11-06)
- `7957b95` docs(2b): expand demo-batch tasks 46, 47, 51 and settle owner items 55, 56; record item 57 (2026-11-06)
- `406435d` feat: module needs and shortcuts, small-fixes batch (2B.2 tasks 41, 42, 50) (2026-11-06)

### Architecture
- `apps/`: pos web worker 
- `packages/modules/`: accounting core costing crm inventory invoicing payments sales support 
- tracked files: 1841 (.ts 1086, .tsx 340, .sql 125, .md 118)
