# Phase 2A gaps · one prompt per task

Generated 2026-10-30 from `docs/superpowers/plans/2026-10-30-phase-2a-gaps.md` (Tasks 9 and 10 and the FE-1234 eval fix added on the owner's review the same day). Each file is a complete first message for a new session that implements exactly one task. The owner has not yet ordered execution. The owner decisions OD-1–OD-4 were taken on 2026-10-30 (the plan's recommendations, main design §22.20).

The plan is the authority; each prompt copies its task's text verbatim, so an edit to the plan must be mirrored in the prompt (or the prompts regenerated). The prompt adds what a fresh session needs around the task: the mandatory reading line, when it may start, how to work in this repository, the global constraints, the review-focus lines pinned to the task and the report format.

| # | Part | File | Task | Starts when |
|---|---|---|---|---|
| 1 | Part A | [`task-01-restricted-row-keeps-each-side.md`](task-01-restricted-row-keeps-each-side.md) | Trial balance and libro mayor keep each side of the restricted row | At once: it runs in wave 1, in parallel with Tasks 2 and 3. |
| 2 | Part A | [`task-02-year-close-e2e.md`](task-02-year-close-e2e.md) | "Cerrar año" end to end on its own company | At once: it runs in wave 1, in parallel with Tasks 1 and 3. |
| 3 | Part A | [`task-03-model-backed-evals.md`](task-03-model-backed-evals.md) | Model-backed assistant evals (opt-in job, mock fallback) — OD-4 decided 2026-10-30 | It may start at once (OD-4 decided 2026-10-30, main design §22.20): it runs in wave 1, in parallel with Tasks 1 and 2. |
| 4 | Part B | [`task-04-report-refusal-notes-sin-acceso.md`](task-04-report-refusal-notes-sin-acceso.md) | Report and grid refusals show their note; a missing and a restricted account answer the same | Task 1 is merged (both edit `accounting-smoke.spec.ts` and `seguridad-por-cuenta.md`). It may run in parallel with Task 6. |
| 5 | Part B | [`task-05-exogena-xml-button.md`](task-05-exogena-xml-button.md) | "Exportar XML" on the Información exógena page | Tasks 4 and 6 are merged (shared `report-model.ts` / `failureOf` and the i18n catalogues). It may run in parallel with Task 9. |
| 6 | Part C | [`task-06-return-to-draft-process.md`](task-06-return-to-draft-process.md) | Devolver a borrador as its own process — OD-1 decided 2026-10-30 (option A) | Task 1 is merged (OD-1 decided 2026-10-30: option A, main design §22.20). It may run in parallel with Task 4. |
| 7 | Part C | [`task-07-tabla-period-figure.md`](task-07-tabla-period-figure.md) | The period figure in the masters' Tabla — OD-2 decided 2026-10-30 (option A) | Tasks 4, 5 and 6 are merged (OD-2 decided, option A; shared `DataGrid.tsx` and the i18n catalogues). |
| 8 | Part C | [`task-08-accounting-i18n-namespace.md`](task-08-accounting-i18n-namespace.md) | Accounting copy under a module namespace — OD-3 decided 2026-10-30 (option A) | Tasks 1–7 and 9 are merged (OD-3 decided 2026-10-30: option A, main design §22.20). It may run in parallel with Task 10 only. |
| 9 | Part D | [`task-09-restricted-cuenta-frame.md`](task-09-restricted-cuenta-frame.md) | The restricted Cuenta frame gets the status footer, the deep link and a masked N.º | Task 4 is merged (both edit `accounting-records.spec.ts` and `seguridad-por-cuenta.md`). It may run in parallel with Task 5. |
| 10 | Part D | [`task-10-guide-screenshots.md`](task-10-guide-screenshots.md) | Screenshots in the accounting guides | Tasks 1–7 and 9 are merged, so the screenshots show the final screens. It may run in parallel with Task 8 only. |

Waves: **1** Tasks 1, 2, 3 in parallel (separate worktrees, no shared files) · **2** Task 4 after 1 and Task 6, in parallel · **3** Task 5 after 4 and 6, Task 9 after 4, in parallel · **4** Task 7 after 4, 5 and 6 · **5** Task 8 after Tasks 1–7, 9, in parallel with Task 10 after Tasks 1–7, 9.
