---
tags: [project, kernel, security, accounting, reports, ui, owner-decision]
date: 2026-11-11
status: built
---

# Step-up exemptions, aging drill-down, entry in Contabilidad tab (2026-11-11)

Owner request of 2026-11-11, recorded as design §22.32 and in rule 15 of [[Project Rules]]. Related: [[Owner Decisions]], [[Module accounting]], [[Reports]].

## Step-up per process, also by definition
- `kernel.sensitive_processes.mode` accepts `exempt` (migration `0175_kernel_step_up_exempt`). A process whose definition asks for the step-up asks unless the company has an `exempt` row; any other asks when the company marked it (`self_2fa`, `supervisor`).
- The gate in `runProcess` (top-level and nested) and the assistant's `needsStepUp` read the mode. `kernel.sync_sensitive_defaults` keeps `on conflict do nothing`, so an exemption survives module enables.
- `kernel.admin.sensitive_process.set` no longer refuses lowering; new `kernel.admin.sensitive_process.set_all` switches a list at once (one code). «Procesos sensibles» unlocks every row, warns on an exempted default-on process and has a «Todos los procesos» switch.

## Aging drill-down
- New report `accounting.aging_detail` («Detalle de cartera»): the open items behind a figure of the Cartera por edades (party, bucket, currency), each with its comprobante; shares `agingItems` / `agingBucket` with the aging so the sums match.
- `ReportColumn.drill` marks clickable figures; `ReportPage.onCellDrill` renders them as links; the app opens the detail in its own tab (`agingDrillHref`). The detail is a page without a card (`DRILL_REPORTS`).

## Comprobante in the Contabilidad tab
- `EntriesTab` (server) replaces the grid of comprobantes with each comprobante's own Datos form, read-only (header + lines), up to four; more keeps the grid. `WithoutRecordBridge` keeps the embedded form away from the document's Guardar / ⌘S / unsaved guard.
