-- 0040_kernel_typed_entities
-- Forward-only migration (rule 34). Covered by packages/kernel/src/__tests__/typed-tables.integration.test.ts.
-- Entity types (spec 2026-11-02-entity-types-design, §5.4, §7, §8, §9, §10.2): the kernel tables the lifecycle runner, auto-posting,
-- notifications and the typed core/accounting entities build on, and kernel.typed_columns, which gives a maestro or documento table its
-- lifecycle columns. Kernel system tables: no extra / extra_free (they hold no business data).

-- ---------------------------------------------------------------------------------------------
-- Per-company, per-entity switches: does a record of this entity need approval, does it post. Read once, at insert, by the trigger
-- kernel.typed_columns installs (the flag is copied to the row, so a later change never alters existing records).
-- ---------------------------------------------------------------------------------------------
create table kernel.entity_type_settings (
  id                uuid primary key default kernel.uuid_v7(),
  seq               bigint not null,
  company_id        uuid not null references kernel.companies (id),
  entity            text not null check (entity ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'),
  requires_approval boolean not null default false,
  posts             boolean not null default false,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  created_by        uuid default kernel.current_user_id(),
  updated_by        uuid,
  unique (company_id, seq),
  unique (company_id, entity)
);

-- ---------------------------------------------------------------------------------------------
-- Snapshots of a record at a lifecycle step (what was approved, what was rejected). Append-only.
-- ---------------------------------------------------------------------------------------------
create table kernel.record_snapshots (
  id         uuid primary key default kernel.uuid_v7(),
  seq        bigint not null,
  company_id uuid not null references kernel.companies (id),
  entity     text not null check (entity ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'),
  record_id  uuid not null,
  status     text not null check (status in ('draft', 'saved', 'pending', 'rejected', 'approved', 'posted', 'voided')),
  payload    jsonb not null check (jsonb_typeof(payload) = 'object'),
  reason     text,
  chain_id   uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid default kernel.current_user_id(),
  updated_by uuid,
  unique (company_id, seq)
);
create index record_snapshots_record_idx on kernel.record_snapshots (company_id, entity, record_id, seq);

create or replace function kernel.record_snapshots_immutable() returns trigger
language plpgsql
as $$
begin
  raise exception 'record_snapshots_immutable: record_snapshots is append-only' using errcode = 'insufficient_privilege';
end;
$$;
create trigger record_snapshots_immutable before update or delete or truncate on kernel.record_snapshots
  for each statement execute function kernel.record_snapshots_immutable();

-- ---------------------------------------------------------------------------------------------
-- Who is e-mailed when a record of an entity reaches a status.
-- ---------------------------------------------------------------------------------------------
create table kernel.state_recipients (
  id         uuid primary key default kernel.uuid_v7(),
  seq        bigint not null,
  company_id uuid not null references kernel.companies (id),
  entity     text not null check (entity ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'),
  status     text not null check (status in ('draft', 'saved', 'pending', 'rejected', 'approved', 'posted', 'voided')),
  emails     text[] not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid default kernel.current_user_id(),
  updated_by uuid,
  unique (company_id, seq),
  unique (company_id, entity, status)
);

-- ---------------------------------------------------------------------------------------------
-- Mail sent for a record (design §13). Append-only except that the provider outcome (status, provider_id) is filled in later.
-- ---------------------------------------------------------------------------------------------
create table kernel.mail_log (
  id               uuid primary key default kernel.uuid_v7(),
  seq              bigint not null,
  company_id       uuid not null references kernel.companies (id),
  entity           text not null check (entity ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'),
  record_id        uuid not null,
  recipients       text[] not null default '{}',
  template_id      uuid,
  template_version int,
  status           text not null default 'queued' check (status in ('queued', 'sent', 'failed')),
  provider_id      text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  created_by       uuid default kernel.current_user_id(),
  updated_by       uuid,
  unique (company_id, seq)
);
create index mail_log_record_idx on kernel.mail_log (company_id, entity, record_id);

create or replace function kernel.mail_log_guard() returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'mail_log_immutable: mail_log is append-only' using errcode = 'insufficient_privilege';
  end if;
  -- Only the provider outcome changes (updated_at / updated_by are kept by touch_row).
  if (to_jsonb(new) - 'status' - 'provider_id' - 'updated_at' - 'updated_by')
     is distinct from (to_jsonb(old) - 'status' - 'provider_id' - 'updated_at' - 'updated_by') then
    raise exception 'mail_log_immutable: only status and provider_id may change' using errcode = 'insufficient_privilege';
  end if;
  return new;
end;
$$;
create trigger mail_log_guard before update or delete on kernel.mail_log
  for each row execute function kernel.mail_log_guard();
create or replace function kernel.mail_log_no_truncate() returns trigger
language plpgsql
as $$
begin
  raise exception 'mail_log_immutable: mail_log is append-only' using errcode = 'insufficient_privilege';
end;
$$;
create trigger mail_log_no_truncate before truncate on kernel.mail_log
  for each statement execute function kernel.mail_log_no_truncate();

-- seq (gap-free per company and entity, rule 7) and updated_at / updated_by.
create trigger assign_seq before insert on kernel.entity_type_settings for each row execute function core.assign_seq('kernel.entity_type_setting');
create trigger assign_seq before insert on kernel.record_snapshots     for each row execute function core.assign_seq('kernel.record_snapshot');
create trigger assign_seq before insert on kernel.state_recipients     for each row execute function core.assign_seq('kernel.state_recipient');
create trigger assign_seq before insert on kernel.mail_log             for each row execute function core.assign_seq('kernel.mail_log');
create trigger touch_row before update on kernel.entity_type_settings for each row execute function core.touch_row();
create trigger touch_row before update on kernel.state_recipients     for each row execute function core.touch_row();
create trigger touch_row before update on kernel.mail_log             for each row execute function core.touch_row();

-- Grants: members read their company's rows; the settings and the recipients are configuration (company admins write them, a
-- restrictive policy on top of company_isolation); snapshots and mail rows are inserted by the lifecycle runner and notifications.
grant select, insert, update, delete on kernel.entity_type_settings, kernel.state_recipients to authenticated;
grant select, insert on kernel.record_snapshots to authenticated;
grant select, insert, update on kernel.mail_log to authenticated;
grant all on kernel.entity_type_settings, kernel.record_snapshots, kernel.state_recipients, kernel.mail_log to service_role;

select kernel.enable_company_rls('kernel', 'entity_type_settings');
select kernel.enable_company_rls('kernel', 'record_snapshots');
select kernel.enable_company_rls('kernel', 'state_recipients');
select kernel.enable_company_rls('kernel', 'mail_log');
select kernel.enable_row_audit('kernel', 'entity_type_settings');
select kernel.enable_row_audit('kernel', 'record_snapshots');
select kernel.enable_row_audit('kernel', 'state_recipients');
select kernel.enable_row_audit('kernel', 'mail_log');

-- Authorship cannot be forged (pattern of audit_log actor_is_caller, 0002).
create policy author_is_caller on kernel.record_snapshots as restrictive for insert to authenticated
  with check (created_by is not distinct from (select kernel.current_user_id()));
create policy author_is_caller on kernel.mail_log as restrictive for insert to authenticated
  with check (created_by is not distinct from (select kernel.current_user_id()));

create policy admin_writes on kernel.entity_type_settings as restrictive for insert to authenticated with check ((select kernel.is_company_admin()));
create policy admin_updates on kernel.entity_type_settings as restrictive for update to authenticated using ((select kernel.is_company_admin())) with check ((select kernel.is_company_admin()));
create policy admin_deletes on kernel.entity_type_settings as restrictive for delete to authenticated using ((select kernel.is_company_admin()));
create policy admin_writes on kernel.state_recipients as restrictive for insert to authenticated with check ((select kernel.is_company_admin()));
create policy admin_updates on kernel.state_recipients as restrictive for update to authenticated using ((select kernel.is_company_admin())) with check ((select kernel.is_company_admin()));
create policy admin_deletes on kernel.state_recipients as restrictive for delete to authenticated using ((select kernel.is_company_admin()));

-- ---------------------------------------------------------------------------------------------
-- Reference registry: which columns point at the records of an entity (so a lifecycle step can tell whether a record is in use).
-- Schema metadata, not company data: global rows, no company_id, so (rule 12) RLS lets every authenticated user read and nobody
-- write; rows are registered by migrations through kernel.register_reference.
-- ---------------------------------------------------------------------------------------------
create table kernel."references" (
  id         uuid primary key default kernel.uuid_v7(),
  entity     text not null check (entity ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'),
  ref_schema text not null,
  ref_table  text not null,
  ref_column text not null,
  created_at timestamptz not null default now(),
  unique (entity, ref_schema, ref_table, ref_column)
);
alter table kernel."references" enable row level security;
create policy read_all on kernel."references" for select to authenticated using (true);
grant select on kernel."references" to authenticated;
grant all on kernel."references" to service_role;

create or replace function kernel.register_reference(p_entity text, p_schema text, p_table text, p_column text) returns void
language sql security definer
set search_path = ''
as $$
  insert into kernel."references" (entity, ref_schema, ref_table, ref_column)
  values (p_entity, p_schema, p_table, p_column)
  on conflict (entity, ref_schema, ref_table, ref_column) do nothing;
$$;
revoke execute on function kernel.register_reference(text, text, text, text) from public, anon, authenticated;
grant execute on function kernel.register_reference(text, text, text, text) to service_role;

-- ---------------------------------------------------------------------------------------------
-- kernel.typed_columns(p_schema, p_table, p_type, p_entity): gives a table the lifecycle columns of its entity type.
--   p_type 'maestro'   : status, requires_approval, is_active, void_reason, deleted_at; status excludes posted / voided.
--   p_type 'documento' : status, requires_approval, posts, void_reason; all seven states.
-- A before-insert trigger fills requires_approval (and posts) when the insert leaves them NULL, from kernel.entity_type_settings of the
-- row's company and p_entity, else false. An explicit value wins. The flag lives on the row afterwards: changing the setting never
-- alters existing records. The table must have company_id. Idempotent.
-- ---------------------------------------------------------------------------------------------
create or replace function kernel.typed_copy_flags() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_requires boolean;
  v_posts    boolean;
begin
  select s.requires_approval, s.posts into v_requires, v_posts
  from kernel.entity_type_settings s
  where s.company_id = new.company_id and s.entity = tg_argv[0];
  new.requires_approval := coalesce(new.requires_approval, v_requires, false);
  if tg_argv[1] = 'documento' then
    new.posts := coalesce(new.posts, v_posts, false);
  end if;
  return new;
end;
$$;
revoke execute on function kernel.typed_copy_flags() from public, anon, authenticated;

create or replace function kernel.typed_columns(p_schema text, p_table text, p_type text, p_entity text) returns void
language plpgsql
set search_path = ''
as $$
declare
  v_states text;
begin
  if p_type not in ('maestro', 'documento') then
    raise exception 'typed_columns: type must be maestro or documento, got %', p_type using errcode = '22023';
  end if;
  v_states := case p_type
    when 'maestro' then $s$'draft', 'saved', 'pending', 'rejected', 'approved'$s$
    else $s$'draft', 'saved', 'pending', 'rejected', 'approved', 'posted', 'voided'$s$ end;

  execute format('alter table %I.%I add column if not exists status text not null default ''draft''', p_schema, p_table);
  -- Added with a default so a table that already has rows can take it, then the default is dropped: the trigger must see NULL.
  execute format('alter table %I.%I add column if not exists requires_approval boolean not null default false', p_schema, p_table);
  execute format('alter table %I.%I alter column requires_approval drop default', p_schema, p_table);
  execute format('alter table %I.%I add column if not exists void_reason text', p_schema, p_table);
  if p_type = 'documento' then
    execute format('alter table %I.%I add column if not exists posts boolean not null default false', p_schema, p_table);
    execute format('alter table %I.%I alter column posts drop default', p_schema, p_table);
  else
    execute format('alter table %I.%I add column if not exists is_active boolean not null default true', p_schema, p_table);
    execute format('alter table %I.%I add column if not exists deleted_at timestamptz', p_schema, p_table);
  end if;

  execute format('alter table %I.%I drop constraint if exists %I', p_schema, p_table, p_table || '_status_check');
  execute format('alter table %I.%I add constraint %I check (status in (%s))', p_schema, p_table, p_table || '_status_check', v_states);

  execute format('drop trigger if exists typed_copy_flags on %I.%I', p_schema, p_table);
  execute format('create trigger typed_copy_flags before insert on %I.%I for each row execute function kernel.typed_copy_flags(%L, %L)',
                 p_schema, p_table, p_entity, p_type);
end;
$$;
revoke execute on function kernel.typed_columns(text, text, text, text) from public, anon, authenticated;
grant execute on function kernel.typed_columns(text, text, text, text) to service_role;
