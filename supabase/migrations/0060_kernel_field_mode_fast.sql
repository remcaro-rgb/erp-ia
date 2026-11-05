-- Field visibility, cheaper per call (2026-11-04). Every masked view (rule 14) asks kernel.field_visible once per column, and each
-- ask ran kernel.is_company_admin and kernel.field_mode, whose filters called kernel.current_role_ids, current_company_id and
-- current_company_ids once per scanned row of kernel.roles and kernel.field_permissions (the planner cannot hoist a STABLE function out
-- of a filter). On the hosted project that cost about 2 ms a column, 300 ms for a ledger page. The three functions are now plpgsql (their plans are cached
-- for the session instead of rebuilt on every call), read the claims once per call and field_visible no longer goes through
-- field_mode and is_company_admin as nested security-definer calls. Same rules, same results; forward-only.

create or replace function kernel.is_company_admin()
returns boolean
language plpgsql stable parallel safe security definer
set search_path = ''
as $$
declare
  v_company uuid := kernel.current_company_id();
begin
  return exists (
    select 1
    from kernel.roles r
    where r.id = any (kernel.current_role_ids())
      and r.company_id = v_company
      and array[r.company_id] <@ kernel.current_company_ids()
      and r.is_system
      and r.name = 'admin'
  );
end;
$$;

create or replace function kernel.field_mode(entity text, field text)
returns text
language plpgsql stable parallel safe security definer
set search_path = ''
as $$
declare
  v_company uuid := kernel.current_company_id();
  v_roles uuid[] := kernel.current_role_ids();
  v_rank int;
begin
  if exists (select 1 from kernel.roles r
             where r.id = any (v_roles) and r.company_id = v_company and array[r.company_id] <@ kernel.current_company_ids()
               and r.is_system and r.name = 'admin') then
    return 'visible';
  end if;
  select max(case fp.mode when 'hidden' then 3 when 'masked' then 2 else 1 end) into v_rank
  from kernel.field_permissions fp
  where fp.company_id = v_company and array[fp.company_id] <@ kernel.current_company_ids()
    and fp.role_id = any (v_roles) and fp.entity = field_mode.entity and fp.field = field_mode.field;
  return case v_rank when 3 then 'hidden' when 2 then 'masked' else 'visible' end;
end;
$$;

create or replace function kernel.field_visible(entity text, field text)
returns boolean
language plpgsql stable parallel safe security definer
set search_path = ''
as $$
declare
  v_company uuid := kernel.current_company_id();
  v_roles uuid[] := kernel.current_role_ids();
begin
  if exists (select 1 from kernel.roles r
             where r.id = any (v_roles) and r.company_id = v_company and array[r.company_id] <@ kernel.current_company_ids()
               and r.is_system and r.name = 'admin') then
    return true;
  end if;
  return not exists (
    select 1 from kernel.field_permissions fp
    where fp.company_id = v_company and array[fp.company_id] <@ kernel.current_company_ids()
      and fp.role_id = any (v_roles) and fp.entity = field_visible.entity and fp.field = field_visible.field
      and fp.mode in ('hidden', 'masked'));
end;
$$;
