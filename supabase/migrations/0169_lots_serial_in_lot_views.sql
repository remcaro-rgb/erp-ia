-- 0169_lots_serial_in_lot_views
-- Forward-only migration (rule 34). Covered by packages/modules/invoicing/src/__tests__/invoice-lots.integration.test.ts (lots_pending: an
-- «Emitir» before the entrega's lots are recorded is refused, the on_delivery invoice waits for them; the «lot · serial» text of
-- invoicing.v_invoice_lines), packages/modules/sales/src/__tests__/delivery-lots.integration.test.ts (a devolución refused lots_pending; the
-- «lot · serial» text of sales.v_delivery_lines) and both modules' entities.test.ts (the masked views equal the generated ones).
-- Plan 2B.2 Tasks 28.3 / 28.4 review (PG §3.3, §3.5; RG-5):
--   * inventory.v_product_tracking_facts and inventory.v_tracked_source_lines (published, UNMASKED, security_invoker; the pattern of
--     core.v_product_stock, 0067): what other modules compute with, never display. inventory.v_product_tracking masks `tracking` and
--     v_movement_lines masks `lot_id`/`serial_id` per caller (rule 14 masks display, not computation), so a role with them hidden would
--     have read «not tracked» and issued an invoice without its lots (review wave 2). Company RLS of the tables applies.
--   * sales.v_invoice_delivery_lines (published for invoicing, rule 3) gains, appended, `lots_pending` and `lots_failed` (boolean). A line
--     WAITS for its lots when its product is lot- or serial-tracked AND keeps stock (core.v_product_stock.track_stock: the movement skips a
--     product that keeps none, so no lot ever comes), its entrega is shipped and not voided (an issue inventory refused puts it back to open,
--     sales.delivery.reopen), sales has recorded no lot or serial for it (sales.delivery_line_lots, written two events after the ship) and
--     the issue is either not posted yet or was posted by lot or serial (a line issued while the product was untracked is never waiting).
--     A waiting line is `lots_failed` when the event that would bring its lots dead-lettered (kernel.outbox_dead_letter: the entrega's
--     sales.delivery.shipped not delivered to inventory, or its inventory.sale_issue.allocated not delivered to sales): it will not clear by
--     itself, so it is refused lots_not_recorded with what to do; otherwise it is `lots_pending` (retryable, it clears in seconds). Invoicing
--     refuses «Emitir» and sales refuses a devolución on either.
--   * The «Lote / Vence / Serie» text of sales.v_delivery_lines and invoicing.v_invoice_lines: a serial that sits in a lot reads
--     `code · number · expiry · qty` (concat_ws), never one of them only; a lot or a serial alone reads as before, byte for byte.

create or replace view inventory.v_product_tracking_facts with (security_invoker = true) as
select company_id, product_id, tracking from inventory.product_tracking;
grant select on inventory.v_product_tracking_facts to authenticated;
comment on view inventory.v_product_tracking_facts is
  'Published (rule 3), UNMASKED for computation (never displayed): the tracking of each product (none, lot, serial). security_invoker, company RLS.';

create or replace view inventory.v_tracked_source_lines with (security_invoker = true) as
select distinct company_id, source_entity, source_line_id from inventory.movement_lines
where source_line_id is not null and (lot_id is not null or serial_id is not null);
grant select on inventory.v_tracked_source_lines to authenticated;
comment on view inventory.v_tracked_source_lines is
  'Published (rule 3), UNMASKED for computation (never displayed): the source lines (entity, line) a movement moved by lot or serial. security_invoker, company RLS.';

create or replace view sales.v_invoice_delivery_lines with (security_invoker = true) as
select l.id, l.company_id, l.delivery_id, d.number as delivery_number, d.status as delivery_status, d.stage as delivery_stage,
       d.date as delivery_date, d.cost_center_id, d.order_id, d.party_id, l.line_no, l.order_line_id, l.product_id, l.description, l.qty,
       (select jsonb_agg(jsonb_build_object('lotCode', x.lot_code, 'expiresOn', x.expires_on, 'serialNo', x.serial_no, 'qty', trim_scale(x.qty)) order by x.seq)
          from sales.delivery_line_lots x where x.delivery_line_id = l.id) as lots,
       (w.waiting and not f.failed) as lots_pending,
       (w.waiting and f.failed) as lots_failed
from sales.delivery_lines l join sales.deliveries d on d.id = l.delivery_id
cross join lateral (select (
  d.stage = 'shipped' and d.status <> 'voided'
  and exists (select 1 from inventory.v_product_tracking_facts t where t.product_id = l.product_id and t.tracking in ('lot', 'serial'))
  and exists (select 1 from core.v_product_stock p where p.id = l.product_id and p.track_stock)
  and not exists (select 1 from sales.delivery_line_lots x where x.delivery_line_id = l.id)
  and (l.stock_posted_at is null
       or exists (select 1 from inventory.v_tracked_source_lines s where s.source_entity = 'sales.delivery' and s.source_line_id = l.id))
) as waiting) w
cross join lateral (select exists (
  select 1 from kernel.outbox_dead_letter x
  where x.company_id = l.company_id and x.payload->>'deliveryId' = l.delivery_id::text
    and ((x.event = 'sales.delivery.shipped' and not ('inventory' = any(coalesce(x.delivered_modules, '{}'))))
      or (x.event = 'inventory.sale_issue.allocated' and not ('sales' = any(coalesce(x.delivered_modules, '{}')))))
) as failed) f;
grant select on sales.v_invoice_delivery_lines to authenticated;
comment on view sales.v_invoice_delivery_lines is
  'Published for invoicing (rule 3): the entrega lines an invoice bills (what shipped), per line the lots and serials it issued (lots, Task 28.4) and whether they are still being recorded (lots_pending) or will not come by themselves (lots_failed, 0169). Unmasked, security_invoker.';

-- ---------------------------------------------------------------------------------------------
-- Masked read views (rule 14), generated by maskedViewSql from packages/modules/sales/src/entities.ts and
-- packages/modules/invoicing/src/entities.ts and pasted here; entities.test.ts fails when they drift.
-- ---------------------------------------------------------------------------------------------

create or replace view sales.v_delivery_lines with (security_invoker = true) as
select
  "id",
  "company_id",
  case when (select kernel.field_visible('sales.delivery_line', 'seq')) then "seq" else null end as "seq",
  case when (select kernel.field_visible('sales.delivery_line', 'delivery_id')) then "delivery_id" else null end as "delivery_id",
  case when (select kernel.field_visible('sales.delivery_line', 'line_no')) then "line_no" else null end as "line_no",
  case when (select kernel.field_visible('sales.delivery_line', 'order_line_id')) then "order_line_id" else null end as "order_line_id",
  case when (select kernel.field_visible('sales.delivery_line', 'product_id')) then "product_id" else null end as "product_id",
  case when (select kernel.field_visible('sales.delivery_line', 'description')) then "description" else null end as "description",
  case when (select kernel.field_visible('sales.delivery_line', 'qty')) then "qty" else null end as "qty",
  case when (select kernel.field_visible('sales.delivery_line', 'invoiced_qty')) then "invoiced_qty" else null end as "invoiced_qty",
  case when (select kernel.field_visible('sales.delivery_line', 'movement_id')) then "movement_id" else null end as "movement_id",
  case when (select kernel.field_visible('sales.delivery_line', 'stock_posted_at')) then "stock_posted_at" else null end as "stock_posted_at",
  case when (select kernel.field_visible('sales.delivery_line', 'extra')) then kernel.mask_extra('sales.delivery_line', "extra") else null end as "extra",
  case when (select kernel.field_visible('sales.delivery_line', 'extra_free')) then "extra_free" else null end as "extra_free",
  "created_at",
  "updated_at",
  case when (select kernel.field_visible('sales.delivery_line', 'lot_id')) then "lot_id" else null end as "lot_id",
  case when (select kernel.field_visible('sales.delivery_line', 'serial_ids')) then "serial_ids" else null end as "serial_ids",
  case when (select kernel.field_visible('sales.delivery_line', 'lots')) then (select string_agg(concat_ws(' · ', x.lot_code, x.serial_no, x.expires_on::text, trim_scale(x.qty)::text), '; ' order by x.seq) from sales.delivery_line_lots x where x.delivery_line_id = delivery_lines.id) else null end as "lots"
from sales.delivery_lines;
grant select on sales.v_delivery_lines to authenticated;
create or replace view invoicing.v_invoice_lines with (security_invoker = true) as
select
  "id",
  "company_id",
  case when (select kernel.field_visible('invoicing.invoice_line', 'seq')) then "seq" else null end as "seq",
  case when (select kernel.field_visible('invoicing.invoice_line', 'invoice_id')) then "invoice_id" else null end as "invoice_id",
  case when (select kernel.field_visible('invoicing.invoice_line', 'line_no')) then "line_no" else null end as "line_no",
  case when (select kernel.field_visible('invoicing.invoice_line', 'product_id')) then "product_id" else null end as "product_id",
  case when (select kernel.field_visible('invoicing.invoice_line', 'description')) then "description" else null end as "description",
  case when (select kernel.field_visible('invoicing.invoice_line', 'qty')) then "qty" else null end as "qty",
  case when (select kernel.field_visible('invoicing.invoice_line', 'unit_price')) then "unit_price" else null end as "unit_price",
  case when (select kernel.field_visible('invoicing.invoice_line', 'discount_pct')) then "discount_pct" else null end as "discount_pct",
  case when (select kernel.field_visible('invoicing.invoice_line', 'discount')) then "discount" else null end as "discount",
  case when (select kernel.field_visible('invoicing.invoice_line', 'base')) then "base" else null end as "base",
  case when (select kernel.field_visible('invoicing.invoice_line', 'iva_rate')) then "iva_rate" else null end as "iva_rate",
  case when (select kernel.field_visible('invoicing.invoice_line', 'iva')) then "iva" else null end as "iva",
  case when (select kernel.field_visible('invoicing.invoice_line', 'inc_rate')) then "inc_rate" else null end as "inc_rate",
  case when (select kernel.field_visible('invoicing.invoice_line', 'inc')) then "inc" else null end as "inc",
  case when (select kernel.field_visible('invoicing.invoice_line', 'other_taxes')) then "other_taxes" else null end as "other_taxes",
  case when (select kernel.field_visible('invoicing.invoice_line', 'total')) then "total" else null end as "total",
  case when (select kernel.field_visible('invoicing.invoice_line', 'subtotal_company')) then case when (select kernel.field_visible('invoicing.invoice_line', 'base')) then "subtotal_company" else null end else null end as "subtotal_company",
  case when (select kernel.field_visible('invoicing.invoice_line', 'free_sample')) then "free_sample" else null end as "free_sample",
  case when (select kernel.field_visible('invoicing.invoice_line', 'category_id')) then "category_id" else null end as "category_id",
  case when (select kernel.field_visible('invoicing.invoice_line', 'order_id')) then "order_id" else null end as "order_id",
  case when (select kernel.field_visible('invoicing.invoice_line', 'order_line_id')) then "order_line_id" else null end as "order_line_id",
  case when (select kernel.field_visible('invoicing.invoice_line', 'delivery_id')) then "delivery_id" else null end as "delivery_id",
  case when (select kernel.field_visible('invoicing.invoice_line', 'delivery_line_id')) then "delivery_line_id" else null end as "delivery_line_id",
  case when (select kernel.field_visible('invoicing.invoice_line', 'extra')) then kernel.mask_extra('invoicing.invoice_line', "extra") else null end as "extra",
  case when (select kernel.field_visible('invoicing.invoice_line', 'extra_free')) then "extra_free" else null end as "extra_free",
  "created_at",
  "updated_at",
  case when (select kernel.field_visible('invoicing.invoice_line', 'lots')) then (select string_agg(concat_ws(' · ', x.e->>'lotCode', x.e->>'serialNo', x.e->>'expiresOn', x.e->>'qty'), '; ' order by x.n) from jsonb_array_elements(invoice_lines.lots) with ordinality as x(e, n)) else null end as "lots"
from invoicing.invoice_lines;
grant select on invoicing.v_invoice_lines to authenticated;
