---
tags: [project, warehouse, sales, kernel, ui, demo, phase-2b]
date: 2026-11-11
status: built
---

# Warehouse screens and demo (2B.2 task 29.4)

Last sub-task of Bodega in [[Part G design (2B.2 tasks 28-30)]] (PG §4.4, §6; RG-9), after [[Packing and put-away (2B.2 task 29.3)]]. Rules: [[Project Rules]] (1, 3, 14, 15, 20, 21). Owner items 239–243 in [[Plan phase-2b-owner-decisions-pending]] (section AG). No migration.

## What was built
- **Kernel: a record tab may run one process** (item 239). `RecordTabContribution` gains `recordField` (the source column holding the host's id) and `action: { label, process, inputField }`; `defineModule` checks the process is the module's own and the tab is a grid. The web resolves the action only for a caller who may run it; `runContributedAction` runs it with `{ [inputField]: recordId }`; a `created: false` answer shows `<label>_reasons.<reason>`.
- **«Alistamientos» on `sales.order`**: warehouse's grid of `warehouse.pick` by `order_id`, with «Crear alistamiento» (`warehouse.pick.create`). Sales does not name warehouse (rule 3).
- **Record pages** for `warehouse.pick` and `warehouse.pack` (`recordPage: true`, created only from their source): facts with links, the stage pill, pick lines with «Tomado de» (the buckets of the product in the bodega) and quantity, Iniciar / Guardar / Confirmar alistamiento / Crear empaque; packages with weight and measures, Guardar paquetes / Cerrar empaque. Server side in `apps/web/src/lib/warehouse/` (`record.ts`, `actions.ts`, `screens.ts`).
- **Menus**: Bodega › Documentos (Alistamientos, Empaques, Ubicar recibidos — item 240), Reportes (Pendientes por alistar), Parámetros (Reglas de ubicación, Configuración, Plantillas).
- **Report** `warehouse.pending_picks` (`warehouse.report.pending_picks`): confirmed pedidos with goods to pick and no confirmed alistamiento, oldest first, with the open alistamiento; filters bodega and dates; exports.
- **Demo** (seed step 12, `scripts/demo/warehouse.ts`; item 241): `module:warehouse` entitled in `supabase/seed.sql`, switched off until step 12; the FEFO pedido picked, delivered from its pick and shipped, packed and closed; a bin and a rule per stocked category; a receipt put away to EST-GRA.
- **Eval** «Crea un alistamiento para el pedido 18» → `warehouse.pick.create` with a confirmation card (owner item 212).
- **Guide** `docs/user-guide/es-419/bodega.md` (item 219) covers every Bodega route.

## Lessons
- An entitled module consumes events unless `kernel.company_modules` says it is off (`moduleGate`): to enable a module late in a seed, switch it off first, or the earlier documents get its work (the first demo run gave every pedido an alistamiento).
- The i18n test reads one namespace per file (the first translator): a client file that uses several namespaces must be split, or use whole-path keys from a root translator only for dynamic keys.
- `kernel.document_links` is not readable by the authenticated role: the screens show the pick's entrega in Relacionados, not as a fact.

Related: [[Warehouse module and picks (2B.2 task 29.1)]], [[Pick-driven delivery (2B.2 task 29.2)]], [[Module inventory]].
