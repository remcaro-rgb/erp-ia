---
tags: [kernel, web, nested-runs, step-up, task-32, decision]
date: 2026-11-07
status: in-progress
---

# Nested runs configurable (Task 32, stage B: screens)

Part of [[Plan phase-2b-sales-stock-chain]]; the owner decision (item 1 of [[Plan phase-2b-owner-decisions-pending]], §22.28 in [[Owner Decisions]]); the kernel side (migration `0126`, `ctx.runProcess` policy, savepoint, queue) is stage A; related: [[Document links kernel API]]. Copy and guide: [[User Guide]] (`ejecuciones-anidadas.md`).

- **Admin screen** `/admin/nested-runs` («Ejecuciones anidadas», second entry of `ADMIN_SECTIONS`, nav id `kernel.admin_nested_runs`, off the bar): depth 1..8, add-a-pair from the registry list (a `nestedOnlyFrom` process offers only its declared parents), «La TOTP del padre cubre», «En caso de fallo» (Revertir todo | Continuar y encolar). The badge «Contabiliza o mueve existencias» comes from `ledgerOrStockReason` in the loader (`ledgerOrStock` per process) and disables «Continuar y encolar» in the form and in each row. Loader `loadNestedRuns` (`apps/web/src/lib/admin/load.ts`) reads as the caller through `asAdmin` (null for anyone but the company admin).
- **Queue screen** `/nested-failures` («Fallos de ejecuciones anidadas»), outside `/admin`, on the module bar guarded by `kernel.nested_failure.retry`. `loadNestedFailures` (`apps/web/src/lib/nested/load.ts`) reads only `kernel.v_nested_run_failures` (never the `input` column) and answers null unless admin or `can_run_process(retry)`; the page then renders `ForbiddenInShell`. Dismiss shows only to who may run `kernel.nested_failure.dismiss`.
- **Actions** `apps/web/src/lib/nested/actions.ts`: `nestedAction(kind, input, stepUpToken)` with a fixed map pair/depth/retry/dismiss to process ids (the admin regex of `adminAction` does not match the five-segment ids, and the client must never name a process). The screens reuse `useAdminAction` (step-up dock, refresh) from the admin folder.
- **Copy:** `common.admin.nested_runs.*` and `common.nested_failures.*` (snake_case: `catalogue.test.ts` rejects the plan's `nestedRuns`), `nav.kernel.nested_runs|nested_failures`. Module processes have no `process.*` label in the catalogue, so the screens name a process by the first clause of its registry description (`lib/nested/names.ts`) with the id under it.
- **Tests:** `apps/web/src/lib/nested/__tests__/nested.integration.test.ts` (loaders null for non-admin, no input in any payload, derived ledger flag on real processes, action refusals), `nav.test.ts` (queue item for a role granted the retry), e2e `apps/web/e2e/nested-runs.spec.ts` (pair `crm.lead.convert` → `core.party.create`; ledger refusal on `invoicing.note.issue_annulment` nested in `invoicing.invoice.void`).
- **Pitfall:** `seedAuthUser` cleanup must delete the three nested tables (they reference the company) and `core.entity_sequences` (the `seq` counter), else `delete from kernel.companies` fails.
