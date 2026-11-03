# Session prompt · execute the UI/UX remediation plan (2026-10-31)

Paste everything below the line into a new Claude Code session at `/Volumes/SATECHI2TB/erp-ia`. Before pasting, make sure the owner has said to execute the plan and has filled in the decision status line in §2 of the plan.

---

You are executing `docs/superpowers/plans/2026-10-31-ui-ux-remediation.md` in ERP-IA (`/Volumes/SATECHI2TB/erp-ia`, app on http://localhost:3100, local Supabase stack on OrbStack).

**Read before starting:** `AGENTS.md`, the whole of `docs/project-rules.md`, and the design sections for §9 (grids, exports), §19a (UI direction), §22.9, §22.11, §22.14, §22.15, §22.17, §22.20 (shell, density, references and grid parameters), §7.1 (assistant) of `docs/superpowers/specs/2026-10-26-erp-ia-design.md`, plus §8 of `docs/superpowers/specs/2026-10-28-accounting-module-design.md`. Then read the plan in full. Follow each plan task verbatim. If a task would break a rule or deviate from the design, stop and report; do not work around it.

**Preconditions (check first, stop if one fails):**
1. The owner has ordered execution of this plan in this session or in the plan.
2. `git status` shows no uncommitted edits to the files the plan touches (`DataGrid.tsx`, `cell-format.ts`, `form-parts.tsx`, `components.css`, `EntryForm.tsx`, `LinesEditor.tsx`, `grid-page.tsx`, `date-format.ts`, i18n catalogues). If there are, do not overwrite, revert or commit them: stop and ask the owner to settle them.
3. Read the **Decision status** line in §2 of the plan. A decision counts only when it reads `decided <date>: <option>` and §22.21 of the design records it.

**What to run:**
- Always runnable (no decision needed), in this order: **T1** nav dedupe → **T3** date/period/timestamp labels → **T7** module context and tab titles → **T9** entry form feedback → **T10** report parameters → **T11** business labels first → **T13** KPI value wrap and empty states (not the drill-downs).
- Gated tasks run only when their decision is decided: **T2** (UX-OD-5, after T1), **T4** (UX-OD-3), **T5** (UX-OD-1), **T6** (UX-OD-2, after T5), **T8** (UX-OD-4), **T12** (UX-OD-6), **T13 drill-downs** (UX-OD-7). Implement the option the owner chose, not the recommendation, if they differ. Skip a pending one and list it in your report.
- Do not adopt shell v7 (`2026-10-31-shell-v7-sidebar.md`) unless UX-OD-1 says so. Do not implement deferred features (e.g. "Guardar reporte") to remove disabled controls; give them an accessible explanation instead.

**How to work each task:**
1. Write down the reproduction, the root cause (the plan's §1 row, re-checked in source), the shared components affected and the acceptance criteria.
2. Write the failing test first (Vitest unit, integration on the Docker Supabase stack, Playwright), run it, and see it fail for the right reason.
3. Implement with the existing components and formatters (`cell-format.ts`, `date-format.ts`, `formatMoney`, the `erp-*` stylesheet and tokens). Keep Spanish Latam copy through `packages/i18n` with the same keys in `en.json`, Source Sans 3 / JetBrains Mono, 36 px desktop rows, and 44 px targets only on coarse pointers or below 768 px.
4. Do not touch `runProcess`, RLS, field visibility in views, audit, step-up or tenant isolation. New label paths read the same masked views; check that a masked value stays masked in grids, forms, exports and the assistant.
5. Update the affected guide in `docs/user-guide/es-419` (rule 35).
6. Verify: lint, typecheck, `check:rules`, the unit suites, `pnpm test:integration:changed`, the touched Playwright specs, the web build. In the browser (preview tools, dev server on :3100 only; never kill other `next-server` processes), take before/after screenshots at 390, 768, 1280 and 1440 px with the assistant open and closed, in light and dark. Also check keyboard-only use, 200 % zoom, long labels, and the empty, loading and error states.
7. For T4, test the hierarchical fixture: a group and two leaves, a filter that drops the group, and a selection of a group with its child. Check the grid footer, selection totals, CSV, XLSX and PDF. Never hard-code the demo's amounts.
8. Use a fresh reviewer subagent per task. Its brief says: "Read `docs/project-rules.md` and the design sections for §9, §19a, §22.11, §7.1 before starting; review against the plan task verbatim and the rules; reject work that passes tests but breaks a rule."

**Do not commit or push** unless the owner asks in this session. When asked, commit one task per commit with a conventional message (`fix(ui): …`, `fix(kernel): …`). A task is complete only when the GitHub Actions run on the push is green.

**Report at the end:**
- each task: done or skipped (with the pending decision), tests added, checks run with their results, screenshot paths;
- anything you could not verify;
- the assistant checks ran on the mock provider, so they cover presentation only, not model reasoning.

Do not claim accessibility certification, production performance or end-to-end transaction correctness.
