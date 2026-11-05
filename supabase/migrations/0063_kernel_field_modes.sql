-- 0063_kernel_field_modes
-- Forward-only migration (rule 34). Covered by packages/kernel/src/__tests__/masking.integration.test.ts.
-- Every grid and record page asks the viewer's mode of each field of the entity (60 and more) with
--   select f, kernel.field_mode(entity, f) from unnest(fields) f
-- and each call asked again who the caller is: 13 ms a page query on the hosted project, nine of them for one comprobante. This answers the
-- whole list with the caller's identity read once and one read of kernel.field_permissions. Same rule as kernel.field_mode (0003,
-- 0060): an administrator sees everything; otherwise the most restrictive mode among the caller's roles of the company wins
-- (hidden > masked > visible); no row means visible. kernel.party_scope reads the caller once too.

create or replace function kernel.field_modes(p_entity text, p_fields text[])
returns table (field text, mode text)
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_company uuid := kernel.current_company_id();
  v_roles   uuid[] := kernel.current_role_ids();
begin
  if exists (select 1 from kernel.roles r
             where r.id = any (v_roles) and r.company_id = v_company and array[r.company_id] <@ kernel.current_company_ids()
               and r.is_system and r.name = 'admin') then
    return query select f, 'visible'::text from unnest(p_fields) as f;
    return;
  end if;
  return query
  select f.name,
         case coalesce(m.rank, 1) when 3 then 'hidden' when 2 then 'masked' else 'visible' end
  from unnest(p_fields) as f(name)
  left join lateral (
    select max(case fp.mode when 'hidden' then 3 when 'masked' then 2 else 1 end) as rank
    from kernel.field_permissions fp
    where fp.company_id = v_company and array[fp.company_id] <@ kernel.current_company_ids()
      and fp.role_id = any (v_roles) and fp.entity = p_entity and fp.field = f.name
  ) m on true;
end;
$$;
revoke execute on function kernel.field_modes(text, text[]) from public, anon;
grant execute on function kernel.field_modes(text, text[]) to authenticated, service_role;

create or replace function kernel.party_scope() returns text
language plpgsql stable security definer parallel safe
set search_path = ''
as $$
declare
  v_company uuid := kernel.current_company_id();
  v_roles   uuid[] := kernel.current_role_ids();
  v_scope   text;
begin
  select case
    when bool_or(r.party_scope = 'ambos')
      or (bool_or(r.party_scope = 'clientes') and bool_or(r.party_scope = 'proveedores')) then 'ambos'
    when bool_or(r.party_scope = 'clientes') then 'clientes'
    when bool_or(r.party_scope = 'proveedores') then 'proveedores'
    else 'ninguno'
  end into v_scope
  from kernel.roles r
  where r.id = any (v_roles) and r.company_id = v_company and array[r.company_id] <@ kernel.current_company_ids();
  return v_scope;
end;
$$;
