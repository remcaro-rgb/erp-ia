-- 0174_warehouse_fixes
-- Forward-only migration (rule 34). Covered by packages/modules/warehouse/src/__tests__/review-fixes.integration.test.ts (tests 4 and 4b: a
-- receipt is put away once, the receiving ubicación's other stock is never relocated again, and the tally follows inventory's answer)
-- and putaway.integration.test.ts.
-- Plan 2B.2 Task 29.3 review fix (PG §4.3 step 8, owner item 155): what a confirmed put-away took from each receipt.
--   * warehouse.putaway_moves (sistema, written only by warehouse's processes): one row per confirmed line, the receipt (an inventory
--     movement of kind receipt, by id), the bucket it was taken from (product, ubicación, lot, serial), where it goes and how much, and the
--     run's causal chain. warehouse.putaway.confirm writes it in flight (relocation_id null); inventory's relocation of that confirmation
--     (inventory.relocation.post, run on the same chain by the consumer of warehouse.putaway.confirmed) answers with
--     inventory.movement.posted of kind relocation, and warehouse.putaway.notify, its consumer, sets relocation_id on the chain's rows.
--     Suggest subtracts what was relocated; confirm refuses moving more than the receipt brought minus what was relocated or is in flight
--     («Se ubica más de lo que queda de la entrada en esa ubicación»), whatever else the receiving ubicación holds. A refused relocation
--     posts nothing: its rows stay in flight while the dispatcher retries the event.
-- The receipt, the relocation, the product, the lot, the serial and the ubicaciones are other modules' records, named by id: no foreign key
-- leaves the schema (rule 3). uuid v7, company, seq, extra / extra_free, audit columns, company RLS, row audit, writes only through the
-- module's processes (restrictive policies on erp.audit_process_id). No entity and no masked view: no screen, export or assistant reads it
-- (as warehouse.document_numbers, 0170). No backfill: a put-away confirmed before this migration is not known (a demo seeded before it
-- is put away once more).

create table warehouse.putaway_moves (
  id               uuid primary key default kernel.uuid_v7(),
  seq              bigint not null,
  company_id       uuid not null references kernel.companies (id),
  movement_id      uuid not null,
  product_id       uuid not null,
  lot_id           uuid,
  serial_id        uuid,
  from_location_id uuid,
  to_location_id   uuid not null,
  qty              numeric(18,4) not null check (qty > 0),
  chain_id         uuid not null,
  relocation_id    uuid,
  extra            jsonb not null default '{}'::jsonb,
  extra_free       jsonb not null default '[]'::jsonb,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  created_by       uuid default kernel.current_user_id(),
  updated_by       uuid,
  unique (company_id, seq)
);
create index putaway_moves_movement_idx on warehouse.putaway_moves (company_id, movement_id);
create index putaway_moves_in_flight_idx on warehouse.putaway_moves (company_id, chain_id) where relocation_id is null;

select kernel.enable_company_rls('warehouse', 'putaway_moves');
select kernel.enable_row_audit('warehouse', 'putaway_moves');
create trigger assign_seq before insert on warehouse.putaway_moves for each row execute function core.assign_seq('warehouse.putaway_move');
create trigger touch_row before update on warehouse.putaway_moves for each row execute function core.touch_row();

-- Never deleted: a put-away is corrected by another relocation. The only update is inventory's answer (relocation_id).
grant select, insert, update on warehouse.putaway_moves to authenticated;
grant all on warehouse.putaway_moves to service_role;
create policy via_process_insert on warehouse.putaway_moves as restrictive for insert to authenticated
  with check (coalesce(current_setting('erp.audit_process_id', true), '') like 'warehouse.%');
create policy via_process_update on warehouse.putaway_moves as restrictive for update to authenticated
  using (coalesce(current_setting('erp.audit_process_id', true), '') like 'warehouse.%')
  with check (coalesce(current_setting('erp.audit_process_id', true), '') like 'warehouse.%');
