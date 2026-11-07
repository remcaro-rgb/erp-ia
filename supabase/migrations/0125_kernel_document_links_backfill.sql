-- 0125_kernel_document_links_backfill
-- Forward-only migration (rule 34). Covered by packages/modules/invoicing/src/__tests__/document-links-backfill.integration.test.ts.
-- Backfill of kernel.document_links for the documents created before 0124 (owner 2026-11-06, design §22.27, plan 2B Task 31, R31-9).
-- This migration reads the module tables sales.orders, sales.deliveries, invoicing.invoice_lines, invoicing.invoices, payments.receipt_allocations,
-- payments.receipts and crm.quotes ONCE, as a DDL-time data repair run by the migration role: it is not runtime access of a module to another
-- module's schema, so rule 3 is not broken (the runtime writers are the processes of each module through ctx.links, 0124).
--   * One row per distinct pair, the same set the writers would sync from the stored data:
--       sales.orders.quote_id                                                    -> quote_to_order       (crm.quote -> sales.order)
--       sales.deliveries.order_id                                                -> order_to_delivery    (sales.order -> sales.delivery)
--       invoice_lines (delivery_id, invoice_id), delivery_id not null            -> delivery_to_invoice  (sales.delivery -> invoicing.invoice)
--       invoice_lines (order_id, invoice_id), delivery_id null, order_id not null-> order_to_invoice     (sales.order -> invoicing.invoice)
--       receipt_allocations (invoice_id, receipt_id)                             -> invoice_to_receipt   (invoicing.invoice -> payments.receipt)
--   * origin 'backfill', chain_id null (the chain of the original action is not recoverable; 0124's check allows a null chain only for
--     backfill), created_at of the downstream document.
--   * A link whose either end is voided or cancelled is marked: voided_at set, voided_chain_id null (allowed for backfill), reason stated,
--     and voided_ends lists WHICH end(s) are voided ('entity:id'), as the writers' markVoided records the document it voids: the trail
--     flags only that document, never its live neighbour. Voided means what the writers mark: order stage cancelled or status voided;
--     delivery status voided; invoice stage or status voided (the DIAN annulment verdict); receipt status voided; quote status voided.
--   * Idempotent and gap-free: a pair that already has its row (made by a writer between 0124 and 0125, or by a previous run) is filtered out
--     by `where not exists` BEFORE the insert, because the table's BEFORE INSERT trigger assigns seq before `on conflict` looks, so a
--     conflicting row would burn a seq. `on conflict do nothing` stays only as the guard against a concurrent writer.
insert into kernel.document_links
  (company_id, from_entity, from_id, to_entity, to_id, kind, origin, chain_id, voided_at, void_reason, voided_ends, created_at, updated_at)
select s.company_id, s.from_entity, s.from_id, s.to_entity, s.to_id, s.kind, 'backfill', null,
       case when s.from_voided or s.to_voided then now() end,
       case when s.from_voided or s.to_voided then 'Documento anulado antes de registrar el vínculo' end,
       array_remove(array[case when s.from_voided then s.from_entity || ':' || s.from_id end, case when s.to_voided then s.to_entity || ':' || s.to_id end], null),
       s.created_at, s.created_at
from (
  select o.company_id, 'crm.quote' as from_entity, o.quote_id as from_id, 'sales.order' as to_entity, o.id as to_id, 'quote_to_order' as kind,
         o.created_at, (q.status = 'voided') as from_voided, (o.stage = 'cancelled' or o.status = 'voided') as to_voided
  from sales.orders o
  join crm.quotes q on q.id = o.quote_id and q.company_id = o.company_id
  where o.quote_id is not null
  union all
  select d.company_id, 'sales.order', d.order_id, 'sales.delivery', d.id, 'order_to_delivery',
         d.created_at, (o.stage = 'cancelled' or o.status = 'voided'), (d.status = 'voided')
  from sales.deliveries d
  join sales.orders o on o.id = d.order_id and o.company_id = d.company_id
  union all
  select i.company_id, 'sales.delivery', l.delivery_id, 'invoicing.invoice', l.invoice_id, 'delivery_to_invoice',
         i.created_at, (d.status = 'voided'), (i.stage = 'voided' or i.status = 'voided')
  from (select distinct company_id, delivery_id, invoice_id from invoicing.invoice_lines where delivery_id is not null) l
  join invoicing.invoices i on i.id = l.invoice_id and i.company_id = l.company_id
  join sales.deliveries d on d.id = l.delivery_id and d.company_id = l.company_id
  union all
  select i.company_id, 'sales.order', l.order_id, 'invoicing.invoice', l.invoice_id, 'order_to_invoice',
         i.created_at, (o.stage = 'cancelled' or o.status = 'voided'), (i.stage = 'voided' or i.status = 'voided')
  from (select distinct company_id, order_id, invoice_id from invoicing.invoice_lines where delivery_id is null and order_id is not null) l
  join invoicing.invoices i on i.id = l.invoice_id and i.company_id = l.company_id
  join sales.orders o on o.id = l.order_id and o.company_id = l.company_id
  union all
  select r.company_id, 'invoicing.invoice', a.invoice_id, 'payments.receipt', a.receipt_id, 'invoice_to_receipt',
         r.created_at, (i.stage = 'voided' or i.status = 'voided'), (r.status = 'voided')
  from (select distinct company_id, invoice_id, receipt_id from payments.receipt_allocations) a
  join payments.receipts r on r.id = a.receipt_id and r.company_id = a.company_id
  join invoicing.invoices i on i.id = a.invoice_id and i.company_id = a.company_id
) s
where not exists (
  select 1 from kernel.document_links x
  where x.company_id = s.company_id and x.from_entity = s.from_entity and x.from_id = s.from_id
    and x.to_entity = s.to_entity and x.to_id = s.to_id and x.kind = s.kind)
order by s.created_at, s.to_id, s.from_id
on conflict (company_id, from_entity, from_id, to_entity, to_id, kind) do nothing;
