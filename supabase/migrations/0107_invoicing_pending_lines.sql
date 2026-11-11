-- Plan 2B Task 20 fix round 1 (rule 20): «Por facturar» is the universal grid. The invoicing.pending_line query entity reads this base view,
-- one row per shipped entrega line not yet on an invoice (invoicing.v_pending_to_invoice of 0093, Borradores counted), keyed by the entrega
-- line, and its masked view as maskedViewSql generates it (entities.test.ts guards the drift). No price, discount or currency: the pending
-- view's are unmasked (the invoice prices its lines), so the entity never exposes them. security_invoker: the RLS of the sales and invoicing
-- tables under the view applies as the caller.

create or replace view invoicing.pending_lines with (security_invoker = true) as
select p.delivery_line_id as id, p.company_id, p.order_id, p.order_number, p.delivery_id, p.delivery_number, p.delivery_date, p.party_id,
       p.product_id, p.description, p.delivered_qty, p.invoiced_qty, p.pending_qty
from invoicing.v_pending_to_invoice p;
grant select on invoicing.pending_lines to authenticated;
comment on view invoicing.pending_lines is
  'Por facturar as a grid (Task 20 fix round 1): the pending entrega lines without prices, keyed by the entrega line. security_invoker.';

create or replace view invoicing.v_pending_lines with (security_invoker = true) as
select
  "id",
  "company_id",
  case when (select kernel.field_visible('invoicing.pending_line', 'order_id')) then "order_id" else null end as "order_id",
  case when (select kernel.field_visible('invoicing.pending_line', 'order_number')) then "order_number" else null end as "order_number",
  case when (select kernel.field_visible('invoicing.pending_line', 'delivery_id')) then "delivery_id" else null end as "delivery_id",
  case when (select kernel.field_visible('invoicing.pending_line', 'delivery_number')) then "delivery_number" else null end as "delivery_number",
  case when (select kernel.field_visible('invoicing.pending_line', 'delivery_date')) then "delivery_date" else null end as "delivery_date",
  case when (select kernel.field_visible('invoicing.pending_line', 'party_id')) then "party_id" else null end as "party_id",
  case when (select kernel.field_visible('invoicing.pending_line', 'product_id')) then "product_id" else null end as "product_id",
  case when (select kernel.field_visible('invoicing.pending_line', 'description')) then "description" else null end as "description",
  case when (select kernel.field_visible('invoicing.pending_line', 'delivered_qty')) then "delivered_qty" else null end as "delivered_qty",
  case when (select kernel.field_visible('invoicing.pending_line', 'invoiced_qty')) then "invoiced_qty" else null end as "invoiced_qty",
  case when (select kernel.field_visible('invoicing.pending_line', 'pending_qty')) then "pending_qty" else null end as "pending_qty"
from invoicing.pending_lines;
grant select on invoicing.v_pending_lines to authenticated;
