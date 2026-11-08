---
tags: [resource, memory]
date: 2026-11-07
status: active
---

# Memory: phase-2a-accounting-plan

_Copied from Claude auto-memory._

On 2026-10-29 the owner approved `docs/superpowers/specs/2026-10-28-accounting-module-design.md` ("Approve, write plan") after the additions of §10b.13–19 (analytic masters, exógena, aging, business unit, five controls, security by account, Fuente rename, Movimientos query page). The entry was applied to the main design §22 as item 17. The phase 2A plan (32 tasks, parts A–G: kernel extensions, pack, schema, entries and engine, reports, UI, catalogues/demo/guides) is at `docs/superpowers/plans/2026-10-29-phase-2-accounting.md`.

**Why:** The owner wrote "DO NOT EXECUTE PLAN YET" on 2026-10-28 and has not yet chosen an execution method (subagent-driven or native). Phase 2 is split: 2A accounting, 2B sales/invoicing/inventory/payments, 2C onboarding.

On 2026-10-30 the owner asked for one session prompt per task; they are in `docs/superpowers/plans/2026-10-29-phase-2-accounting-prompts/` (32 files + README index, task text copied verbatim from the plan, mandatory reading line, dependency and environment notes). An HTML presentation of the plan sits beside the markdown plan.

**How to apply:** Do not start implementing phase 2A tasks until the owner explicitly says to execute and names the method. Default rule templates of §5.4 ship as accounting fixtures until plan 2B relocates them. Related: [[Memory - erp-ia-design-decisions]], [[Memory - enforce-rules-and-design]].

Index: [[Memory Notes]].
