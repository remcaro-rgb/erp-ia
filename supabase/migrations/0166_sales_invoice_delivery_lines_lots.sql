-- 0166_sales_invoice_delivery_lines_lots
-- Forward-only migration (rule 34). Covered by packages/modules/invoicing/src/__tests__/invoice-lots.integration.test.ts (the published lots
-- of a FEFO-split entrega line, copied onto the invoice line).
-- Plan 2B.2 Task 28.4 (PG §3.5, RG-5, owner item 150): sales.v_invoice_delivery_lines, what sales publishes to invoicing of each entrega line
-- (0093, rule 3), gains `lots jsonb`: what inventory issued of each lot or serial for that line, as sales.delivery.record_lots wrote it in
-- sales.delivery_line_lots (0165), one element `{ lotCode, expiresOn, serialNo, qty }` per lot or serial in the order it left; null for a
-- line that issued no lot or serial (an untracked product: byte for byte as before, RG-2). Invoicing copies it into invoice_lines.lots when
-- a line is written from the entrega line (0167). The column is appended, so the view is replaced in place and invoicing.v_pending_to_invoice
-- (which reads it) is untouched. Unmasked and security_invoker, as the rest of the view.

create or replace view sales.v_invoice_delivery_lines with (security_invoker = true) as
select l.id, l.company_id, l.delivery_id, d.number as delivery_number, d.status as delivery_status, d.stage as delivery_stage,
       d.date as delivery_date, d.cost_center_id, d.order_id, d.party_id, l.line_no, l.order_line_id, l.product_id, l.description, l.qty,
       (select jsonb_agg(jsonb_build_object('lotCode', x.lot_code, 'expiresOn', x.expires_on, 'serialNo', x.serial_no, 'qty', trim_scale(x.qty)) order by x.seq)
          from sales.delivery_line_lots x where x.delivery_line_id = l.id) as lots
from sales.delivery_lines l join sales.deliveries d on d.id = l.delivery_id;
grant select on sales.v_invoice_delivery_lines to authenticated;
comment on view sales.v_invoice_delivery_lines is
  'Published for invoicing (rule 3): the entrega lines an invoice bills (what shipped) and, per line, the lots and serials it issued (lots, Task 28.4). Unmasked, security_invoker.';
