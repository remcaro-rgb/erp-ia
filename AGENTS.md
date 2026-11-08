# ERP-IA · instructions for every agent and session

These instructions apply to every task in this repository, whichever model or tool runs it (Claude Code sessions, subagents, workflows, other coding agents reading `AGENTS.md`). They are the owner's standing orders.

## Read before any work
1. `docs/project-rules.md` — the 37 rules. Binding. Read the whole file before writing code, migrations, docs or tests.
2. `docs/superpowers/specs/2026-10-26-erp-ia-design.md` — the design. Read the sections your task touches (kernel §5, security §6, AI §7, modules §8, grids §9, UI §19a, owner decisions §22). `docs/superpowers/specs/2026-10-28-adaptive-ui-agent-design.md` for the phase 3 adaptive UI agent.
3. `docs/roadmap.md` — the phase your task belongs to and its exit criteria. Do not pull work from a later phase into the current one.
4. The plan of the current phase in `docs/superpowers/plans/` — the task's exact files, interfaces, values and tests. Phase 1: `2026-10-27-phase-1-foundation.md`. Phase 2A (posting engine and accounting, approved design `2026-10-28-accounting-module-design.md`): `2026-10-29-phase-2-accounting.md`, written 2026-10-29 for the owner's review; do not execute it until the owner says so. One ready-to-paste session prompt per task lives in `docs/superpowers/plans/2026-10-29-phase-2-accounting-prompts/` (index in its `README.md`).
5. The prototype `docs/superpowers/specs/2026-10-27-erp-ia-phase1-prototype.html` is the visual and behavioural contract for phase 1 UI.

## Non-negotiables (summary; the rules file is the authority)
- Every state change is a registered process run through `runProcess`; the assistant has no tool outside the registry; RLS on every table; field visibility enforced in views; append-only audit with origin and causal chain; step-up for sensitive processes.
- One schema per module, cross-module only through published views and outbox events; fiscal logic only in `packages/localization/<country>`; no Vercel-only runtime APIs in business code; Docker stack in CI.
- Spanish Latam copy through `packages/i18n`; money `$ 1.234.567,00`; UUID v7 + gap-free `seq` on every row; DIAN-complete parties and products; `invoice_ready` gates documents.
- Models only through the AI SDK and `kernel.model_policies`; every LLM call metered; writes by the assistant only after a confirmation card.
- Test first; plan before code; no commit or push unless the owner asks; migrations forward-only; a feature without its user guide is not finished.

## How to work here
- If a task would break a rule or deviate from the design, stop and say so; the fix is a design change recorded in the design's §22 by the owner, never a silent workaround.
- When delegating (subagent, session, workflow), the brief must say: "Read `docs/project-rules.md` and the design sections for X before starting; follow the plan task verbatim." A brief without that line is incomplete.
- Reviews check the Review Focus of the plan and the rules; a reviewer rejects work that passes tests but breaks a rule.
- Keep `docs/roadmap.md`, `docs/project-rules.md` and the design in sync with any owner decision; record the decision date.
- Prototype and docs live in `docs/`; scratch work never lands in the repo.
- Development runs on the local Supabase stack (OrbStack); the hosted project and Vercel are the shared demo and the deployed app (design §22.18). Before a commit: lint, typecheck, check:rules, unit, the touched integration files and e2e specs, the build. The full suites run in GitHub Actions on the push; a task is complete only when that run is green.

## Project facts
Stack: pnpm monorepo, Next.js 16 App Router, Supabase (Postgres, Auth, Storage), Vercel AI SDK + Workflow DevKit, shadcn + Tailwind v4, TanStack Table, Vitest + Playwright. Demo company: Café del Norte S.A.S., NIT 900373115-3. Default locale `es-419`, country pack `co`, currency COP. Reusable code to port from `/Volumes/SATECHI2TB/Serena/serena-app` (DIAN, Bold, Siigo, exports) per the design §18a.

## Second Brain (Obsidian vault at `docs/brain`)
- CRITICAL RULE: Every time a significant feature is implemented, a technical decision is made, an error is solved, or architecture changes, the model MUST automatically draft or append a concise Markdown note about it inside the project's Obsidian Vault folder (`docs/brain`, PARA layout; see `docs/brain/000_Index.md`).
- CRITICAL RULE: Always format links inside notes using standard Obsidian wikilinks [[Note Name]].
- CRITICAL RULE: Include metadata frontmatter (tags, date, status) at the top of every generated note.
- `scripts/sync-brain.sh` appends recent commits and an architecture summary to `docs/brain/00_Inbox/Inbox Log.md`. Vault notes are docs, not scratch work; design decisions still go to the design §22 by the owner.
