---
tags: [project, plan]
date: 2026-11-07
status: active
---

# ERP-IA Phase 2A gaps: the known gaps of the accounting module — Implementation Plan

Source: `docs/superpowers/plans/2026-10-30-phase-2a-gaps.md` (written 2026-10-30).

**Goal:** Close the eight gaps the Phase 2A hand-off listed (plan 2026-10-29-phase-2-accounting.md, "Execution notes"), so the accounting module does what its design says on every path: an XML button for exógena, the "Sin acceso" note where a restricted account is asked for, statement totals equal to the admin's on every column, an end-to-end test of the year close, the period figure in the masters' Tabla, 

## Parts
- Part A · Independent fixes (run in parallel)
- Part B · Report refusals and the exógena file (in order)
- Part C · Planned on the owner's decisions
- Part D · Owner additions (2026-10-30)

## Tasks (10)
- Task 1: Trial balance and libro mayor keep each side of the restricted row
- Task 2: "Cerrar año" end to end on its own company
- Task 3: Model-backed assistant evals (opt-in job, mock fallback) — OD-4 decided 2026-10-30
- Task 4: Report and grid refusals show their note; a missing and a restricted account answer the same
- Task 5: "Exportar XML" on the Información exógena page
- Task 6: Devolver a borrador as its own process — OD-1 decided 2026-10-30 (option A)
- Task 7: The period figure in the masters' Tabla — OD-2 decided 2026-10-30 (option A)
- Task 8: Accounting copy under a module namespace — OD-3 decided 2026-10-30 (option A)
- Task 9: The restricted Cuenta frame gets the status footer, the deep link and a masked N.º
- Task 10: Screenshots in the accounting guides

Related: [[Roadmap]], [[Project Rules]], [[Design Spec Index]], [[10_Projects]].
