-- 0090_kernel_outbox_source_indexes
-- Forward-only migration (rule 34). Covered by packages/modules/sales/src/__tests__/delivery.integration.test.ts (the lookups below run on
-- every despacho refusal, void and restore).
-- Plan 2B Task 14, review round 2: the processes of the remisiones and devoluciones look up the outbox events of one document by its id in
-- the payload (sales.delivery.reopen: the latest despacho; sales.return.restore: the latest Anular; inventory.sale.void_issue: the despachos
-- and refusals of a remisión). Partial expression indexes keep those lookups off a scan of the company's whole outbox.

create index outbox_delivery_id_idx on kernel.outbox (company_id, event, (payload ->> 'deliveryId')) where payload ? 'deliveryId';
create index outbox_return_id_idx on kernel.outbox (company_id, event, (payload ->> 'returnId')) where payload ? 'returnId';
