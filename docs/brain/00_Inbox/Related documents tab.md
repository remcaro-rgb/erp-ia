---
tags: [web, record-frame, links, task-31, decision]
date: 2026-11-07
status: in-progress
---

# Related documents tab (Task 31, stage D)

Part of [[Plan phase-2b-sales-stock-chain]]; the kernel side is [[Document links kernel API]]; owner decision §22.27 in [[Owner Decisions]]; copy and guide in [[User Guide]].

- The tab id `relacionados` («Documentos relacionados», count chip) is in `recordTabIds` for every record (rule 4: the frame knows no module); `page.tsx` fills it only when `kernel.document_link.trail` returns nodes or a hidden count.
- `apps/web/src/lib/records/related-load.ts` runs the trail through `runProcess` as the caller (never `kernel.document_trail` directly), names each visible node with `recordTitles` and shapes it with `relatedModel` (`packages/ui/src/record/related-model.ts`): upstream before downstream, depth as indent, voided flag, hidden count, truncated line. `related-tab.tsx` draws it; every entry is a `RecordLink` (rule 21), voided ones struck through with «Anulado».
- Masking as the kernel gives it: a hidden node is only a count; a visible node reached through a hidden one has `kind: null` and shows no relation word. In the e2e the CRM owner scope hides the administrator's quote from a seller, so it is counted with the invoice the role cannot consult.
- Copy: `common.record.related.*` (es-419 and en); guide `docs/user-guide/es-419/documentos-relacionados.md`.
- Pitfall found by the e2e: a link's own underline overrides a struck-through parent, so the voided style is applied to the `<a>` too (`[&_a]:line-through`).
