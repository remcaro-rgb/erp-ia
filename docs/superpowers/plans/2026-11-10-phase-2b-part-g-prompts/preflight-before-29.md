# Prompt · Phase 2B.2 · Part G · Preflight before Task 29

Paste this whole file as the first message of a new session in `/Volumes/SATECHI2TB/erp-ia`.

---

You are running the **preflight before Task 29** (warehouse) of Phase 2B.2 of ERP-IA. The owner approved this path in chat on 2026-11-10. It clears what would stop or slow the 29.1–29.3 sessions: the failing pre-commit gates, the e2e sign-in on `127.0.0.1:3100`, the open owner items left by Tasks 28 and 30, and the missing sub-task 28.5 (forms for lots and serials). Do only what this prompt lists. Do not start 29.1 and do not build 28.5.

**Read before starting.** Read `docs/project-rules.md` and the design sections for Part G (`docs/superpowers/specs/2026-11-10-part-g-design.md`, PG §3 lots and serials, PG §4 warehouse), modules §8 and §8.1 and owner decisions §22 (§22.28 to §22.31) of `docs/superpowers/specs/2026-10-26-erp-ia-design.md`. Follow this prompt verbatim. The plan is `docs/superpowers/plans/2026-11-03-phase-2b-sales-stock-chain.md`, section «Expanded tasks of Part G»; the open items are in `docs/superpowers/plans/2026-11-05-phase-2b-owner-decisions-pending.md`, sections U to AB (items 165–208).

**Already done (do not redo).** Item 151 (bins are inventory locations) is recorded as §22.31, and the pending file says so. Never edit §22 or `docs/project-rules.md` yourself.

**How to work.**
- Branch `phase-2b-sales-chain` unless the owner names another; do not create one.
- Environment: the local Supabase stack (Docker via OrbStack); check Docker is up before `pnpm db:reset`. The app's dev server is `:3100` through `.claude/launch.json`; stop or start only that one (the preview tools or `lsof -ti:3100`), never `pkill next-server` (another project runs on `:3000`). Never run the full integration suites against the hosted project.
- If a step would break a rule or deviate from the design, stop and report; the fix is an owner decision, never a workaround.
- Commit only when the owner asks in the session: one conventional commit for parts 1 and 2 (`chore(2b): ...`) and one for parts 3 to 5 (`docs(2b): ...`), each ending with the `Co-Authored-By:` line of the model running the session. Never push, tag or open a PR unless the owner says so.

## Part 1 · The pre-commit gates (item 208, decided as recommended)

1. **Lint.** Add `".superpowers/**"` to the `ignores` array in `eslint.config.js` (the first config object, next to `".claude/worktrees/**"`). Run `pnpm lint`; expected: no errors. Do not move or delete `.superpowers/`: other sessions read its ledgers.
2. **Payments unit tests.** `packages/modules/payments/src/entities.test.ts` lines 165 and 205 expect the receipt rule's dimension `payment_method:transfer`; since 34.8b (commit `e49d3af`) the rule emits `payment_method_id:<uuid>`. Run `pnpm -F @erp/module-payments test` (check the package name in its `package.json`) and show the 2 failures. Read the receipt rule and its 34.8b test to learn the exact shape, then update **only the two assertions** to it. Do not change the rule. Run again; expected: 36 of 36 pass.
3. **Module packages in the root test run.** `vitest.workspace.ts` lists only `core` and `support` of `packages/modules/*`. Add the other seven configs that exist: `accounting`, `costing`, `crm`, `inventory`, `invoicing`, `payments`, `sales`. First check `.github/workflows/` and the root `package.json`: if CI already runs these packages' unit tests some other way, say so and add them anyway only if it doesn't run them twice. Run `pnpm test`.
4. **Any test that now fails.** For each newly visible failure, find its cause with `superpowers:systematic-debugging`:
   - a stale assertion whose code change was an owner-decided task (name the commit and the item) gets the assertion updated, like step 2;
   - anything else is not fixed. Add it to the pending file as a new owner item (next free number after 208, in a new section «AC. Items met in the preflight before Task 29, 2026-11-10 · to decide»), with the failing test, the cause, a recommendation and its cost if wrong, and report it.

## Part 2 · E2E sign-in on `127.0.0.1:3100` (item 205, decided: option A)

1. Add `allowedDevOrigins: ["127.0.0.1"]` to the Next config in `apps/web/next.config.*` (keep every existing key). It affects only `next dev`.
2. Start `:3100` with the preview tools (`.claude/launch.json`), run `pnpm db:reset && DEMO_SEED=1 pnpm db:seed`, then run one spec that signs in with `E2E_BASE_URL=http://127.0.0.1:3100 pnpm -F web e2e <spec>` (pick a short one, for example the sales chain or invoicing parámetros spec). Expected: it signs in and passes. Then stop `:3100`.
3. Leave the prompts' e2e command as it is (`127.0.0.1`); it works now.

## Part 3 · Record the owner's decisions in the pending file

In `docs/superpowers/plans/2026-11-05-phase-2b-owner-decisions-pending.md`, add a «**Decided by the owner in chat, 2026-11-10** (preflight before Task 29): …» line under each section header listed here, and change the header's «· to decide» to «· decided 2026-11-10». Do not change the items' wording.

- **U (165, 166):** 166 confirmed. 165 decided: the forms are built as sub-task **28.5**, in parallel with 29.1 (Part 4).
- **W (170–175):** 170, 171, 172, 173 confirmed as recommended; 174 noted (built in 28.3); 175 decided: built in 28.5 with item 165's forms.
- **X (176–180):** confirmed as recommended.
- **Y (181–185):** confirmed as recommended.
- **Z (186–190):** 186–189 confirmed as recommended; 190 noted.
- **AA (191–198):** confirmed as recommended; 196 accepted for now, as its recommendation says.
- **AB (199–208):** 199–204 confirmed as recommended; 205 decided as option A (`allowedDevOrigins`, Part 2); 207 noted; 208 decided as recommended (Part 1). **206 was not covered by the owner's approval: leave it «to decide»** and say so in the report.

## Part 4 · Expand sub-task 28.5 into the plan and write its prompt (do not build it)

**What 28.5 is (items 165 and 175).** Lotes and Seriales are grid only today, so links to a lot from movement lines and Existencias open nothing (rule 21) and the count sheet cannot add a found lot or serial (rules 35, 37). 28.5 adds:
- a record form for **Lote** and for **Serial** on the inventory record frame (`apps/web/src/lib/inventory/record.ts`), with «Nuevo» and «Duplicar», through the existing `inventory.lot.*` and `inventory.serial.*` processes;
- a record form for **Seguimiento por producto** (product tracking), which asks for the step-up the tracking process already requires;
- an «Agregar encontrado» row on the count sheet that sends `found` (a lot by id or a new code, a scanned serial) to `inventory.count.record`;
- links from movement lines, Existencias and the recall report to the new record pages;
- the user guide sections and the e2e specs for the forms.

Study the code before writing: the process names, inputs and step-up flags that 28.1–28.4 registered, and how the other inventory forms use `record.ts`. Then:

1. Append «**28.5 Forms for lots, serials and tracking; found rows on the count [items 165, 175]**» to the plan's Lane B, after 28.4, in the same format as the other sub-tasks: files (create, modify, test), Interfaces (consumes and produces), test-first steps with test names and assertions, gates. No migration is expected; if one is needed, take the next free number of Task 28's block (0162–0169) and say why.
2. State in it: **runs in parallel with 29.1, in a separate worktree**. It touches inventory UI, i18n, guides and the inventory e2e specs, never `packages/modules/warehouse` or the sales order. If a shared file (the i18n catalogues, the guide index) is touched by both, the later merge rebases.
3. Write `docs/superpowers/plans/2026-11-10-phase-2b-part-g-prompts/task-28-5-lot-serial-forms.md` in the exact format of the other prompts in that folder (same header, «Read before starting», «Where this sub-task sits», «How to work», global constraints, rulings and review focus copied verbatim from the plan, the sub-task text verbatim, gates, report order).
4. Add 28.5 to the folder's `README.md` table («Starts when: the preflight is committed; in parallel with 29.1 in a separate worktree») and to the lanes line.

## Part 5 · README and brain

1. In the prompts folder's `README.md`, replace «Item 151 is still to be recorded by the owner in §22.» with «Item 151 is recorded as §22.31 (2026-11-10).» and add a row for this preflight before 29.1 («Starts when: 28.4 is merged; 29.1 starts when it is committed»).
2. Append a short «Preflight before Task 29 (2026-11-10)» section to `docs/brain/10_Projects/Part G design (2B.2 tasks 28-30).md`: what was fixed, the items decided, 28.5 added. Keep the frontmatter (tags, date, status) and use wikilinks.

## Gates

Before the commits: `pnpm lint`, `pnpm typecheck`, `pnpm check:rules`, `pnpm test` (with the new workspace entries), the e2e spec of Part 2 against `:3100`, and `pnpm build`.

## Report

In this order: each gate with its pass counts (paste the last lines of each run); the files created and modified; any test newly visible in Part 1 step 4, with what you did and the new item number if you added one; the e2e result of Part 2; the items recorded in Part 3, naming 206 as still open; the 28.5 sub-task's file list and whether it needs a migration; the commit hashes if the owner asked for commits; any point where you chose something this prompt left open; any point where you stopped.
