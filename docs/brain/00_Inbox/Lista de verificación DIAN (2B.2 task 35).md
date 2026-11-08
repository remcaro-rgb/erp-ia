---
tags: [invoicing, dian, checklist, localization, security, task-35, decision, web]
date: 2026-11-07
status: in-progress
---

# Lista de verificación DIAN (2B.2 task 35)

Part of [[Plan phase-2b-sales-stock-chain]]; owner item 20 of [[Plan phase-2b-owner-decisions-pending]] (decided 2026-11-06, with changes) and §22.28 in [[Owner Decisions]]. Module: [[Module invoicing]]; the list is fiscal content of the [[Country pack co]] (rule 5). Builds on the production guard of Task 19 ([[Parámetros de facturación electrónica]]). Rules read: [[Project Rules]] (1, 3, 5, 7, 12-17, 24, 31, 35).

## What it is
- 23 rows in 8 groups (`packages/localization/co/src/einvoice/dian-checklist.ts`): every value the documents carry that was written against the DIAN annexes and the mock transport and never verified in habilitación. One row per verifiable claim (R35-1); es and en text are pack data (R35-3); `docUrl` is optional and empty everywhere, since item 20 names no link and inventing one would be a fabricated reference (R35-4).
- The kernel carries the types (`DianChecklist`, `DianChecklistItem`) and `EInvoicePack.dianChecklist`; the module reads the list only through `packOf(ctx).einvoice` (R35-2).
- `version` is the highest `since`. **Adding a row means `since = version + 1` and raising `version`**, which ends every confirmation at once.

## Processes (all admin only, feature `invoicing.settings`)
- `invoicing.dian_checklist.tick` (step-up): ticks and unticks; one run, one code, one transaction; each changed row writes its own row-audit entry (who, when, before, after); a repeat writes nothing; unticking while the flag stands clears the flag and the version in the same run (`confirmationCleared`); in producción an untick is refused `dian_in_production`.
- `invoicing.dian_defaults.confirm` (step-up): `true` needs all rows of the current list ticked (`dian_checklist_incomplete` lists the missing texts) and stamps the list version; `false` clears both (refused in producción).
- `invoicing.dian_checklist.consult`: the list with who and when (display names from `kernel.v_users`), progress, `isNew`, the effective flag, and when and by whom it was confirmed (last confirm run in the audit view).
- `invoicing.settings.update` **lost** `dianDefaultsConfirmed` (strict input): the assistant cannot set the flag. Both mutating processes are in `EXCLUDED_PROCESSES` and the exposure denylist test (rule 17).

## Data (migration 0135)
- `invoicing.dian_checks`: one row per item ever ticked, `unique (company_id, item_key)`, `ticked = (ticked_by and ticked_at present)`, row audit, no deletes (trigger), restrictive `via_process` policies on `invoicing.dian_checklist.%`. The key is validated by the process, not the database (the list lives in the pack).
- `invoicing.settings.dian_checklist_version` with the check `dian_defaults_confirmed = (version is not null)`; the guard trigger `guard_dian_defaults` refuses a user session that changes either outside the two processes (the service passes). The migration lowers confirmed habilitación rows and stamps confirmed producción rows with version 1.
- `invoicing.v_settings` is recreated in the **same file** (a migration that drops a view recreates it: the Task 43 lesson) and `invoicing.v_dian_checks` is created, both from `maskedViewSql`; `entities.test.ts` keeps them in sync.

## The effective confirmation (R35-7, R35-8, R35-9)
- Effective = stored flag AND stored version = the pack's version AND every item of the current list ticked. `assertProductionReady`, `settings.consult` and the screen read it, so a version bump ends the confirmation with no migration and no write (nothing audited at deploy: owner item 86).
- A company **already in producción** whose list grows keeps operating: 0101 forbids lowering the flag there, the screen shows «Hay N valores nuevos por verificar», and the guard on later saves accepts the stored flag when the company is already in producción (it does not block changing the credit days). Reaching producción needs the effective one (owner item 85).
- The guard keeps its order and codes; its first refusal now names the pending count and points to the checklist (`dian_defaults_unconfirmed`).

## Screen
- `/invoicing/settings/checklist` (admin only; no menu item): progress bar (`role="progressbar"`), a block per group with «Seleccionar el grupo», one checkbox per row, «Verificado por … el …», «Marcar los seleccionados» (or «Guardar cambios» when unticking) sends ONE tick run behind the usual step-up dialog (`useAction`, now shared in `settings/use-action.tsx`), «Confirmar valores por defecto» (enabled with all ticked and nothing unsaved), «Valores confirmados el … por …». Conexión DIAN lost the checkbox and links here. The pure `lib/invoicing/checklist-view.ts` shapes the consult (unit-tested).

## Traps
- The system admin role sees every field, so the consult's masking path (a hidden `ticked_by`) is reachable only through `v_dian_checks` by other roles; that is where it is tested.
- A user's UPDATE of `invoicing.settings` outside any process changes no row (the table's `via_process` policy); the guard trigger matters inside another invoicing process, such as the settings update or an assistant tool.
- The e2e runs the mock, which never serves producción (Tasks 5/17): the spec asserts the transport's refusal, not a switch (owner item 84).
- Tests set the flag through `tickAllAndConfirm(h)` or, by service SQL, both columns (`dian_checklist_version` is required by the check).
- Guide: [[User Guide]] `facturacion-electronica.md`, section «Lista de verificación DIAN» (what to verify for each of the 23 rows).
