# Prompt · Plan the fixes for the Phase 2A known gaps

Paste this whole file as the first message of a new session in `/Volumes/SATECHI2TB/erp-ia`.

---

You are **planning** (not implementing) the fixes for the known gaps left by Phase 2A of ERP-IA. Output one written plan; write no product code, no migrations, no commits.

**Read before starting.** Read `CLAUDE.md`, `docs/project-rules.md` (all 37 rules) and the design sections for each gap before starting. Design: `docs/superpowers/specs/2026-10-26-erp-ia-design.md` (§9 grids, §19a UI, §22 owner decisions) and `docs/superpowers/specs/2026-10-28-accounting-module-design.md` (§4.16, §5.13, §5.14, §8, §9). Phase 2A plan: `docs/superpowers/plans/2026-10-29-phase-2-accounting.md` (see the execution notes appended at the end). Roadmap: `docs/roadmap.md`. Use `superpowers:writing-plans`. Tasks 1–32 of 2A are on `main` (tag `phase-2a-accounting`, last commit `99113c6`); inspect the code as it is, do not trust this brief's file guesses.

**Deliverable.** A plan file `docs/superpowers/plans/2026-10-30-phase-2a-gaps.md` in the same format as the phase plans (tasks with exact files, interfaces, values, failing tests first, commit message, Review Focus, user-guide updates per rule 35), plus one session prompt per task in `docs/superpowers/plans/2026-10-30-phase-2a-gaps-prompts/` following the shape of `2026-10-29-phase-2-accounting-prompts/` (with the "Read `docs/project-rules.md` and the design sections for X" line). Order tasks by dependency, group by size, mark which can run in parallel (no shared files). Do not pull work from phase 2B/2C or later.

**Rule for deviations.** If a fix would break a rule or change the design, do not plan a workaround: list it under "Needs owner decision" with options and a recommendation (the decision is recorded in the main design §22 by the owner).

## The gaps to plan (verify each in the code first; say if one is already fixed or mis-described)

1. **Exógena XML has no button.** The export exists only as consult process `accounting.report.exogena_xml` (`packages/modules/accounting/src/processes/exogena-xml.ts`, pack writer in `packages/localization/co`). Plan a download action on the Exógena report page (Informes), through the process, permission/step-up as in the design, signed download via `FileStore`, with a test and a guide update.
2. **Restricted account opened by link shows a generic message.** The API answers `ProcessError("forbidden", …, { details: ["Sin acceso"] })` for line reports of a restricted account, but the page shows "No tienes permiso para hacer esto." Plan surfacing the "Sin acceso" note in the report/record UI without leaking anything about the account (rule 14, review focus 3). Include the Cuenta record "Sin acceso" frame consistency.
3. **Trial balance closing columns differ between a restricted and an unrestricted user.** In the demo, Marcela's Balance de prueba closing columns differ from Laura's by 17.5M (the restricted row nets closing balances into one line "Cuentas restringidas (n)"); opening and movement totals match, each view is internally consistent. Determine against design §5.13 / review focus 3 ("totals equal to the admin's") whether the closing column should also match, and plan the fix or the documentation/test change. If the design is ambiguous, put it under "Needs owner decision".
4. **"Cerrar año" has no e2e.** Plan a Playwright spec on the demo company (year close and reopen, step-up, closing entries, `yearPreview` in `masters/figures.ts`), using the seed in `scripts/demo/accounting.ts` and without making the existing 58-spec suite order-dependent or non-idempotent.
5. **Tabla view of masters lacks the period-movement column.** `DataGrid` has no extra-column hook, so the figure shows only in Árbol (`apps/web/src/lib/accounting/masters.ts`, `packages/ui/src/tree`). Plan the grid extension (computed/extra columns from a published view, still sortable/filterable/exportable per rule 20 and masked per rule 14) or a view-based alternative; call out kernel impact.
6. **"Devolver a borrador" runs `accounting.entry.update`** with the entry's own data (`apps/web/src/lib/accounting/entry-return.ts`), and is refused when a line is restricted. Plan whether a dedicated process (`accounting.entry.return_to_draft`) is needed (rule 1: every state change is a registered process; audit clarity; sensitivity/step-up), its permissions, events, tests, UI and guide.
7. **Evals are structural.** `packages/agent/src/__tests__/evals/accounting.json` + `evals.test.ts` call no model (rule 30). Plan a model-backed eval run that fits CI cost/secrets policy (opt-in job or nightly, mock fallback), reading model ids only from `kernel.model_policies` (rule 26), with a pass threshold and reporting.
8. **No top-level `accounting.*` i18n namespace.** Accounting keys live under `common.entry.*`, `common.acc_record.*`, `common.acc_pages.*`, `grid.values.*`, `report.*`, `field.accounting.*` because `catalogue.test.ts` pins top-level namespaces. Decide (with the design and `packages/i18n` conventions) whether to introduce `accounting.*`, and if so plan the key migration with es-419/en parity and zero orphan keys; otherwise plan documenting the convention. Put the choice under "Needs owner decision" if it changes a pinned convention.

Also list, without planning, anything else you notice in the Phase 2A execution notes that looks like an unlisted gap.

## Plan content requirements

- For every task: failing tests named first (Vitest / integration / Playwright), exact files, interfaces and names, commit message ending `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`, the pre-commit gate (lint, typecheck, check:rules, unit, `test:integration:changed`, touched e2e on :3100, build), and the guide to update.
- A Review Focus section tied to rules 12–17 and 36 where relevant.
- Environment reminders in each prompt: local Supabase via OrbStack; dev server only on `:3100` (never `pkill next-server`); never run full integration suites against the hosted project; no push, tag or PR unless the owner says so.
- End with a self-review: every gap above mapped to a task or to "Needs owner decision", and a short estimate of effort per task.

When done, report: the plan path, the prompts folder, the task order with parallel groups, and the "Needs owner decision" list. Do not start executing the plan.
