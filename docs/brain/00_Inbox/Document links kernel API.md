---
tags: [kernel, links, task-31, decision]
date: 2026-11-07
status: in-progress
---

# Document links kernel API (Task 31, stage A)

Part of [[Plan phase-2b-sales-stock-chain]]; owner decision §22.27 in [[Owner Decisions]].

- Migration `0124_kernel_document_links.sql`: table `kernel.document_links` (many-to-many, kind `<a>_to_<b>`, chain of the creating action, voided rows kept and marked), definer writers `document_link_writer` / `document_link_sync` / `document_link_mark_voided`, invoker readers `document_visible` and `document_trail`, baseline grant `kernel.document_link.%`.
- `ctx.links.sync` / `ctx.links.markVoided` (`packages/kernel/src/links/links.ts`): only a create or update process, only into a document its module owns; a Borrador (`status = 'draft'`) loses extra links, a marked row never.
- Consult `kernel.document_link.trail`: up then down, depth ≤ 12 (default 6), cap ≤ 500 (default 100), cycle-safe; hidden documents are walked through, counted in `hidden`, never named (entity, id and the kind of every edge touching them are null).
- The chain id is read in SQL from `erp.audit_chain_id` (set by runProcess), not passed by the caller.
- Later stages: the writers in sales / invoicing / payments, the backfill `0125`, the record tab «Documentos relacionados», i18n and the user guide.
