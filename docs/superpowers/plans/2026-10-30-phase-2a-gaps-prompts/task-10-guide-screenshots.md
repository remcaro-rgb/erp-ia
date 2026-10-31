# Prompt · Phase 2A gaps · Task 10 of 10 · Screenshots in the accounting guides

Paste this whole file as the first message of a new session in `/Volumes/SATECHI2TB/erp-ia`.

---

You are implementing **Task 10** of the Phase 2A gaps plan of ERP-IA: `docs/superpowers/plans/2026-10-30-phase-2a-gaps.md` (Part D · Owner additions (2026-10-30)). Do this task only; nothing from any other task.

**Read before starting.** Read `docs/project-rules.md` and the design sections for this task before starting; follow the plan task verbatim. The design sections are: main design §19a (UI), §22.9 (prototype v5); accounting design §8 (every screen the guides show); the help index (`packages/kernel/src/help`); rules 24, 35. The accounting design is `docs/superpowers/specs/2026-10-28-accounting-module-design.md`; the main design is `docs/superpowers/specs/2026-10-26-erp-ia-design.md` (owner decisions §22, the accounting module is §22.17). Read `CLAUDE.md` too; its orders apply. Read the plan's "Gap verification" row for this task and its "Needs owner decision" entry when the task names one.

**Where this task sits.** Start only when Tasks 1–7 and 9 are merged, so the screenshots show the final screens. It may run in parallel with Task 8 only. Interfaces this task consumes come from: Tasks 1–7, 9 (the screens as they end up); read their "Interfaces · Produces" blocks in the plan and use those names, never reinvented ones. This task's own "Interfaces · Produces" block is a contract for later tasks: keep every name and signature exactly as written.

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

4. **Idempotent, order-independent end-to-end runs.** The year close spec creates and removes its own company, never touches the demo company, and passes when run alone, first, last or twice; the smoke keeps its preconditions. Test in Task 2 (run the spec twice in a row and with the smoke after it).

## The task, verbatim from the plan

### Task 10: Screenshots in the accounting guides


**Files:**
- Create: `apps/web/guide-shots/accounting.shots.ts` (one Playwright test per placeholder), `apps/web/playwright.guides.config.ts` (`testDir: "./guide-shots"`, `testMatch: "*.shots.ts"`, viewport 1440 × 900, `colorScheme: "light"`, locale `es-419`, timezone `America/Bogota`, no `webServer`: it runs against `E2E_BASE_URL`), `docs/user-guide/es-419/contabilidad/img/` (fifteen PNGs), `scripts/__tests__/guide-images.test.ts`
- Modify: `apps/web/package.json` (script `"guide:shots": "playwright test -c playwright.guides.config.ts"`), the fourteen guides (each `[Captura: <texto>]` becomes `![<texto>](img/<slug>.png)`), `packages/kernel/src/help/guides.ts` (an image line contributes its alt text only, not the markdown, to the chunk), `docs/user-guide/es-419/README.md` (how to refresh the screenshots)
- Test: `packages/kernel/src/help/__tests__/help.test.ts`, `scripts/__tests__/guide-images.test.ts`

**Interfaces:**
- Consumes: the demo company after `pnpm db:reset && DEMO_SEED=1 pnpm db:seed` and the help index; the demo accounts `LAURA`, `MARCELA` (`scripts/demo/accounts.ts`); `login` as in `accounting-smoke.spec.ts`; the final UI of Tasks 1–9.
- Produces: `docs/user-guide/es-419/contabilidad/img/<slug>.png`; slugs: `auxiliares-abiertos-arbol`, `cartera-por-edades`, `centros-de-costo-arbol`, `comprobantes-listado`, `comprobante-borrador-lineas`, `conceptos-exogena-sin-concepto`, `movimientos-agrupado`, `auditoria-comprobantes-manuales`, `informes-tarjetas`, `plan-de-cuentas-arbol`, `pendientes-de-contabilizar`, `periodos-cerrar`, `regla-contable-lineas`, `seguridad-cuenta-restringida`, `unidades-de-negocio-tabla`.

Rules for the captures: each test signs in as Laura (Marcela for nothing: the restricted views are documented in words), opens the screen the placeholder names and screenshots the `main` region (`animations: "disabled"`, the clock fixed with `page.clock.setFixedTime("2026-10-30T15:00:00-05:00")`); a state the demo does not hold (a draft with lines, a pending posting failure, an account with movement and no exógena concept) is created by the test through the same fixture SQL the e2e specs use and removed in `afterEach`, so the demo company ends as it started; the shots spec is not part of `pnpm -F web e2e` (other `testDir`), so CI never rewrites the images. PNGs only, each under 300 KB (`pngquant` is not required: the viewport size keeps them small).

- [ ] **Step 1: Write the failing tests**

```ts
it("no guide keeps a [Captura: …] placeholder and every image a guide names exists under its img/ folder", () => { ... });
it("a guide image line reaches its chunk as its alt text only", () => { /* chunk text of '![Plan de cuentas en vista Árbol](img/plan-de-cuentas-arbol.png)' is 'Plan de cuentas en vista Árbol' */ });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm vitest run scripts/__tests__/guide-images.test.ts && pnpm -F @erp/kernel test -t "image line"`
Expected: FAIL (fifteen placeholders; the chunk keeps the markdown).

- [ ] **Step 3: Implement** the shots spec and config, the alt-text rule in `guides.ts`; run `E2E_BASE_URL=http://127.0.0.1:3100 pnpm -F web guide:shots` on a freshly seeded demo; replace the placeholders; look at every PNG (it must show what its alt text says, in Spanish, light theme, no dev overlay).

- [ ] **Step 4: Run the tests and the help index to verify they pass**

Run: `pnpm vitest run scripts/__tests__/guide-images.test.ts && pnpm -F @erp/kernel test && pnpm help:index && E2E_BASE_URL=http://127.0.0.1:3100 pnpm -F web e2e accounting-smoke`
Expected: PASS; the smoke still passes after the shots ran (the demo is unchanged).

- [ ] **Step 5: Commit**

```bash
git add apps/web/guide-shots apps/web/playwright.guides.config.ts apps/web/package.json docs/user-guide/es-419 packages/kernel/src/help scripts/__tests__/guide-images.test.ts
git commit -m "docs(accounting): screenshots in the accounting guides, captured from the demo company"
```

## When you finish

Report, in this order: the tests you ran with their pass counts (paste the last lines of each run), the files created and modified, the commit hash, and any point where you had to choose something the plan left open, or where you stopped because the plan or the design would have been broken. Do not claim the task is complete before the pre-commit gate passed locally; say so plainly if a step was skipped or a suite is still red.
