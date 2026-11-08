---
tags: [resource, memory]
date: 2026-11-07
status: active
---

# Memory: ui-ux-remediation-executed

_Copied from Claude auto-memory._

The owner ordered execution of `docs/superpowers/plans/2026-10-31-ui-ux-remediation-prompt.md` on 2026-10-31 (all UX-OD-1..7 decided, §22.21). All 13 tasks were implemented in the working tree, **uncommitted** (the owner has not asked for commits; one commit per task when asked, `fix(ui): …` / `fix(kernel): …`).

**Why:** the review found 15 UI/UX findings; decisions were taken as recommended.
**How to apply:** before committing, run `pnpm exec eslint apps packages scripts --ignore-pattern ".claude/**"` (root `pnpm lint` trips on `.claude/worktrees` copies), typecheck, `pnpm check:rules`, `pnpm test`, `pnpm with-env pnpm test:integration:changed`, `pnpm build`; the dev server on :3100 belongs to another chat (do not kill it, use `preview_start` with `url`). Playwright specs touched: shell, admin, smoke (module-bar items are now links, not buttons) — see [[Memory - enforce-rules-and-design]], [[Memory - ui-ux-remediation-plan]].

Index: [[Memory Notes]].
