-- 0045_core_record_access
-- Record-level access (entity types spec 2026-11-02 §9.1, D11; Phase 2A.5 Task 9): the line tables of the core maestros inherit their
-- parent's read right. kernel.typed_lines (0044) records each one and gives it the restrictive policy `record_access_read`, so a
-- tercero or a lista de precios narrowed out of a user hides its contactos or its precios with it (in every view that reads them).
-- The maestros' own tables got the policy in 0044 (they were made typed in 0042).

select kernel.typed_lines('core', 'party_contacts',   'core.party',      'party_id');
select kernel.typed_lines('core', 'price_list_items', 'core.price_list', 'price_list_id');
