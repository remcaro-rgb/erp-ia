# Prompt · Phase 2A gaps · Task 5 of 10 · "Exportar XML" on the Información exógena page

Paste this whole file as the first message of a new session in `/Volumes/SATECHI2TB/erp-ia`.

---

You are implementing **Task 5** of the Phase 2A gaps plan of ERP-IA: `docs/superpowers/plans/2026-10-30-phase-2a-gaps.md` (Part B · Report refusals and the exógena file). Do this task only; nothing from any other task.

**Read before starting.** Read `docs/project-rules.md` and the design sections for this task before starting; follow the plan task verbatim. The design sections are: accounting design §4.13, §5.11, §6 (`report.exogena`), §7 workflow 6 (Exógena del año), §10a.5; main design §5.13 (signed downloads), §9. The accounting design is `docs/superpowers/specs/2026-10-28-accounting-module-design.md`; the main design is `docs/superpowers/specs/2026-10-26-erp-ia-design.md` (owner decisions §22, the accounting module is §22.17). Read `CLAUDE.md` too; its orders apply. Read the plan's "Gap verification" row for this task and its "Needs owner decision" entry when the task names one.

**Where this task sits.** Start only when Tasks 4 and 6 are merged (shared `report-model.ts` / `failureOf` and the i18n catalogues). It may run in parallel with Task 9. Interfaces this task consumes come from: Task 4; read their "Interfaces · Produces" blocks in the plan and use those names, never reinvented ones. This task's own "Interfaces · Produces" block is a contract for later tasks: keep every name and signature exactly as written.

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
3. **Step-up binding and refusals on the new actions.** The XML action under a raised sensitivity asks for the code once and binds it to the caller; a refused XML (errors, no rows, no NIT) shows the reasons and writes no file; Devolver a borrador from the assistant needs a confirmation card. Tests in Task 5 (`raised exogena_xml asks for step-up`, `refused XML stores nothing`), Task 6 (`return_to_draft is a write the assistant confirms`).

## The task, verbatim from the plan

### Task 5: "Exportar XML" on the Información exógena page


**Files:**
- Modify: `packages/kernel/src/reports/types.ts` (`ReportFileAction`, `ReportDef.fileActions?`), `packages/kernel/src/reports/define.ts` (validate: unique `id`, `process` registered, kind `consult`, same `feature`), `packages/kernel/src/reports/run.ts` (`runReportFile`)
- Create: `apps/web/src/app/api/report/[id]/file/[action]/route.ts`, `apps/web/src/app/api/report/__tests__/report-file.integration.test.ts`
- Modify: `packages/modules/accounting/src/reports/exogena.ts` (`fileActions: [{ id: "xml", label: "report.file.exogena_xml", process: "accounting.report.exogena_xml", contentType: "application/xml", contentField: "xml" }]`), `packages/ui/src/report/report-model.ts` (`ReportDefClient.fileActions: { id: string; label: string }[]`), `packages/ui/src/report/ReportPage.tsx` (one button per file action next to the export buttons; prop `onFileAction?: (actionId: string, params: ReportParams) => Promise<void>`), `apps/web/src/lib/reports/load.ts` (translated labels), `apps/web/src/app/(app)/_components/report-screen.tsx` (the handler: POST, step-up on 401 through `requestStepUp`, the refusal's details listed in an alert, the signed link opened on success)
- Modify: `packages/i18n/messages/es-419.json` / `en.json`: `report.file.exogena_xml` "Exportar XML" / "Export XML", `report.file.running` "Generando el archivo…" / "Generating the file…", `report.file.refused` "No se generó el archivo:" / "The file was not generated:"
- Modify: `docs/user-guide/es-419/contabilidad/exogena.md` (Exportar XML: when it is enabled, what the refusal list means, the file name `Dmuisca_<formato><versión><año>.xml`, the link lasts 10 minutes)
- Test: `packages/kernel/src/reports/__tests__/define.test.ts`, `packages/ui/src/report/__tests__/ReportPage.test.tsx`, `packages/modules/accounting/src/__tests__/exogena.integration.test.ts`, `apps/web/e2e/accounting-reports.spec.ts`

**Interfaces:**
- Consumes: `GridFetchError.details` / `failureOf` (Task 4); `exportsStore()` and `EXPORT_URL_TTL_SECONDS` (`packages/kernel/src/files/store.ts`, `exports/jobs.ts`); `reportOf`, `reportDenial` (`packages/kernel/src/reports`); `processFailure` (`apps/web/src/lib/server/process-response.ts`).
- Produces: `interface ReportFileAction { id: string; label: string; process: string; contentType: string; contentField: string }`; `runReportFile(deps, caller, reportId, actionId, params): Promise<{ fileName: string; content: string; contentType: string }>` (runs the action's process with `params` as its input through `runProcess`, so permission, sensitivity and step-up apply); `POST /api/report/:id/file/:action` body `{ params }` → `200 { url, fileName }` after `exportsStore().put(\`${companyId}/report-files/${uuidv7()}/${fileName}\`, Buffer.from(content), contentType)` and `signedUrl(path, EXPORT_URL_TTL_SECONDS, fileName)`; refusals through `processFailure` (400 with the error list, 401 `step_up_required`, 403, 404). No file is stored when the process refuses.

Call made: the XML is generated synchronously (one format and year, a few thousand rows at most) instead of through an export job; the job table stays the grid exports' (`pdf | xlsx | csv`). The process stays `normal` (§6 lists no sensitivity for exógena); an admin may raise it (rule 15) and the route honours it.

- [ ] **Step 1: Write the failing tests**

```ts
it("defineReport refuses a file action whose process is missing, not a consult or of another feature", () => { ... });
it("ReportPage shows one button per file action and calls onFileAction with the current parameters", async () => { ... });
it("POST /api/report/accounting.exogena/file/xml stores the XML in the exports store and answers a signed link named Dmuisca_…xml", async () => { /* MemoryFileStore via setExportsStore; the stored bytes equal exogena_xml's xml */ });
it("a refused XML (unmapped account) answers 400 with the error list and stores nothing", async () => { ... });
it("raised exogena_xml asks for step-up: 401 step_up_required without a fresh code, 200 with one bound to the caller", async () => { ... });
it("exógena XML as a restricted user equals the report's rows (restricted accounts aggregated as the report does)", async () => { ... });
// accounting-reports.spec.ts
test("Información exógena 1001 de 2026 → Exportar XML downloads `Dmuisca_001001<versión>2026.xml`; with an unmapped account the page lists the errors", async ({ page }) => { ... });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm -F @erp/kernel test -t "file action" && pnpm -F @erp/ui test -t "file action" && pnpm -F web test:integration -t report-file && pnpm -F @erp/module-accounting test:integration -t exogena`
Expected: FAIL.

- [ ] **Step 3: Implement** the kernel type, validation and `runReportFile`; the route; the UI button and handler; the exógena declaration; the catalogue keys; the guide.

- [ ] **Step 4: Run the tests and the touched e2e to verify they pass**

Run: the Step 2 commands, then `E2E_BASE_URL=http://127.0.0.1:3100 pnpm -F web e2e accounting-reports`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/kernel/src/reports apps/web/src/app/api/report packages/modules/accounting/src/reports/exogena.ts packages/modules/accounting/src/__tests__/exogena.integration.test.ts packages/ui/src/report apps/web/src/lib/reports/load.ts "apps/web/src/app/(app)/_components/report-screen.tsx" packages/i18n/messages apps/web/e2e/accounting-reports.spec.ts docs/user-guide/es-419/contabilidad/exogena.md
git commit -m "feat(accounting): Exportar XML on the exógena report through a report file action and a signed download"
```

## When you finish

Report, in this order: the tests you ran with their pass counts (paste the last lines of each run), the files created and modified, the commit hash, and any point where you had to choose something the plan left open, or where you stopped because the plan or the design would have been broken. Do not claim the task is complete before the pre-commit gate passed locally; say so plainly if a step was skipped or a suite is still red.
