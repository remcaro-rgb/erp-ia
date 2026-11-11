---
tags: [resource, memory]
date: 2026-11-07
status: active
---

# Memory: enforce-rules-and-design

_Copied from Claude auto-memory._

Every task in erp-ia must follow `docs/project-rules.md` and the design docs, regardless of the model executing it. Mechanisms in place: root `CLAUDE.md` and identical `AGENTS.md`, plan header enforcement note, Task 1 lint/CI checks.

**Why:** the owner wants the architecture (process registry, RLS, audit, localization pack, DIAN completeness) to survive delegation to subagents, workflows and other tools.

**How to apply:** every brief I write for a subagent or session on this project must include "Read docs/project-rules.md and the design sections for X before starting; follow the plan task verbatim". Reviewers reject rule-breaking work even if tests pass. Deviations go to the owner as a design change, never a silent workaround. Related: [[Memory - erp-ia-design-decisions]], [[Memory - adaptive-ui-agent-decisions]].

Index: [[Memory Notes]].
