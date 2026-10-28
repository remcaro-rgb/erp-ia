-- 0012_kernel_user_prefs
-- Forward-only migration (rule 34). Covered by packages/kernel/src/user-prefs/__tests__/user-prefs.integration.test.ts
-- Per-user preferences of the application shell (design §19a): the theme (`auto | light | dark`), the open
-- tabs and, later, the home layout. One JSON value per user, company and key. A user reads and writes only
-- their own rows, in the companies of their claims, and writes only through the process pipeline
-- (`kernel.user_prefs.set`, a permission-free self-service process that is still audited).

create table kernel.user_prefs (
  user_id    uuid not null references kernel.users (id) on delete cascade,
  company_id uuid not null references kernel.companies (id) on delete cascade,
  key        text not null check (key ~ '^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*$' and length(key) <= 64),
  value      jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, company_id, key),
  -- Preferences are small: a theme, a few dozen tabs, a dashboard layout.
  constraint user_prefs_value_size check (octet_length(value::text) <= 65536)
);
create index user_prefs_company_id_idx on kernel.user_prefs (company_id);

grant select, insert, update on kernel.user_prefs to authenticated;
grant all on kernel.user_prefs to service_role;

alter table kernel.user_prefs enable row level security;

-- Own rows only, in a company of the caller's claims: not even the company admin reads another user's prefs.
create policy own_prefs on kernel.user_prefs for all to authenticated
  using (
    user_id = (select kernel.current_user_id())
    and array[company_id] <@ (select kernel.current_company_ids())
  )
  with check (
    user_id = (select kernel.current_user_id())
    and company_id = (select kernel.current_company_id())
    and array[company_id] <@ (select kernel.current_company_ids())
  );

-- Writes only through the process pipeline (rule 1), as for attachments (0007) and verifications (0009).
create policy via_process_insert on kernel.user_prefs as restrictive for insert to authenticated
  with check (coalesce(current_setting('erp.audit_process_id', true), '') = 'kernel.user_prefs.set');
create policy via_process_update on kernel.user_prefs as restrictive for update to authenticated
  using (coalesce(current_setting('erp.audit_process_id', true), '') = 'kernel.user_prefs.set')
  with check (coalesce(current_setting('erp.audit_process_id', true), '') = 'kernel.user_prefs.set');
