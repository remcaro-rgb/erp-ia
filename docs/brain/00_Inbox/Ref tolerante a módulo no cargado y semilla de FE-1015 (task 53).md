---
tags: [task-53, kernel, registry, refs, import, sales, crm, decision]
date: 2026-11-08
status: done-uncommitted
---

# Ref tolerante a módulo no cargado y semilla de FE-1015 (task 53)

Part of [[Plan phase-2b-sales-stock-chain]] («Task 53: Task 52 leftovers»); owner decisions of 2026-11-08 in [[Plan phase-2b-owner-decisions-pending]] (items 105, 106, 109, and 67). Follows [[Revisiones de la tanda 2B.2 (task 52)]] (52.6 was left blocked there). Rules in [[Project Rules]] (3, 4, 14, 21). Modules: [[Module sales]].

## 53.2 `quote_id` as a `ref` to `crm.quote` [105, 67]
- Kernel: `entityModuleOf(id)` (`registry/fields.ts`, the id up to the first dot). `maestroRefs` (`typed/runner.ts`) skips a ref whose target module is not loaded: no usability gate, the raw id stays usable. A ref to an entity a loaded module does not declare still throws (fail closed).
- Import: `resolveReferences` (`import/validate.ts`) leaves out a ref column whose target module is not loaded: the cell keeps its text, nothing is looked up. `columns.ts` and `submit.ts` look up no ref target, so they did not change.
- Load time: `loadModules` (`module/loader.ts`) refuses `entity <id>, field <f>: ref <target> is not an entity of module <m>` when the target's module is loaded (already in the registry or in the same call) and the entity is missing. A target in a module that is not loaded is an optional neighbour's and is not checked.
- Sales: `f("quote_id", "ref", ref("crm.quote", "number"))`. The manifest, menu, `dependsOn` and `needs` still name no crm (rule 3). The grid and the frame show the quote's number as a link when crm is loaded and the viewer reads the quote. Guide: `docs/user-guide/es-419/pedidos.md`.
- Evidence: with the guard off, 30 of the 76 sales integration tests fail. With it on, all 76 pass.
- Other ref consumers already tolerated a missing target: `query/ref-labels.ts` (hasModule), `gridEntity` (try/catch, so the web's `linkableEntities` and `refTargets` are covered), `records/titles.ts` (gets resolved entities from `auditEntityOf`), the web's `lifecycle-actions.ts` (a `find`), and the UI's `GridCell` and `ResultTable` (they only draw the link).
- Open point: the load check runs only for the modules being loaded. A module loaded in a later `loadModules` call does not re-check older refs into it. The app loads everything in one call (`apps/web/src/lib/server/runtime.ts`).

## 53.3 La semilla anula FE-1015 con la nota crédito NC-303

- La semilla de la contabilidad demo ya no envía `invoicing.invoice.voided` (regla retirada en 0142, ver [[Revisiones de la tanda 2B.2 (task 52)]]): envía `invoicing.note.issued` con `kind: "credit"`, `annulment: true`, `reasonCode: "2"` (concepto de anulación de la tabla 13.2.4), números negativos iguales a los de FE-1015 (base 3.000.000, IVA 19 % 570.000, total -3.570.000), fecha 2026-10-20 y `noteId = documentId("e", CREDIT_NOTES.length + 1)`. La regla por defecto `note-annulment-issued` la contabiliza en VT (VT-16).
- Ruling R53-2: las facturas de la semilla son eventos de libro sin fila en `invoicing.invoices`, así que la ruta real `invoicing.invoice.void` no puede correr; la semilla emite el mismo evento que esa ruta. Si estuviera mal: el demo muestra el asiento pero no una fila de `invoicing.notes`.
- Datos: `ANNULMENT_NOTES` en `scripts/demo/ledger-data.ts`; payload puro `annulmentPayload` en `scripts/demo/accounting.ts` (probado en `seed-accounting.test.ts`). Los 40 documentos siguen siendo 40 (la segunda anulación pasó de evento a nota). Decisión del dueño: item 106 en [[2026-11-05-phase-2b-owner-decisions-pending]].
- Hallazgo: `seed-demo.integration.test.ts` buscaba los términos del cliente en ALMACENES_EXITO y la semilla los crea para `PRICE_LIST.customer`; corregido en la prueba.
