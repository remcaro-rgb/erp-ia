-- Plan 2B.2 Task 44 (owner decisions item 36, 2026-11-06, design §22.28): what a unit without a known cost is valued at, per company.
-- `zero` (the default, as always: the line is valued at 0 and flagged in costing.cost_missing) or `last_known` (the unit cost of the
-- product's most recent real cost event, an estimate flagged `cost_source = 'last_known'` and cost_missing). Covered by
-- unknown-cost.integration.test.ts and entities.test.ts. Forward-only.

-- R44-1: a column of the per-company settings row (company RLS, uuid v7, gap-free seq and row audit already apply). A company without a row
-- values at `zero`.
alter table costing.settings add column if not exists unknown_cost_mode text not null default 'zero';
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'settings_unknown_cost_mode_check' and conrelid = 'costing.settings'::regclass) then
    alter table costing.settings add constraint settings_unknown_cost_mode_check check (unknown_cost_mode in ('zero', 'last_known'));
  end if;
end $$;

-- R44-4: an estimate is a cost event whose source is `last_known`.
alter table costing.cost_events drop constraint cost_events_cost_source_check;
alter table costing.cost_events add constraint cost_events_cost_source_check
  check (cost_source in ('line', 'average', 'standard', 'original_issue', 'transfer', 'none', 'landed_cost', 'reversal', 'last_known'));

-- R44-2: only the registered process changes the mode (rule 1): a user session outside it is refused; a session without a user (service) passes.
create or replace function costing.guard_unknown_cost_mode() returns trigger
language plpgsql security invoker set search_path = '' as $$
begin
  if new.unknown_cost_mode is distinct from old.unknown_cost_mode
     and kernel.current_user_id() is not null
     and coalesce(current_setting('erp.audit_process_id', true), '') <> 'costing.unknown_cost.set' then
    raise exception 'unknown_cost_mode changes only through costing.unknown_cost.set' using errcode = 'insufficient_privilege';
  end if;
  return new;
end $$;
drop trigger if exists guard_unknown_cost_mode on costing.settings;
create trigger guard_unknown_cost_mode before update on costing.settings for each row execute function costing.guard_unknown_cost_mode();

-- R44-11: the masked view, regenerated from the entity (a column in the middle cannot be added by create or replace view).
drop view costing.v_settings;
create or replace view costing.v_settings with (security_invoker = true) as
select
  "id",
  "company_id",
  case when (select kernel.field_visible('costing.settings', 'seq')) then "seq" else null end as "seq",
  case when (select kernel.field_visible('costing.settings', 'method')) then "method" else null end as "method",
  case when (select kernel.field_visible('costing.settings', 'unknown_cost_mode')) then "unknown_cost_mode" else null end as "unknown_cost_mode",
  case when (select kernel.field_visible('costing.settings', 'extra')) then kernel.mask_extra('costing.settings', "extra") else null end as "extra",
  case when (select kernel.field_visible('costing.settings', 'extra_free')) then "extra_free" else null end as "extra_free",
  "created_at",
  "updated_at"
from costing.settings;
grant select on costing.v_settings to authenticated;
