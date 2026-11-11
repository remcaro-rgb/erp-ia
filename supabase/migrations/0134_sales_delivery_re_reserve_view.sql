-- Plan 2B.2 Task 43 (continued): the regenerated masked view of the entrega (R43-8). 0133 added the three columns and dropped the old view
-- (a column in the middle of a view cannot be added by create or replace view); this migration creates the view again from the entity, with
-- the same field_visible pattern as 0085, kept in sync with packages/modules/sales/src/entities.ts by entities.test.ts. Forward-only.
-- (Split in two files because 0133 was applied on its own once: an applied migration is never edited, rule 34.)

create or replace view sales.v_deliveries with (security_invoker = true) as
select
  "id",
  "company_id",
  case when (select kernel.field_visible('sales.delivery', 'seq')) then "seq" else null end as "seq",
  case when (select kernel.field_visible('sales.delivery', 'number')) then "number" else null end as "number",
  case when (select kernel.field_visible('sales.delivery', 'order_id')) then "order_id" else null end as "order_id",
  case when (select kernel.field_visible('sales.delivery', 'party_id')) then "party_id" else null end as "party_id",
  case when (select kernel.field_visible('sales.delivery', 'warehouse_id')) then "warehouse_id" else null end as "warehouse_id",
  case when (select kernel.field_visible('sales.delivery', 'date')) then "date" else null end as "date",
  case when (select kernel.field_visible('sales.delivery', 'stage')) then "stage" else null end as "stage",
  case when (select kernel.field_visible('sales.delivery', 'shipped_at')) then "shipped_at" else null end as "shipped_at",
  case when (select kernel.field_visible('sales.delivery', 'stock_refusal')) then "stock_refusal" else null end as "stock_refusal",
  case when (select kernel.field_visible('sales.delivery', 'stock_refused_at')) then "stock_refused_at" else null end as "stock_refused_at",
  case when (select kernel.field_visible('sales.delivery', 're_reserve_requested')) then "re_reserve_requested" else null end as "re_reserve_requested",
  case when (select kernel.field_visible('sales.delivery', 're_reserve_result')) then "re_reserve_result" else null end as "re_reserve_result",
  case when (select kernel.field_visible('sales.delivery', 're_reserve_note')) then "re_reserve_note" else null end as "re_reserve_note",
  case when (select kernel.field_visible('sales.delivery', 'cost_center_id')) then "cost_center_id" else null end as "cost_center_id",
  case when (select kernel.field_visible('sales.delivery', 'notes')) then "notes" else null end as "notes",
  case when (select kernel.field_visible('sales.delivery', 'extra')) then kernel.mask_extra('sales.delivery', "extra") else null end as "extra",
  case when (select kernel.field_visible('sales.delivery', 'extra_free')) then "extra_free" else null end as "extra_free",
  "created_at",
  "updated_at",
  case when (select kernel.field_visible('sales.delivery', 'status')) then "status" else null end as "status",
  case when (select kernel.field_visible('sales.delivery', 'requires_approval')) then "requires_approval" else null end as "requires_approval",
  case when (select kernel.field_visible('sales.delivery', 'posts')) then "posts" else null end as "posts",
  case when (select kernel.field_visible('sales.delivery', 'void_reason')) then "void_reason" else null end as "void_reason"
from sales.deliveries;
grant select on sales.v_deliveries to authenticated;