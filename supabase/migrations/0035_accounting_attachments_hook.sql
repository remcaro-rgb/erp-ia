-- 0035_accounting_attachments_hook
-- Forward-only migration (rule 34). Covered by packages/modules/accounting/src/__tests__/entry-files.integration.test.ts.
-- The attachments trigger (0007) calls <module>.attachments_changed for the module that owns the entity and raises when the module has
-- none. A comprobante takes files (its support, accounting design §8, rule 22) but has no readiness to recompute, so the hook is a no-op.

create or replace function accounting.attachments_changed(p_entity text, p_company uuid, p_record_id uuid) returns void
language sql
set search_path = ''
as $$
  select;
$$;
revoke execute on function accounting.attachments_changed(text, uuid, uuid) from public, anon, authenticated;
grant execute on function accounting.attachments_changed(text, uuid, uuid) to service_role;
