-- 0007_kernel_attachments
-- Forward-only migration (rule 34). Covered by packages/modules/core/src/__tests__/attachments.integration.test.ts
-- (the owning entities, their update permission and invoice_ready are core's, so the suite lives there).
-- Attachments on any entity (design §5.13, rule 22): tagged files with a soft delete, the admin's
-- required files per entity, the per-record count view, the private Storage bucket, and the hooks that
-- keep a record's invoice readiness (design §5.17, rule 10) in step with its files.

-- ---------------------------------------------------------------------------------------------
-- Required files per entity, defined by the company admin. `condition` is a predicate name the
-- record is evaluated against (null = always): co, co-juridica, proveedor, cliente.
-- ---------------------------------------------------------------------------------------------
create table kernel.required_attachments (
  id          uuid primary key default kernel.uuid_v7(),
  company_id  uuid not null references kernel.companies (id),
  entity      text not null check (entity ~ '^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$'),
  tag         text not null check (btrim(tag) <> ''),
  kind        text not null check (kind in ('pdf', 'image', 'any')),
  required    boolean not null default true,
  condition   text,
  description text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  created_by  uuid default kernel.current_user_id(),
  updated_by  uuid,
  unique (company_id, entity, tag)
);
-- "RUT" and " rut " are the same definition.
create unique index required_attachments_tag_key on kernel.required_attachments (company_id, entity, lower(btrim(tag)));
create trigger required_attachments_touch_updated before update on kernel.required_attachments
  for each row execute function kernel.touch_updated();

grant select, insert, update, delete on kernel.required_attachments to authenticated;
grant all on kernel.required_attachments to service_role;

-- Everybody in the active company reads the definitions; only its admin writes them.
select kernel.enable_company_rls('kernel', 'required_attachments');
create policy admin_insert on kernel.required_attachments as restrictive for insert to authenticated
  with check ((select kernel.is_company_admin()));
create policy admin_update on kernel.required_attachments as restrictive for update to authenticated
  using ((select kernel.is_company_admin())) with check ((select kernel.is_company_admin()));
create policy admin_delete on kernel.required_attachments as restrictive for delete to authenticated
  using ((select kernel.is_company_admin()));
select kernel.enable_row_audit('kernel', 'required_attachments');

-- ---------------------------------------------------------------------------------------------
-- Attachments. One row per stored file; the bytes live in the private Storage bucket at
-- storage_path (<tenant>/<company>/<entity>/<record_id>/<uuid>-<file name>). Removal is soft
-- (removed_at / removed_by) and the row stays for the audit. record_id has no foreign key: the
-- owning table depends on the entity, so kernel.attachment.add checks the record instead.
-- ---------------------------------------------------------------------------------------------
create table kernel.attachments (
  id           uuid primary key default kernel.uuid_v7(),
  company_id   uuid not null references kernel.companies (id),
  entity       text not null check (entity ~ '^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$'),
  record_id    uuid not null,
  tag          text not null check (btrim(tag) <> ''),
  file_name    text not null check (btrim(file_name) <> ''),
  mime_type    text not null,
  size_bytes   bigint not null check (size_bytes >= 0 and size_bytes <= 26214400),
  storage_path text not null unique,
  -- Display order within the record, ascending (first = principal for photos). kernel.attachment.add puts a new
  -- file last; kernel.attachment.reorder rewrites it 0..n-1. Ties fall back to the upload time.
  position     int not null default 0,
  -- A picture the assistant suggested (kernel.ai.image_suggest) that no user has approved yet; making it the
  -- first of its record through kernel.attachment.reorder is the approval and clears the flag (design §5.18).
  suggested    boolean not null default false,
  removed_at   timestamptz,
  removed_by   uuid,
  -- created_at / created_by are the upload time and the uploader.
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  created_by   uuid default kernel.current_user_id(),
  updated_by   uuid
);
create index attachments_record_idx on kernel.attachments (company_id, entity, record_id) where removed_at is null;
-- A record never holds two live files with the same name (any case): an upload never replaces one silently.
create unique index attachments_live_name_key on kernel.attachments (company_id, entity, record_id, lower(file_name)) where removed_at is null;

-- Users insert through kernel.attachment.add / kernel.ai.image_suggest and may only fill the removal columns, the
-- display order and the suggested flag afterwards.
grant select, insert on kernel.attachments to authenticated;
grant update (removed_at, removed_by, position, suggested, updated_at, updated_by) on kernel.attachments to authenticated;
grant all on kernel.attachments to service_role;
select kernel.enable_company_rls('kernel', 'attachments');
select kernel.enable_row_audit('kernel', 'attachments');

-- Writes only through the process pipeline (rule 1): runProcess sets erp.audit_process_id for the
-- transaction, so a member writing directly (outside kernel.attachment.add / remove / reorder and the AI photo
-- suggestion, which stores a file like an upload) is refused. The service role bypasses RLS and is not affected.
create policy via_process_insert on kernel.attachments as restrictive for insert to authenticated
  with check (coalesce(current_setting('erp.audit_process_id', true), '') like 'kernel.attachment.%'
              or coalesce(current_setting('erp.audit_process_id', true), '') = 'kernel.ai.image_suggest');
-- kernel.attachment.% covers remove (removal columns) and reorder (position, suggested); the column grant and the
-- guard below keep every other column fixed.
create policy via_process_update on kernel.attachments as restrictive for update to authenticated
  using (coalesce(current_setting('erp.audit_process_id', true), '') like 'kernel.attachment.%')
  with check (coalesce(current_setting('erp.audit_process_id', true), '') like 'kernel.attachment.%');

-- An attachment is immutable but for its removal (permanent), its display order and its suggested flag.
create or replace function kernel.attachment_guard() returns trigger
language plpgsql
as $$
begin
  if old.removed_at is not null then
    raise exception 'attachment % was removed and cannot change', old.id using errcode = 'check_violation';
  end if;
  if (to_jsonb(new) - 'removed_at' - 'removed_by' - 'position' - 'suggested' - 'updated_at' - 'updated_by')
     is distinct from (to_jsonb(old) - 'removed_at' - 'removed_by' - 'position' - 'suggested' - 'updated_at' - 'updated_by')
     -- who removed a file only changes together with when.
     or (new.removed_at is null and new.removed_by is distinct from old.removed_by) then
    raise exception 'attachment % can only be removed or reordered, not changed', old.id using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
create trigger attachment_guard before update on kernel.attachments
  for each row execute function kernel.attachment_guard();
create trigger attachments_touch_updated before update on kernel.attachments
  for each row execute function kernel.touch_updated();

-- Live files per record, for the grids' attachment count column. Company RLS applies to the reader.
create or replace view kernel.v_attachment_counts with (security_invoker = true) as
select entity, record_id, count(*)::int as count
from kernel.attachments
where removed_at is null
group by entity, record_id;
grant select on kernel.v_attachment_counts to authenticated;

-- The admin's required files as the record page reads them (design §5.13): which tags a record must or may carry.
-- The page applies each definition's `condition` to the record (requirementApplies in @erp/kernel, the TypeScript
-- twin of kernel.missing_attachments). Company RLS applies to the reader.
create or replace view kernel.v_required_attachments with (security_invoker = true) as
select id, company_id, entity, tag, kind, required, condition, description
from kernel.required_attachments;
grant select on kernel.v_required_attachments to authenticated;

-- ---------------------------------------------------------------------------------------------
-- Missing required files of a record (SQL twin of missingAttachments in @erp/kernel). The tags of
-- the required definitions that apply to the record and have no live file of a fitting type, by tag.
-- The record's own facts arrive as arguments so the kernel stays ignorant of the owning table:
-- p_country / p_person_type / p_kind feed the conditions (null when the entity has none).
--   null          always
--   co            the record's country is CO
--   co-juridica   CO and person type '1' (persona jurídica)
--   proveedor     kind contains 'supplier'
--   cliente       kind contains 'customer'
-- A condition this function does not know counts as applying: a requirement the system cannot
-- evaluate is never silently waived. A file fits when its tag matches the definition's (trimmed,
-- any case) and its type matches the definition's kind (pdf -> application/pdf, image -> image/*).
-- ---------------------------------------------------------------------------------------------
create or replace function kernel.missing_attachments(
  p_company uuid, p_entity text, p_record_id uuid, p_country text, p_person_type text, p_kind text[]
) returns text[]
language sql stable
set search_path = ''
as $$
  select coalesce(array_agg(ra.tag order by ra.tag), '{}'::text[])
  from kernel.required_attachments ra
  where ra.company_id = p_company
    and ra.entity = p_entity
    and ra.required
    and case
          when ra.condition is null then true
          when ra.condition = 'co' then p_country = 'CO'
          when ra.condition = 'co-juridica' then p_country = 'CO' and p_person_type = '1'
          when ra.condition = 'proveedor' then coalesce(p_kind, '{}'::text[]) @> array['supplier']
          when ra.condition = 'cliente' then coalesce(p_kind, '{}'::text[]) @> array['customer']
          else true
        end
    and not exists (
      select 1
      from kernel.attachments a
      where a.company_id = p_company
        and a.entity = p_entity
        and a.record_id = p_record_id
        and a.removed_at is null
        and lower(btrim(a.tag)) = lower(btrim(ra.tag))
        and case ra.kind
              when 'pdf' then a.mime_type = 'application/pdf'
              when 'image' then a.mime_type like 'image/%'
              else true
            end
    );
$$;
revoke execute on function kernel.missing_attachments(uuid, text, uuid, text, text, text[]) from public, anon;
grant execute on function kernel.missing_attachments(uuid, text, uuid, text, text, text[]) to authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- Colombia defaults for a company's required files. Called when a company is created (the demo seed
-- and company creation) and by the test seed; idempotent; does nothing for another country.
-- ---------------------------------------------------------------------------------------------
create or replace function kernel.seed_required_attachments(p_company uuid) returns void
language sql
set search_path = ''
as $$
  insert into kernel.required_attachments (company_id, entity, tag, kind, required, condition, description)
  select c.id, d.entity, d.tag, d.kind, d.required, d.condition, d.description
  from kernel.companies c
  cross join (values
    ('core.party',   'RUT',                    'pdf', true,  'co',          'Registro Único Tributario vigente'),
    ('core.party',   'Cámara de Comercio',     'pdf', true,  'co-juridica', 'Certificado de existencia y representación legal'),
    ('core.party',   'Certificación bancaria', 'pdf', false, 'proveedor',   'Certificación de la cuenta bancaria para pagos'),
    ('core.product', 'Ficha técnica',          'pdf', false, null,          'Ficha técnica del producto')
  ) as d (entity, tag, kind, required, condition, description)
  where c.id = p_company and c.country_code = 'CO'
  on conflict (company_id, entity, tag) do nothing;
$$;
revoke execute on function kernel.seed_required_attachments(uuid) from public, anon, authenticated;
grant execute on function kernel.seed_required_attachments(uuid) to service_role;

-- ---------------------------------------------------------------------------------------------
-- Readiness hooks (design §5.17). The kernel does not know the modules: after a file is added or
-- removed, or a requirement changes, it calls <module>.attachments_changed(entity, company, record)
-- of the module that owns the entity (the first segment of the entity id), and raises when that module
-- does not define it; record is null when the whole entity must be re-evaluated. The module re-evaluates its records
-- in the same transaction, so a record loses invoice_ready the moment its last required file goes.
-- ---------------------------------------------------------------------------------------------
create or replace function kernel.notify_attachments_changed(p_entity text, p_company uuid, p_record_id uuid) returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_module text := split_part(p_entity, '.', 1);
begin
  -- A module that accepts files for its entities must say how a file change affects its records; a silent
  -- skip would leave invoice_ready stale.
  if to_regprocedure(format('%I.attachments_changed(text,uuid,uuid)', v_module)) is null then
    raise exception 'module % has no attachments_changed hook (entity %)', v_module, p_entity;
  end if;
  execute format('select %I.attachments_changed($1, $2, $3)', v_module) using p_entity, p_company, p_record_id;
end;
$$;
revoke execute on function kernel.notify_attachments_changed(text, uuid, uuid) from public, anon, authenticated;

create or replace function kernel.attachment_changed() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  perform kernel.notify_attachments_changed(new.entity, new.company_id, new.record_id);
  return null;
end;
$$;
revoke execute on function kernel.attachment_changed() from public, anon, authenticated;
create trigger attachment_changed after insert or update of removed_at on kernel.attachments
  for each row execute function kernel.attachment_changed();

create or replace function kernel.required_attachment_changed() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  if tg_op <> 'INSERT' then
    perform kernel.notify_attachments_changed(old.entity, old.company_id, null);
  end if;
  if tg_op <> 'DELETE' and (tg_op = 'INSERT' or (new.entity, new.company_id) is distinct from (old.entity, old.company_id)) then
    perform kernel.notify_attachments_changed(new.entity, new.company_id, null);
  end if;
  return null;
end;
$$;
revoke execute on function kernel.required_attachment_changed() from public, anon, authenticated;
create trigger required_attachment_changed after insert or update or delete on kernel.required_attachments
  for each row execute function kernel.required_attachment_changed();

-- ---------------------------------------------------------------------------------------------
-- Storage: the private bucket `attachments` (25 MB per object). No policy lets a user touch it:
-- only the service role reads and writes, from route handlers, and downloads are signed URLs
-- minted server-side (60 s).
-- ---------------------------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit)
values ('attachments', 'attachments', false, 26214400)
on conflict (id) do nothing;

create policy attachments_service_role_only on storage.objects for all to service_role
  using (bucket_id = 'attachments') with check (bucket_id = 'attachments');
