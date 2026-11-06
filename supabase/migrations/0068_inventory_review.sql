-- Inventory review fixes (plan 2B Task 6, review round 1).
--
-- 1. A source line (an order line, Task 13) can be reserved again once its reservation is released (an order cancelled and confirmed
--    again): one ACTIVE reservation per source line, any number of released ones. The released rows stay as the history.
-- 2. Documented exceptions and notes for the modules that read the stock.

alter table inventory.reservations drop constraint reservations_company_id_source_entity_source_line_id_key;
create unique index reservations_active_source_key on inventory.reservations (company_id, source_entity, source_line_id) where status = 'active';
create index reservations_source_idx on inventory.reservations (company_id, source_entity, source_line_id);

comment on table inventory.movement_numbers is
  'System counter (an exception to rule 7, like core.entity_sequences): one gap-free movement number counter per company and prefix, '
  'written only by inventory.next_movement_number in the movement''s transaction. It carries no id / seq / audit columns: it is not a record.';

comment on view inventory.v_stock is
  'Published stock per product, bodega and ubicación (rule 3): on_hand, reserved, available. Reservations sit at the bodega level '
  '(location_id null) until picking (2B.2), so the availability of a bodega is the SUM over all its rows (Task 13 reads it that way, '
  'never one ubicación row). on_hand here is not masked: a screen (Task 10) reads the masked inventory.v_stock_levels for what a role sees.';
