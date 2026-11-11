---
tags: [resource, memory]
date: 2026-11-07
status: active
---

# Memory: phase-2a-gaps-plan

_Copied from Claude auto-memory._

Plan `docs/superpowers/plans/2026-10-30-phase-2a-gaps.md` with ten per-task prompts in `docs/superpowers/plans/2026-10-30-phase-2a-gaps-prompts/`. It closes the 2A hand-off gaps plus three owner additions (restricted Cuenta frame footer/deep link, guide screenshots, FE-1234 eval).

Owner decisions of 2026-10-30, all taken as recommended and recorded in main design §22.20, accounting design §5.12.1/§6/§8, rules 24 and 30:
- OD-1: `accounting.entry.return_to_draft` as its own process; `entry.update` refuses pending entries.
- OD-2: declared grid parameters (`EntityDef.gridParams`, `GridState.params`, `erp.param.<name>` settings) feed the masters' Tabla period figure.
- OD-3: registry keys stay by kind; module page copy goes in a `<module>.*` namespace (`accounting.*` first).
- OD-4: model evals nightly plus on manual dispatch, only with the gateway secret; pass = every core case and at least 90% overall; mock run on every push; a red nightly run does not block merges.

**Why:** `source_ref` in `v_ledger_lines` is `entity:uuid`, not the document number. Making it the number is left to plan 2B.
**How to apply:** nothing left to execute: tasks 1–10 are merged in main (commits `merge: gaps task N`, e.g. 0e23a30 for task 10). Do not re-run the plan; its header text "do not execute" and migration number 0036 are stale (latest is 0054). Related: [[Memory - phase-2a-accounting-plan]], [[Memory - enforce-rules-and-design]].

Index: [[Memory Notes]].
