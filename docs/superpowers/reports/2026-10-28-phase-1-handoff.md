# Phase 1 · Fundación — hand-off report

Date: 2026-10-28 · Branch `phase-1-foundation` (base `1d0bb4c`, tip `ac2e2db`, local annotated tag `phase-1-foundation`) · Nothing pushed or merged.
Execution: subagent-driven (fresh implementer + fresh reviewer per task, fix loops, final whole-branch review on the most capable model). Plan: `docs/superpowers/plans/2026-10-27-phase-1-foundation.md` (24 tasks incl. 9b, 9c, 12b, 13b).

## Result
- 24 tasks complete, each with a clean task review; final whole-branch review: 0 Critical, 4 Important (all fixed except the two owner items below), 13 minor (8 fixed, rest parked).
- Verification on the tip: lint, typecheck, `check:rules`, unit 718, integration (kernel 207, core 102, support 32, agent 39, web 70, run serially), web build, Playwright 27/27 after `pnpm db:reset && DEMO_SEED=1 pnpm db:seed`, Docker test stack smoke through the edge 2/2, production compose boots with no demo data.
- Migrations `0001`–`0024`; migrations edited in place before shipping: 0001–0007, 0017, 0018, 0021 (no database outside local resets has applied them; frozen from the first push).

## Owner decisions needed (record in design §22)
1. Rule 30 evaluation set (Spanish prompts → expected tool calls) does not exist; recommendation: start it at the beginning of phase 2.
2. PDF export caps: 2,000 rows inline / 10,000 per job (`pdf_too_large`) vs rule 20 "all pages".
3. Imports of a sensitive entity stop at the first `step_up_required`; should the import's step-up cover row creation?
4. Step-up tokens are single-use per run (two codes to edit a role and its users) vs a 5-minute window (rule 15 wording).
5. Docker applies migrations with `psql` in the init job vs rule 34 "applied by the Supabase CLI".
6. Admin processes are `kernel.admin.*` in the kernel module (rule 3), not `core.admin.*` as the plan said.
7. `data.query` is the registered consult process `kernel.data.query` (rule 1) rather than a built-in tool; `ui.navigate`/`ui.open_record` stay built-in (no server-side effect).
8. Support's agent marker is `kernel.can_run_process('support.ticket.close')`.
9. Field visibility across several roles: most restrictive wins (plan) while process permissions add up.
10. Kernel system user (nil uuid) keeps its claimed admin role only on service connections (migration 0024 carve-out); a positive service-session check is the cleaner fix for phase 2/3.
11. Design §22.1 says single-company UI until phase 3 while rule 19/prototype ship the company switcher in phase 1.
12. Gateway model ids carry dots (`anthropic/claude-opus-5.5`); rules/plan text corrected (factual fix, not a decision).

## Parked for phase 2 (from the final review)
- Process-GUC write guard generalised to every module table (core tables lack it; unreachable today).
- Module write-guard hook for attachments (a `clientes` role can touch files on a customer+supplier party).
- `check:rules` extended to `.ts` user copy and model-id literals; `@erp/ui` default labels through the catalogue; `DEFAULT_EMBEDDING_MODEL` constant.
- `mask_extra` per-row cost and HNSW post-filtering at scale; assistant columns per layout load.
- On-prem (phase 6): first-tenant bootstrap, signup off, external API/storage URLs behind the edge, signed URLs with the internal host.
- Full list with reasons: the final review's triage table (archived with the SDD ledger).

## Not in the branch
- `docs/roadmap.md` has uncommitted owner edits (accounting module items, 2026-10-28) and three untracked `docs/superpowers/specs/2026-10-28-accounting-module-*` files; left as the owner's work.

## Demo
`pnpm db:reset && DEMO_SEED=1 pnpm db:seed` → Café del Norte S.A.S. (NIT 900373115-3), `laura@demo.local` (admin + gerente_comercial, TOTP seeded, local only), `marcela@demo.local` (cajero). See README.
