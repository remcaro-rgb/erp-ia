-- Plan 2B.2 Task 43 (owner decisions item 34, 2026-11-06, design §22.28): the void of an entrega offers to reserve the stock again for its
-- pedido. sales.delivery.void asks inventory (a flag on sales.delivery.voided); inventory's consumer re-reserves nested in its own void run
-- (inventory.reservation.reserve_again, all or nothing, only when the stock suffices) and answers by event; sales records the outcome on the
-- entrega, read-only («Reserva al anular»). Covered by delivery-void-reserve.integration.test.ts and entities.test.ts. Forward-only.

-- R43-8: whether the user asked, what became of it (reserved | insufficient | not_permitted | none) and the note in words. Company RLS, uuid v7,
-- gap-free seq and row audit already apply; only sales.delivery.void and sales.delivery.record_re_reservation write them (via_process policies).
alter table sales.deliveries add column if not exists re_reserve_requested boolean not null default false;
alter table sales.deliveries add column if not exists re_reserve_result text;
alter table sales.deliveries add column if not exists re_reserve_note text;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'deliveries_re_reserve_result_check' and conrelid = 'sales.deliveries'::regclass) then
    alter table sales.deliveries add constraint deliveries_re_reserve_result_check
      check (re_reserve_result is null or re_reserve_result in ('reserved', 'insufficient', 'not_permitted', 'none'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'deliveries_re_reserve_note_check' and conrelid = 'sales.deliveries'::regclass) then
    alter table sales.deliveries add constraint deliveries_re_reserve_note_check check (re_reserve_note is null or char_length(re_reserve_note) <= 2000);
  end if;
end $$;

-- The masked view, regenerated from the entity (columns in the middle cannot be added by create or replace view): the same field_visible
-- pattern as 0085, kept in sync with packages/modules/sales/src/entities.ts by entities.test.ts.
drop view sales.v_deliveries;
