# Prompt · Phase 2A gaps · Task 9 of 10 · The restricted Cuenta frame gets the status footer, the deep link and a masked N.º

Paste this whole file as the first message of a new session in `/Volumes/SATECHI2TB/erp-ia`.

---

You are implementing **Task 9** of the Phase 2A gaps plan of ERP-IA: `docs/superpowers/plans/2026-10-30-phase-2a-gaps.md` (Part D · Owner additions (2026-10-30)). Do this task only; nothing from any other task.

**Read before starting.** Read `docs/project-rules.md` and the design sections for this task before starting; follow the plan task verbatim. The design sections are: accounting design §5.13, §8 (Cuenta record); main design §5.15 (UUID + consecutive), §5.16 (record frame), §22.9, §22.15; rules 14, 21. The accounting design is `docs/superpowers/specs/2026-10-28-accounting-module-design.md`; the main design is `docs/superpowers/specs/2026-10-26-erp-ia-design.md` (owner decisions §22, the accounting module is §22.17). Read `CLAUDE.md` too; its orders apply. Read the plan's "Gap verification" row for this task and its "Needs owner decision" entry when the task names one.

**Where this task sits.** Start only when Task 4 is merged (both edit `accounting-records.spec.ts` and `seguridad-por-cuenta.md`). It may run in parallel with Task 5. Interfaces this task consumes come from: Task 4; read their "Interfaces · Produces" blocks in the plan and use those names, never reinvented ones. This task's own "Interfaces · Produces" block is a contract for later tasks: keep every name and signature exactly as written.

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

1. **A restricted account leaks nothing through the new channels.** The "Sin acceso" note, the restricted Cuenta frame, the report file action and the Tabla figure must not tell a user without view whether an account id exists, what its code is or what it holds: a missing and a restricted account id answer the same refusal; the XML of a year with restricted accounts aggregates them like the report; a restricted node's figure in Tabla is masked (null, not sortable, not filterable, rule 14). Tests in Task 4 (`missing and restricted account answer the same Sin acceso`), Task 9 (`missing and restricted Cuenta frames are identical`), Task 5 (`exógena XML as a restricted user equals the report's rows`), Task 7 (`period figure of a restricted account is masked and refuses sort and filter`).

## The task, verbatim from the plan

### Task 9: The restricted Cuenta frame gets the status footer, the deep link and a masked N.º


**Files:**
- Modify: `packages/ui/src/record/RecordFrame.tsx:11-21, 91` (`seq?: number | null | "masked"`; `"masked"` renders `N.º •••• · UUID <short>…`, the same masking glyph as a masked field), `apps/web/src/app/(app)/r/[entity]/[id]/page.tsx:130-149` (`RestrictedAccount` passes `seq="masked"`, `deepLinkHref={recordHref("accounting.account", id)}`, `status={<span data-testid="record-status" className="erp-record__status"><span className="erp-pill erp-pill--gray">{t("common.acc_record.no_access")}</span></span>}`)
- Modify: `docs/user-guide/es-419/contabilidad/seguridad-por-cuenta.md` (what the frame of a restricted account shows: title "Cuenta restringida", N.º hidden, UUID, open in a new tab, "Sin acceso" in the footer and on Saldos and Movimientos)
- Test: `packages/ui/src/record/__tests__/RecordFrame.test.tsx`, `apps/web/e2e/accounting-records.spec.ts`

**Interfaces:**
- Consumes: `recordHref`, `RecordFrame` / `AppRecordFrame`, `NoAccess`; the key `common.acc_record.no_access` (moved to `accounting.record.no_access` by Task 8, which runs after).
- Produces: `RecordFrameProps.seq: number | null | "masked"`; no other caller changes.

- [ ] **Step 1: Write the failing tests**

```ts
it("seq 'masked' shows N.º •••• with the UUID, never 'N.º y uuid se asignan al crear'", () => { ... });
// accounting-records.spec.ts, as marcela:
test("missing and restricted Cuenta frames are identical: title Cuenta restringida, N.º ••••, the id's UUID, Abrir en una pestaña nueva opens the same URL, footer Sin acceso", async ({ page }) => { /* 510506's id and a random uuid v7: same text, same tabs, same footer */ });
```

- [ ] **Step 2: Run them to verify they fail, implement, run them to verify they pass**

Run: `pnpm -F @erp/ui test -t RecordFrame && E2E_BASE_URL=http://127.0.0.1:3100 pnpm -F web e2e accounting-records`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/ui/src/record "apps/web/src/app/(app)/r/[entity]/[id]/page.tsx" apps/web/e2e/accounting-records.spec.ts docs/user-guide/es-419/contabilidad/seguridad-por-cuenta.md
git commit -m "fix(accounting): restricted Cuenta frame with status footer, deep link and a masked number"
```

## When you finish

Report, in this order: the tests you ran with their pass counts (paste the last lines of each run), the files created and modified, the commit hash, and any point where you had to choose something the plan left open, or where you stopped because the plan or the design would have been broken. Do not claim the task is complete before the pre-commit gate passed locally; say so plainly if a step was skipped or a suite is still red.
