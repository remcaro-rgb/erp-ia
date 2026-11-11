---
tags: [resource, memory]
date: 2026-11-07
status: active
---

# Memory: erp-ia-design-decisions

_Copied from Claude auto-memory._

Design doc: `docs/superpowers/specs/2026-10-26-erp-ia-design.md` (sections 19a and 22 hold these). Decisions by the owner on 2026-10-27:
- UI: direction C shell (navy top bar, tabs, ⌘K, docked assistant) + direction A dashboard home, blue palette; alternatives on canvas https://claude.ai/artifact/PPqmQ4S42Fbu1V9epTmb5z
- Multi-company per tenant modelled from day one, single-company UI until phase 3
- POS: scanners v1, ESC/POS + drawer via WebUSB/local agent in phase 5, no fiscal printer
- AI priced as a token allowance per seat with metering above it and a per-company cap
- Spanish-only UI at launch, i18n plumbing from day one, English in phase 3
- Billing provider Bold (see [[Memory - serena-reusable-code]]); on-prem is a later option but docker-compose + Workflow Postgres World run in CI from phase 1

**Why:** these change scope of phase 1 and the plan; the repo was not a git repo when decided so git history does not record them.
**How to apply:** don't re-ask these; plans should state them as fixed constraints.

Index: [[Memory Notes]].
