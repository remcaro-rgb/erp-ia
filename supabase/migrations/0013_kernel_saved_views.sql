-- 0013_kernel_saved_views
-- Forward-only migration (rule 34). Covered by packages/kernel/src/saved-views/__tests__/saved-views.integration.test.ts
-- Saved grid views (design §9, rule 20): a user's named grid state (filters with their Y/O joins, sort, page size,
-- columns) per entity, in a company, one of them the user's default for the entity. A user reads and writes only
-- their own views, in the companies of their claims, and writes only through the process pipeline
-- (`kernel.saved_view.save` / `kernel.saved_view.delete`, audited). Promotion of a view to a role is a later step.

create table kernel.saved_views (
  id         uuid primary key default kernel.uuid_v7(),
  company_id uuid not null references kernel.companies (id) on delete cascade,
  user_id    uuid not null references kernel.users (id) on delete cascade,
  entity     text not null check (entity ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'),
  name       text not null check (btrim(name) <> '' and length(name) <= 80),
  state      jsonb not null check (jsonb_typeof(state) = 'object' and octet_length(state::text) <= 65536),
  is_default boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid default kernel.current_user_id(),
  updated_by uuid,
  unique (company_id, user_id, entity, name)
);
-- At most one default view per user, company and entity.
create unique index saved_views_one_default_idx on kernel.saved_views (company_id, user_id, entity) where is_default;
create index saved_views_user_id_idx on kernel.saved_views (user_id);

create trigger saved_views_touch_updated before update on kernel.saved_views
  for each row execute function kernel.touch_updated();

grant select, insert, update, delete on kernel.saved_views to authenticated;
grant all on kernel.saved_views to service_role;

alter table kernel.saved_views enable row level security;

-- Own rows only, in a company of the caller's claims: not even the company admin reads another user's views.
create policy own_views on kernel.saved_views for all to authenticated
  using (
    user_id = (select kernel.current_user_id())
    and array[company_id] <@ (select kernel.current_company_ids())
  )
  with check (
    user_id = (select kernel.current_user_id())
    and company_id = (select kernel.current_company_id())
    and array[company_id] <@ (select kernel.current_company_ids())
  );

-- Writes only through the process pipeline (rule 1), as for user preferences (0012).
create policy via_process_insert on kernel.saved_views as restrictive for insert to authenticated
  with check (coalesce(current_setting('erp.audit_process_id', true), '') = 'kernel.saved_view.save');
create policy via_process_update on kernel.saved_views as restrictive for update to authenticated
  using (coalesce(current_setting('erp.audit_process_id', true), '') = 'kernel.saved_view.save')
  with check (coalesce(current_setting('erp.audit_process_id', true), '') = 'kernel.saved_view.save');
create policy via_process_delete on kernel.saved_views as restrictive for delete to authenticated
  using (coalesce(current_setting('erp.audit_process_id', true), '') = 'kernel.saved_view.delete');
