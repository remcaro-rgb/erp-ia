-- 0008_kernel_custom_fields
-- Forward-only migration (rule 34). Covered by packages/modules/core/src/__tests__/custom-fields.integration.test.ts
-- (the entities that hold the data, and the readiness they feed, are core's, so the suite lives there).
-- Extra data on any entity (design §5.14, "Datos adicionales"): the typed fields the company admin
-- defines for an entity. The values live in each entity's own `extra jsonb` column (rule 7), so this
-- migration adds no column to any business table. Roles are `kernel.roles` ids.

create table kernel.custom_fields (
  id          uuid primary key default kernel.uuid_v7(),
  company_id  uuid not null references kernel.companies (id),
  entity      text not null check (entity ~ '^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$'),
  -- The key of the value inside extra: stable, machine friendly.
  key         text not null check (key ~ '^[a-z][a-z0-9_]{0,39}$'),
  label       text not null check (btrim(label) <> ''),
  type        text not null check (type in ('text', 'number', 'date', 'bool', 'list', 'url', 'email')),
  max_length  integer check (max_length is null or max_length between 1 and 1000),
  required    boolean not null default false,
  options     text[],
  roles_enter uuid[] not null default '{}',
  roles_edit  uuid[] not null default '{}',
  roles_view  uuid[] not null default '{}',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  created_by  uuid default kernel.current_user_id(),
  updated_by  uuid,
  unique (company_id, entity, key),
  -- A list needs its values; no other type carries any.
  check ((type = 'list' and options is not null and cardinality(options) > 0) or (type <> 'list' and options is null))
);
create trigger custom_fields_touch_updated before update on kernel.custom_fields
  for each row execute function kernel.touch_updated();

grant select, insert, update, delete on kernel.custom_fields to authenticated;
grant all on kernel.custom_fields to service_role;

-- Everybody in the active company reads the definitions (the forms need them); only its admin writes
-- them, and only through kernel.custom_field.set / remove: runProcess sets erp.audit_process_id for
-- the transaction (rule 1). The service role bypasses RLS and is not affected.
select kernel.enable_company_rls('kernel', 'custom_fields');
create policy admin_insert on kernel.custom_fields as restrictive for insert to authenticated
  with check ((select kernel.is_company_admin()));
create policy admin_update on kernel.custom_fields as restrictive for update to authenticated
  using ((select kernel.is_company_admin())) with check ((select kernel.is_company_admin()));
create policy admin_delete on kernel.custom_fields as restrictive for delete to authenticated
  using ((select kernel.is_company_admin()));
create policy via_process_insert on kernel.custom_fields as restrictive for insert to authenticated
  with check (coalesce(current_setting('erp.audit_process_id', true), '') like 'kernel.custom_field.%');
create policy via_process_update on kernel.custom_fields as restrictive for update to authenticated
  using (coalesce(current_setting('erp.audit_process_id', true), '') like 'kernel.custom_field.%')
  with check (coalesce(current_setting('erp.audit_process_id', true), '') like 'kernel.custom_field.%');
create policy via_process_delete on kernel.custom_fields as restrictive for delete to authenticated
  using (coalesce(current_setting('erp.audit_process_id', true), '') like 'kernel.custom_field.%');
select kernel.enable_row_audit('kernel', 'custom_fields');

-- The roles a field names must be roles of its own company: a definition can never hand a value to
-- another company's role ids. Security definer so the check does not depend on the writer's grants.
create or replace function kernel.custom_field_guard() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  if exists (
    select 1
    from unnest(new.roles_enter || new.roles_edit || new.roles_view) as r (id)
    where not exists (select 1 from kernel.roles k where k.id = r.id and k.company_id = new.company_id)
  ) then
    raise exception 'custom field %.% names a role that is not a role of its company', new.entity, new.key
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
revoke execute on function kernel.custom_field_guard() from public, anon, authenticated;
create trigger custom_field_guard before insert or update on kernel.custom_fields
  for each row execute function kernel.custom_field_guard();

-- ---------------------------------------------------------------------------------------------
-- Readiness hook (design §5.14, §5.17). A required field defined, changed or removed after records
-- exist changes which of them miss data. The kernel does not know the modules: it calls
-- <module>.custom_field_changed(entity, company) of the module that owns the entity (the first
-- segment of the entity id) in the same transaction, and raises when that module does not define it,
-- so a module that stores extra data must say how a definition affects its records.
-- ---------------------------------------------------------------------------------------------
create or replace function kernel.notify_custom_field_changed(p_entity text, p_company uuid) returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_module text := split_part(p_entity, '.', 1);
begin
  if to_regprocedure(format('%I.custom_field_changed(text,uuid)', v_module)) is null then
    raise exception 'module % has no custom_field_changed hook (entity %)', v_module, p_entity;
  end if;
  execute format('select %I.custom_field_changed($1, $2)', v_module) using p_entity, p_company;
end;
$$;
revoke execute on function kernel.notify_custom_field_changed(text, uuid) from public, anon, authenticated;

create or replace function kernel.custom_field_changed() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  if tg_op <> 'INSERT' then
    perform kernel.notify_custom_field_changed(old.entity, old.company_id);
  end if;
  if tg_op <> 'DELETE' and (tg_op = 'INSERT' or (new.entity, new.company_id) is distinct from (old.entity, old.company_id)) then
    perform kernel.notify_custom_field_changed(new.entity, new.company_id);
  end if;
  return null;
end;
$$;
revoke execute on function kernel.custom_field_changed() from public, anon, authenticated;
create trigger custom_field_changed after insert or update or delete on kernel.custom_fields
  for each row execute function kernel.custom_field_changed();
