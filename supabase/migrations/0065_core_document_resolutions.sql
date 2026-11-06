-- DIAN numbering resolutions (design §5.7; plan 2B task 3). core.document_sequences.resolution gets a
-- validated shape (a missing key is invalid, not NULL-passes-the-check) and core.next_document_number draws the next consecutive number of the company's
-- resolution for invoice / credit_note / debit_note, locking the sequence row. Forward-only.

-- 'YYYY-MM-DD' that is a real calendar date (2026-02-30 is not).
create or replace function core.valid_iso_date(p text) returns boolean
language plpgsql immutable
set search_path = ''
as $$
begin
  return p ~ '^\d{4}-\d{2}-\d{2}$' and to_char(to_date(p, 'YYYY-MM-DD'), 'YYYY-MM-DD') = p;
exception when others then
  return false;
end;
$$;

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
    and jsonb_typeof(p -> 'technicalKey') = 'string' and length(p ->> 'technicalKey') > 0,
    false);
$$;

alter table core.document_sequences
  add constraint document_sequences_resolution_valid check (core.valid_resolution(resolution));

-- Returns {status:'ok', prefix, number} or {status:'out_of_range'|'expired'|'not_yet_valid'|'no_resolution', resolution}.
-- A per-(company, type) advisory lock is taken BEFORE the row is chosen: ordering and then locking let a
-- caller pick a row that was exhausted while it waited (a renewed resolution has two rows). The row is chosen among the company's sequences of the type that carry a resolution: the one valid on
-- the issue date with numbers left first, then the lowest seq. The row lock queues concurrent callers; a
-- refusal does not touch the counter. Credit and debit notes are their own document types, hence their own sequences.
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
begin
  if p_type not in ('invoice', 'credit_note', 'debit_note') then
    raise exception 'document type % has no DIAN resolution', p_type using errcode = 'invalid_parameter_value';
  end if;
  if kernel.current_user_id() is not null
     and not (p_company = kernel.current_company_id() and array[p_company] <@ kernel.current_company_ids()) then
    raise exception 'company % is not the caller''s active company', p_company using errcode = 'insufficient_privilege';
  end if;
  perform pg_advisory_xact_lock(hashtext(p_company::text || ':' || p_type));
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
  return jsonb_build_object('status', 'ok', 'prefix', v_res ->> 'prefix', 'number', v_number);
end;
$$;
revoke execute on function core.next_document_number(uuid, text, date) from public, anon;
grant execute on function core.next_document_number(uuid, text, date) to authenticated, service_role;
