# Prompt · Phase 2B.2 · Task 45 · Landed cost arriving late

Paste this whole file as the first message of a new session in `/Volumes/SATECHI2TB/erp-ia`.

---

You are implementing **Task 45** of the Phase 2B plan of ERP-IA: `docs/superpowers/plans/2026-11-03-phase-2b-sales-stock-chain.md`, section «Expanded task of the landed-cost batch (Task 45; expanded 2026-11-10)». Do this task only.

**Read before starting.** Read `docs/project-rules.md` and the design sections for kernel §5 (processes, posting, outbox), modules §8 and §8.1 (costing and inventory), owner decisions §22 (especially §22.28) and the accounting design `docs/superpowers/specs/2026-10-28-accounting-module-design.md` §5 before starting; follow the plan task verbatim. The main design is `docs/superpowers/specs/2026-10-26-erp-ia-design.md`. Read `CLAUDE.md` too; its orders apply. Read items 36, 37 and 137–139 of `docs/superpowers/plans/2026-11-05-phase-2b-owner-decisions-pending.md`. Items 137–139 are decided as recommended **pending the accountant's confirmation**: build as written, and say in the guide that the accountant confirms.

**Where this task sits.** Branch `phase-2b-sales-chain`. Task 34 (foreign currency) is done. Start from the code in `packages/modules/costing/src/processes/landed-cost.ts`, `allocation.ts`, `rules.ts` and `__tests__/landed-cost.integration.test.ts`; verify in the code what the plan's «Study result» says before changing anything.

**How to work.**
- Test first (rule 31): write the failing tests the task lists, run them and show they fail, implement, run them and show they pass, then run the gates. Use `superpowers:test-driven-development`.
- Work on the branch the owner's session names; do not create another one unless asked.
- Environment: the local Supabase stack (Docker via OrbStack); check Docker is up before `pnpm db:reset`. The dev server is `:3100` through `.claude/launch.json`; never `pkill next-server` (another project runs on `:3000`). Run touched e2e specs with `E2E_BASE_URL=http://127.0.0.1:3100 pnpm -F web e2e <spec>`; specs on the demo company need `pnpm db:reset && DEMO_SEED=1 pnpm db:seed` first. Never run the full integration suites against the hosted project.
- Migrations forward-only; take the number the plan names, or the next free one if taken, and say so. Each migration has its integration test (rule 34).
- If the task would break a rule or deviate from the design, stop and report; the fix is an owner decision recorded in the main design §22, never a workaround. No PUC code outside `packages/localization/co` (rule 5). Never edit §22 or `docs/project-rules.md`.
- Before the commit: `pnpm lint`, `pnpm typecheck`, `pnpm check:rules`, the unit tests, `pnpm test:integration:changed`, the e2e specs the task touches, and `pnpm build`. The full suites run in GitHub Actions on the push; the task is complete only when that run is green.
- Commit only when the owner asks in the session; one conventional commit, ending `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`. Never push, tag or open a PR unless the owner says so.
- Spanish Latam copy only through `packages/i18n` with an `en` mirror (rule 24). A feature without its user guide is not finished (rule 35). Add a brain note in `docs/brain/` (frontmatter tags, date, status; wikilinks) per `CLAUDE.md`.
- Posting is inline and strict for this document (as today); money `$ 1.234.567,00`; every state change is a registered process; the assistant card lists the module effects (rules 1, 17).

**Review focus pinned to this task.** (a) stock part + cogs part = the amount to the cent, always; (b) the void reverses both exactly and `value = Σ events` holds for every layer; (c) no PUC code in module source; (d) nothing in a past period is rewritten; (e) a receipt with nothing sold posts byte for byte as before.

## The task

The plan section is the authority (rulings R45-1 to R45-10, files, failing tests first, gates, review focus). Read it in full and follow it verbatim.

## When you finish

Report, in this order: the tests you ran with their pass counts (paste the last lines of each run), the files created and modified, the migration number used, the commit hash if the owner asked for one, any point where you chose something the plan left open, and any point where you stopped because the plan or the design would have been broken. Do not claim the task is complete before the gates passed locally; say so plainly if a step was skipped or a suite is still red. New owner items go to the pending-decisions file from number 140.
