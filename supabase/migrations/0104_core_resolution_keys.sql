-- 0104_core_resolution_keys
-- Forward-only migration (rule 34). Covered by packages/modules/invoicing/src/__tests__/parametros.integration.test.ts (fix round 2),
-- einvoice-workflow.integration.test.ts (a renewed resolution) and packages/modules/core/src/__tests__/document-number.integration.test.ts.
-- Plan 2B Task 19 fix round 2 (security review):
--   1. The technical key of a DIAN resolution (it signs every CUFE) leaves core.document_sequences.resolution: authenticated reads that
--      table, its row audit wrote the whole jsonb into kernel.audit_log.diff, and 0102 only masked the view. The key now lives in
--      core.document_resolution_keys, one row per (company, document type, prefix, resolution NUMBER), closed to every role but the
--      definer functions (RLS on, no policy, no grant) and not row-audited. A BEFORE trigger on core.document_sequences moves any
--      `technicalKey` written into the resolution (by core.register_document_sequence, a seed or a test fixture) into it and leaves
--      `technicalKeyEnding` (its last 4 characters) in the jsonb, so the row audit (AFTER) never sees the key.
--   2. A renewal replaces the resolution of the sequence row (0100) but no longer loses the old key: the documents issued under the old
--      resolution (still failed, not_configured, rejected or pending) are built with the key of THEIR resolution number.
--   3. Readers of the key: core.next_document_number answers it on a drawn invoice number only inside an invoicing process run or to the
--      server (no user: the worker, tests), never on a refusal; core.document_technical_key only inside an invoicing process run.
--   4. Audit rows written before this migration that carry the key (row audit of core.document_sequences, process input of
--      core.document_sequence.register) stay as they are (append-only, rule 9) but are no longer readable by a user (restrictive policy).

create table core.document_resolution_keys (
  id                uuid primary key default kernel.uuid_v7(),
  seq               bigint not null,
  company_id        uuid not null references kernel.companies (id) on delete cascade, -- test tenants and a deleted company take their keys
  document_type     text not null check (document_type in ('invoice', 'credit_note', 'debit_note')),
  prefix            text not null default '',
  resolution_number text not null check (length(resolution_number) > 0),
  technical_key     text not null check (length(technical_key) > 0),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (company_id, document_type, prefix, resolution_number)
);
create trigger assign_seq before insert on core.document_resolution_keys for each row execute function core.assign_seq('core.document_resolution_key');
alter table core.document_resolution_keys enable row level security;
alter table core.document_resolution_keys force row level security;
revoke all on core.document_resolution_keys from public, anon, authenticated;

-- The existing keys, then the jsonb without them (replica: no row audit of the old value, no trigger).
insert into core.document_resolution_keys (company_id, document_type, prefix, resolution_number, technical_key)
select s.company_id, s.document_type, s.prefix, s.resolution ->> 'number', s.resolution ->> 'technicalKey'
  from core.document_sequences s
 where s.resolution ? 'technicalKey' and length(coalesce(s.resolution ->> 'technicalKey', '')) > 0 and length(coalesce(s.resolution ->> 'number', '')) > 0
on conflict (company_id, document_type, prefix, resolution_number) do nothing;

alter table core.document_sequences drop constraint document_sequences_resolution_valid;
set local session_replication_role = replica;
update core.document_sequences
   set resolution = (resolution - 'technicalKey') || jsonb_build_object('technicalKeyEnding', right(resolution ->> 'technicalKey', 4))
 where resolution ? 'technicalKey';
set local session_replication_role = origin;

-- The resolution's shape: everything Task 3 validated, with the key's ending instead of the key (which is never stored here).
create or replace function core.valid_resolution(p jsonb) returns boolean
language sql immutable
set search_path = ''
as $$
  select p is null or coalesce(
    jsonb_typeof(p) = 'object'
    and jsonb_typeof(p -> 'number') = 'string' and length(p ->> 'number') > 0
    and jsonb_typeof(p -> 'prefix') = 'string'
    and jsonb_typeof(p -> 'from') = 'number' and (p ->> 'from') ~ '^[1-9][0-9]{0,17}$'
    and jsonb_typeof(p -> 'to') = 'number' and (p ->> 'to') ~ '^[1-9][0-9]{0,17}$'
    and (p ->> 'to')::bigint >= (p ->> 'from')::bigint
    and jsonb_typeof(p -> 'validFrom') = 'string' and core.valid_iso_date(p ->> 'validFrom')
    and jsonb_typeof(p -> 'validTo') = 'string' and core.valid_iso_date(p ->> 'validTo')
    and (p ->> 'validTo') >= (p ->> 'validFrom')
    and not (p ? 'technicalKey')
    and jsonb_typeof(p -> 'technicalKeyEnding') = 'string' and length(p ->> 'technicalKeyEnding') > 0,
    false);
$$;
alter table core.document_sequences
  add constraint document_sequences_resolution_valid check (core.valid_resolution(resolution));

create or replace function core.document_sequences_keep_key() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  if new.resolution is not null and new.resolution ? 'technicalKey' then
    if jsonb_typeof(new.resolution -> 'technicalKey') = 'string' and length(new.resolution ->> 'technicalKey') > 0
       and length(coalesce(new.resolution ->> 'number', '')) > 0 then
      insert into core.document_resolution_keys (company_id, document_type, prefix, resolution_number, technical_key)
      values (new.company_id, new.document_type, new.prefix, new.resolution ->> 'number', new.resolution ->> 'technicalKey')
      on conflict (company_id, document_type, prefix, resolution_number)
        do update set technical_key = excluded.technical_key, updated_at = now();
      new.resolution := (new.resolution - 'technicalKey') || jsonb_build_object('technicalKeyEnding', right(new.resolution ->> 'technicalKey', 4));
    else
      -- Not a key: left out, so the shape check refuses the resolution.
      new.resolution := new.resolution - 'technicalKey';
    end if;
  end if;
  return new;
end;
$$;
revoke all on function core.document_sequences_keep_key() from public, anon, authenticated;
create trigger keep_key before insert or update of resolution on core.document_sequences
  for each row execute function core.document_sequences_keep_key();

-- True when the key may be answered: inside an invoicing process run (issue, the electronic document), or to the server (no user).
create or replace function core.technical_key_readable() returns boolean
language sql stable
set search_path = ''
as $$
  select coalesce(current_setting('erp.audit_process_id', true), '') like 'invoicing.%' or kernel.current_user_id() is null;
$$;
revoke all on function core.technical_key_readable() from public, anon;

create or replace function core.document_technical_key(p_company uuid, p_type text, p_prefix text, p_number text) returns text
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_key text;
begin
  if coalesce(current_setting('erp.audit_process_id', true), '') not like 'invoicing.%' then
    raise exception 'the technical key is read only inside a process run of invoicing' using errcode = 'insufficient_privilege';
  end if;
  if kernel.current_user_id() is not null
     and not (p_company = kernel.current_company_id() and array[p_company] <@ kernel.current_company_ids()) then
    raise exception 'company % is not the caller''s active company', p_company using errcode = 'insufficient_privilege';
  end if;
  select technical_key into v_key
    from core.document_resolution_keys
   where company_id = p_company and document_type = p_type and prefix = coalesce(p_prefix, '') and resolution_number = p_number;
  return v_key;
end;
$$;
revoke all on function core.document_technical_key(uuid, text, text, text) from public, anon;
grant execute on function core.document_technical_key(uuid, text, text, text) to authenticated, service_role;

-- 0097's draw, answering the key of the resolution the number was drawn from (only when core.technical_key_readable()).
create or replace function core.next_document_number(p_company uuid, p_type text, p_issued_at date) returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_id      uuid;
  v_next    bigint;
  v_res     jsonb;
  v_number  bigint;
  v_prefix  text;
  v_key     text;
begin
  if p_type not in ('invoice', 'credit_note', 'debit_note') then
    raise exception 'document type % has no DIAN resolution', p_type using errcode = 'invalid_parameter_value';
  end if;
  if kernel.current_user_id() is not null
     and not (p_company = kernel.current_company_id() and array[p_company] <@ kernel.current_company_ids()) then
    raise exception 'company % is not the caller''s active company', p_company using errcode = 'insufficient_privilege';
  end if;
  perform pg_advisory_xact_lock(hashtext(p_company::text || ':' || p_type));

  if p_type <> 'invoice' then
    select id, next_number, resolution, prefix into v_id, v_next, v_res, v_prefix
      from core.document_sequences
     where company_id = p_company and document_type = p_type
     order by (resolution is null or greatest(next_number, (resolution ->> 'from')::bigint) <= (resolution ->> 'to')::bigint) desc,
              seq
     limit 1
     for update;
    if v_id is null then
      return jsonb_build_object('status', 'no_sequence');
    end if;
    if v_res is null then
      update core.document_sequences set next_number = v_next + 1, updated_at = now() where id = v_id;
      return jsonb_build_object('status', 'ok', 'prefix', v_prefix, 'number', v_next);
    end if;
    v_number := greatest(v_next, (v_res ->> 'from')::bigint);
    if v_number > (v_res ->> 'to')::bigint then
      return jsonb_build_object('status', 'out_of_range', 'resolution', v_res);
    end if;
    update core.document_sequences set next_number = v_number + 1, updated_at = now() where id = v_id;
    if core.technical_key_readable() then
      select technical_key into v_key from core.document_resolution_keys
       where company_id = p_company and document_type = p_type and prefix = v_prefix and resolution_number = v_res ->> 'number';
      if v_key is not null then v_res := (v_res - 'technicalKeyEnding') || jsonb_build_object('technicalKey', v_key); end if;
    end if;
    return jsonb_build_object('status', 'ok', 'prefix', v_res ->> 'prefix', 'number', v_number, 'resolution', v_res);
  end if;

  select id, next_number, resolution, prefix into v_id, v_next, v_res, v_prefix
    from core.document_sequences
   where company_id = p_company and document_type = p_type and resolution is not null
   order by (p_issued_at between (resolution ->> 'validFrom')::date and (resolution ->> 'validTo')::date) desc,
            (greatest(next_number, (resolution ->> 'from')::bigint) <= (resolution ->> 'to')::bigint) desc,
            seq
   limit 1
   for update;
  if v_id is null then
    return jsonb_build_object('status', 'no_resolution');
  end if;
  if p_issued_at > (v_res ->> 'validTo')::date then
    return jsonb_build_object('status', 'expired', 'resolution', v_res);
  end if;
  if p_issued_at < (v_res ->> 'validFrom')::date then
    return jsonb_build_object('status', 'not_yet_valid', 'resolution', v_res);
  end if;
  v_number := greatest(v_next, (v_res ->> 'from')::bigint);
  if v_number > (v_res ->> 'to')::bigint then
    return jsonb_build_object('status', 'out_of_range', 'resolution', v_res);
  end if;
  update core.document_sequences set next_number = v_number + 1, updated_at = now() where id = v_id;
  if core.technical_key_readable() then
    select technical_key into v_key from core.document_resolution_keys
     where company_id = p_company and document_type = p_type and prefix = v_prefix and resolution_number = v_res ->> 'number';
    if v_key is not null then v_res := (v_res - 'technicalKeyEnding') || jsonb_build_object('technicalKey', v_key); end if;
  end if;
  return jsonb_build_object('status', 'ok', 'prefix', v_res ->> 'prefix', 'number', v_number, 'resolution', v_res);
end;
$$;

-- The view as maskedViewSql generates it (rule 14): the jsonb no longer carries the key, only technicalKeyEnding.
create or replace view core.v_document_sequences with (security_invoker = true) as
select
  "id",
  "company_id",
  case when (select kernel.field_visible('core.document_sequence', 'seq')) then "seq" else null end as "seq",
  case when (select kernel.field_visible('core.document_sequence', 'document_type')) then "document_type" else null end as "document_type",
  case when (select kernel.field_visible('core.document_sequence', 'prefix')) then "prefix" else null end as "prefix",
  case when (select kernel.field_visible('core.document_sequence', 'next_number')) then "next_number" else null end as "next_number",
  case when (select kernel.field_visible('core.document_sequence', 'padding')) then "padding" else null end as "padding",
  case when (select kernel.field_visible('core.document_sequence', 'resolution')) then "resolution" else null end as "resolution",
  case when (select kernel.field_visible('core.document_sequence', 'extra')) then kernel.mask_extra('core.document_sequence', "extra") else null end as "extra",
  case when (select kernel.field_visible('core.document_sequence', 'extra_free')) then "extra_free" else null end as "extra_free",
  "created_at",
  "updated_at"
from core.document_sequences;
grant select on core.v_document_sequences to authenticated;

-- Audit rows of before this migration that carry the key: kept (append-only), hidden from every user.
create policy technical_key_hidden on kernel.audit_log as restrictive for select to authenticated
using (
  (entity is distinct from 'core.document_sequence' and process_id is distinct from 'core.document_sequence.register')
  or not (coalesce(diff::text, '') like '%"technicalKey"%' or coalesce(input::text, '') like '%"technicalKey"%')
);
