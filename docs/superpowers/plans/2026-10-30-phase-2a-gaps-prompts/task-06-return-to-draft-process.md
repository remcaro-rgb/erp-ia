# Prompt · Phase 2A gaps · Task 6 of 10 · Devolver a borrador as its own process — OD-1 decided 2026-10-30 (option A)

Paste this whole file as the first message of a new session in `/Volumes/SATECHI2TB/erp-ia`.

---

You are implementing **Task 6** of the Phase 2A gaps plan of ERP-IA: `docs/superpowers/plans/2026-10-30-phase-2a-gaps.md` (Part C · Planned on the owner's decisions). Do this task only; nothing from any other task.

**Read before starting.** Read `docs/project-rules.md` and the design sections for this task before starting; follow the plan task verbatim. The design sections are: accounting design §5.12.1 (four-eyes), §6 (`entry.update`, `entry.submit`, `entry.post`), §8 (Comprobante buttons), §9; main design §6 (permissions, audit). The accounting design is `docs/superpowers/specs/2026-10-28-accounting-module-design.md`; the main design is `docs/superpowers/specs/2026-10-26-erp-ia-design.md` (owner decisions §22, the accounting module is §22.17). Read `CLAUDE.md` too; its orders apply. Read the plan's "Gap verification" row for this task and its "Needs owner decision" entry when the task names one.

**Where this task sits.** Task 1 is merged (OD-1 decided 2026-10-30: option A, main design §22.20). It may run in parallel with Task 4. Interfaces this task consumes come from: phase 2A code only; read their "Interfaces · Produces" blocks in the plan and use those names, never reinvented ones. This task's own "Interfaces · Produces" block is a contract for later tasks: keep every name and signature exactly as written.

**How to work.**
- Test first (rule 31): write the failing tests of Step 1 exactly as named, run them and show they fail, implement, run them and show they pass, then run the suites the task's steps name. Use `superpowers:test-driven-development`.
- Work on the branch the owner's session names; do not create another one unless asked. When this task runs in parallel with another, it runs in its own worktree.
- Environment: the local Supabase stack (Docker via OrbStack); check Docker is up before `supabase db reset` or `pnpm db:reset`. The app's dev server is `:3100` through `.claude/launch.json`; stop or start only that one (`lsof -ti:3100` or the preview tools), never `pkill next-server` (another project runs on `:3000`). Run touched e2e specs against it with `E2E_BASE_URL=http://127.0.0.1:3100 pnpm -F web e2e <spec>`; specs on the demo company need `pnpm db:reset && DEMO_SEED=1 pnpm db:seed` first. Never run the full integration suites against the hosted project.
- If the task would break a rule or deviate from the design, stop and report; the fix is an owner decision recorded in the main design §22, never a workaround. A task blocked by an owner decision that is not recorded yet does not start.
- Before the commit: `pnpm lint`, `pnpm typecheck`, `pnpm check:rules`, the unit tests, `pnpm test:integration:changed`, the e2e specs the task touches against `:3100`, and `pnpm build`. The full suites run in GitHub Actions on the push; the task is complete only when that run is green.
- The owner starting this session with this prompt authorises the commit the task's last step names, with the message given there and the trailer `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`. Never push, tag or open a PR unless the owner says so in the session.
- Spanish Latam copy only through `packages/i18n` with an `en` mirror; the journal master is **Fuente / Fuentes**; money renders `$ 1.234.567,00`. No PUC code in `packages/kernel` or `packages/modules/accounting` source. A feature without its user guide is not finished (rule 35): the task's guide edits are part of it.

## Global constraints (from the plan; every task inherits them)

- Every state change is a registered process run through `runProcess` (rule 1); the UI, the assistant and the API call the same processes.
- Account security lives in SQL (`accounting.can_view_account`, the masked views); no fix filters restricted data in TypeScript after reading it (rule 14, §5.13).
- Restricted accounts: statements keep the admin's totals on **every** money column with one line "Cuentas restringidas (n)"; line reports omit lines and count them; an Auxiliar asked for a restricted account answers "Sin acceso" and says nothing more about the account (§5.13).
- Files: generated files are downloaded through a signed link of the kernel `exportsStore()` (`FileStore.signedUrl`, TTL `EXPORT_URL_TTL_SECONDS = 600`), never streamed from a public path (rule 22).
- Fiscal logic only in `packages/localization/co` (rule 5): the XML is written by `pack.exogenaXml`; no PUC code in `packages/kernel` or `packages/modules/accounting` source (`check:rules` `puc-code-outside-pack`).
- Models only through `kernel.model_policies` and the AI SDK; no model id in code; every LLM call metered through `recordUsage` (rules 26, 27).
- Copy in Spanish (es-419) through `packages/i18n` with an `en` mirror of every key (rule 24); money `$ 1.234.567,00` (rule 23); the journal master is **Fuente**.
- Tests first (rule 31); migrations forward-only, next number `0036_<module>_<topic>.sql`, each covered by an integration test (rule 34); a feature without its guide in `docs/user-guide/es-419/contabilidad/` is not finished (rule 35).
- Pre-commit gate of every task: `pnpm lint`, `pnpm typecheck`, `pnpm check:rules`, the unit tests, `pnpm test:integration:changed`, the e2e specs the task touches against the dev server on `:3100` (`E2E_BASE_URL=http://127.0.0.1:3100 pnpm -F web e2e <spec>`), `pnpm build`. The full suites run in GitHub Actions on the push.
- Commits: conventional, one per task, ending `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`; no commit, push, tag or PR without the owner asking (rule 33).
- Environment: local Supabase via OrbStack; dev server only on `:3100` (never `pkill next-server`, another project runs on `:3000`); never run full integration suites against the hosted project.

## Review focus pinned to this task

3. **Step-up binding and refusals on the new actions.** The XML action under a raised sensitivity asks for the code once and binds it to the caller; a refused XML (errors, no rows, no NIT) shows the reasons and writes no file; Devolver a borrador from the assistant needs a confirmation card. Tests in Task 5 (`raised exogena_xml asks for step-up`, `refused XML stores nothing`), Task 6 (`return_to_draft is a write the assistant confirms`).
5. **Transaction integrity of the status change.** Returning a pending entry to draft keeps the line ids, writes one audit row on the entry and none on the lines, and two concurrent returns leave one change. Test in Task 6 (`returns in place: same line ids, one audit row`).

## The task, verbatim from the plan

### Task 6: Devolver a borrador as its own process — OD-1 decided 2026-10-30 (option A)


**Files:**
- Create: `packages/modules/accounting/src/processes/entry-return.ts` (`accounting.entry.return_to_draft`)
- Modify: `packages/modules/accounting/src/processes/index.ts` (register), `packages/modules/accounting/src/index.ts` (manifest permissions: default grant to the roles that hold `accounting.entry.post`), `packages/modules/accounting/src/processes/entry.ts:136-143` (description of `entry.update` no longer mentions pending; `update` of a `pending` entry is refused with "Devuelve el comprobante a borrador antes de modificarlo")
- Delete: `apps/web/src/lib/accounting/entry-return.ts` and `entry-return.test.ts`
- Modify: `apps/web/src/lib/accounting/entry-actions.ts:80-86` (`return` runs `accounting.entry.return_to_draft` with `{ id, reason }`), `apps/web/src/lib/accounting/entry-load.ts` (the button shows when the caller may run `return_to_draft`), `packages/ui/src/accounting/entry-model.ts` (`allowedActions`: `return` needs `canReturn`), `packages/ui/src/accounting/EntryForm.tsx` (the Devolver dialog asks for an optional reason)
- Modify: `packages/i18n/messages/es-419.json` / `en.json`: `process.accounting.entry.return_to_draft` "Devolver comprobante a borrador" / "Return entry to draft", `common.entry.return_reason` "Motivo (opcional)" / "Reason (optional)"; remove `common.entry.return_blocked`
- Modify: `docs/user-guide/es-419/contabilidad/comprobantes.md:58`, `controles-y-cierre.md:19` (who may return, the reason, that a comprobante with restricted lines can be returned)
- Modify: `packages/agent/src/__tests__/evals/accounting.json` (case "devuelve a borrador el comprobante NC-2026-0042" → `accounting.entry.return_to_draft`, confirmation)
- Test: `packages/modules/accounting/src/__tests__/entry-post.integration.test.ts`, `apps/web/e2e/accounting-entry.spec.ts`, `packages/ui/src/accounting/__tests__/entry-model.test.ts`

**Interfaces:**
- Produces: `accounting.entry.return_to_draft` kind `update`, sensitivity `normal` (admin may raise), feature `accounting.ledger`, input `{ id: uuid, reason?: string (1..500) }`, output `{ id }`; refuses `not_found`, and `invalid_input` "Solo un comprobante pendiente de aprobación vuelve a borrador" for any status but `pending`; sets `status = 'draft'`, `submitted_by = null`, `submitted_at = null`, `extra.return_reason` when given; lines untouched; emits no event (§6 lists none; OD-1 asks).

- [ ] **Step 1: Write the failing tests**

```ts
it("return_to_draft returns in place: same line ids, one audit row on the entry, none on the lines, reason kept", async () => { ... });
it("return_to_draft works on an entry with a restricted line for an approver without view on it", async () => { ... });
it("return_to_draft refuses a draft, a posted and a voided entry; entry.update refuses a pending entry", async () => { ... });
it("return_to_draft is a write the assistant confirms (tool present, confirmation card, no run before accept)", async () => { ... });
// accounting-entry.spec.ts: four-eyes flow → "Devolver a borrador" with a reason → status Borrador, the creator edits and resubmits
```

- [ ] **Step 2: Run them to verify they fail, implement, run them to verify they pass**

Run: `pnpm -F @erp/module-accounting test:integration -t "return_to_draft" && pnpm -F @erp/ui test -t entry-model && pnpm -F @erp/agent test -t evals && E2E_BASE_URL=http://127.0.0.1:3100 pnpm -F web e2e accounting-entry`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/modules/accounting packages/ui/src/accounting apps/web/src/lib/accounting packages/i18n/messages packages/agent/src/__tests__/evals docs/user-guide/es-419/contabilidad apps/web/e2e/accounting-entry.spec.ts
git commit -m "feat(accounting): Devolver a borrador as its own process, in place, with a reason"
```

## When you finish

Report, in this order: the tests you ran with their pass counts (paste the last lines of each run), the files created and modified, the commit hash, and any point where you had to choose something the plan left open, or where you stopped because the plan or the design would have been broken. Do not claim the task is complete before the pre-commit gate passed locally; say so plainly if a step was skipped or a suite is still red.
