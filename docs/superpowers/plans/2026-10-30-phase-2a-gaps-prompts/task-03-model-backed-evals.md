# Prompt · Phase 2A gaps · Task 3 of 10 · Model-backed assistant evals (opt-in job, mock fallback) — OD-4 decided 2026-10-30

Paste this whole file as the first message of a new session in `/Volumes/SATECHI2TB/erp-ia`.

---

You are implementing **Task 3** of the Phase 2A gaps plan of ERP-IA: `docs/superpowers/plans/2026-10-30-phase-2a-gaps.md` (Part A · Independent fixes). Do this task only; nothing from any other task.

**Read before starting.** Read `docs/project-rules.md` and the design sections for this task before starting; follow the plan task verbatim. The design sections are: main design §7.1 (evaluation set), §7.4 (model policies), §22.3 (AI pricing); accounting design §4.16 (`source_ref`), §7 workflow 9 (¿Qué pasó con la factura?), §9 (assistant); rules 26, 27, 29, 30. The accounting design is `docs/superpowers/specs/2026-10-28-accounting-module-design.md`; the main design is `docs/superpowers/specs/2026-10-26-erp-ia-design.md` (owner decisions §22, the accounting module is §22.17). Read `CLAUDE.md` too; its orders apply. Read the plan's "Gap verification" row for this task and its "Needs owner decision" entry when the task names one.

**Where this task sits.** It may start at once (OD-4 decided 2026-10-30, main design §22.20): it runs in wave 1, in parallel with Tasks 1 and 2. Interfaces this task consumes come from: phase 2A code only; read their "Interfaces · Produces" blocks in the plan and use those names, never reinvented ones. This task's own "Interfaces · Produces" block is a contract for later tasks: keep every name and signature exactly as written.

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

- None pinned to this task. The plan's Review Focus still applies where your code touches account security, step-up or transactions.

## The task, verbatim from the plan

### Task 3: Model-backed assistant evals (opt-in job, mock fallback) — OD-4 decided 2026-10-30


**Files:**
- Create: `packages/agent/src/evals/run-evals.ts` (`runEvals`), `packages/agent/src/evals/match.ts` (`matchCall`), `packages/agent/src/__tests__/evals-run.test.ts`, `packages/agent/src/__tests__/evals-model.integration.test.ts`, `scripts/evals.ts` (CLI: `pnpm evals`), `.github/workflows/evals.yml`
- Modify: `package.json` (script `"evals": "tsx scripts/evals.ts"`), `packages/agent/src/index.ts` (export `runEvals`, `EvalReport`), `packages/agent/src/__tests__/evals/accounting.json` (`"tier": "core" | "extended"` per case; the five plan prompts are `core`; the case `accounting-what-happened-to-invoice` expects `{ "entity": "accounting.ledger_line", "filters": [{ "field": "entry_description", "op": "contains", "value": "FE-1234" }], "sort": [{ "field": "date", "dir": "asc" }] }`)
- Modify: `docs/superpowers/plans/2026-10-29-phase-2-accounting.md` execution notes (one bullet: the FE-1234 case queries `accounting.ledger_line` by `entry_description`, because `accounting.entry` has no `source_ref` and `source_ref` holds `entity:uuid`; `source_ref` as the document number is for plan 2B)
- Create: `docs/evals.md` (how to run, read the report, add a case); no user guide changes (nothing changes on screen)

**Interfaces:**
- Consumes: `resolveModel(sql, tenantId, "chat")`, `policyModel(choice)`, `installedAgentModelFactory`/`setAgentModelFactory`, `mockAgentModel` (`runtime/*`); `toolDescriptors(deps, caller, registry)`, `toolSet(descriptors, run)` (`tools/*`); `buildSystemPrompt`, `permissionSummary` (`runtime/system-prompt.ts`); `recordUsage(sql, row)` (`runtime/usage.ts`); the eval JSON files.
- Produces: `runEvals(opts: { sql: Sql; deps: RunProcessDeps; caller: Caller; registry: Registry; cases: EvalCase[] }): Promise<EvalReport>`; `EvalReport = { model: string; cases: { id: string; tier: "core" | "extended"; pass: boolean; got: { tool: string; input: unknown } | null; why?: string }[]; passRate: number; corePass: boolean }`; `matchCall(expect: EvalCase["expect"], got: { tool: string; input: unknown }): string | null` (null = match; subset match of `expect.input`, tool by `toolName(process)`); the turn runs with `maxSteps: 1` and tool `execute` replaced by a recorder (no process runs, nothing written); every call metered with `recordUsage` under the eval caller.

Values (OD-4, decided 2026-10-30): pass when every `core` case passes and `passRate ≥ 0.9`; the report is written to `eval-report.json` and summarised in the job log; the job runs nightly on `main` (`schedule: "17 6 * * *"`, 01:17 Bogotá) and on `workflow_dispatch`, only when the secret `AI_GATEWAY_API_KEY` exists; on every push the integration test runs the same runner with `AGENT_MODEL=mock` so the plumbing stays tested at no cost.

- [ ] **Step 1: Write the failing tests**

```ts
// evals-run.test.ts (unit)
it("matchCall: subset match on input, tool by provider-safe name; a missing field or a wrong enum is a reason", () => { ... });
it("runEvals never executes a tool: the recorder answers and no process runs", async () => { /* fake deps whose runProcess throws */ });
it("corePass is false when one core case fails even with passRate 0.95", () => { ... });
// evals-model.integration.test.ts (local stack, AGENT_MODEL=mock)
it("runs the set with the mock model: the case the mock knows ('gastos de octubre por centro de costo') passes, the report names the model 'mock/agent', usage rows are recorded", async () => { ... });
it("reads the model only from kernel.model_policies: with the chat policy deleted it fails with MissingModelPolicy", async () => { ... });
it("every data.query case's expected input returns rows on the demo ledger once its literal is swapped for a seeded one (FE-1234 → FE-1001)", async () => { /* run kernel.data.query as Laura with the case's input; rows > 0 */ });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm -F @erp/agent test -t evals-run && pnpm -F @erp/agent test:integration -t evals-model`
Expected: FAIL (`runEvals` not exported).

- [ ] **Step 3: Implement** `matchCall`, `runEvals` (`generateText` with the policy model, the caller's tool set, the system prompt, `toolChoice: "auto"`, one step), `scripts/evals.ts` (seeds nothing: runs as the demo company's Laura on a stack with `DEMO_SEED=1`, prints the table, writes `eval-report.json`, exits 1 when the threshold fails), `.github/workflows/evals.yml` (supabase start, `pnpm db:seed` with `DEMO_SEED=1`, `pnpm evals`, upload `eval-report.json`; `if: ${{ secrets.AI_GATEWAY_API_KEY != '' }}` through an env check step).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm -F @erp/agent test && pnpm -F @erp/agent test:integration -t evals-model && AGENT_MODEL=mock pnpm evals`
Expected: PASS; the mock run reports the cases it cannot answer as failures and exits 1 — the CLI accepts `--allow-fail` for the mock run, which the integration test does not need.

- [ ] **Step 5: Commit**

```bash
git add packages/agent scripts/evals.ts package.json .github/workflows/evals.yml docs/evals.md
git commit -m "feat(agent): model-backed eval run with a nightly opt-in job and a mock fallback"
```

## When you finish

Report, in this order: the tests you ran with their pass counts (paste the last lines of each run), the files created and modified, the commit hash, and any point where you had to choose something the plan left open, or where you stopped because the plan or the design would have been broken. Do not claim the task is complete before the pre-commit gate passed locally; say so plainly if a step was skipped or a suite is still red.
