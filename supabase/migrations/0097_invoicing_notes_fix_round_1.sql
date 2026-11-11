-- 0097_invoicing_notes_fix_round_1
-- Forward-only migration (rule 34), plan 2B Task 18 fix round 1. Covered by packages/modules/invoicing/src/__tests__/note.integration.test.ts
-- and packages/localization/co/src/__tests__/einvoice-pack.test.ts.
--
--  1. A credit or debit note needs no DIAN resolution: the DIAN authorizes numbering ranges for invoices only, and a note has no technical
--     key (its CUDE takes the software PIN). core.next_document_number draws a note's number from a plain sequence row of its type (prefix
--     and next number). A row that carries a resolution keeps its prefix and range (out_of_range past its end), never its validity dates.
--     No row: `no_sequence`. An invoice is drawn as before (a valid resolution on the date).
--  2. The invoice keeps whether it was issued as an export (`is_export`, frozen at «Emitir» by invoice_issued_frozen, which leaves it out of
--     its moving columns): its notes and its resends follow what was issued, never today's buyer. Issued invoices are backfilled from the
--     buyer's country against the company's, as «Emitir» computes it.
--  3. Backstops: an invoice is never credited above its total plus its debits; a note line names a line of the note's own invoice; the
--     lines of a Borrador note go with it (on delete cascade, as its taxes).

-- =============================================================================================
-- 1. The numbering of notes
-- =============================================================================================
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

  if p_type <> 'invoice' then
    -- A note: the company's sequence row of the type; one whose range (if it carries one) is not exhausted first.
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
  return jsonb_build_object('status', 'ok', 'prefix', v_res ->> 'prefix', 'number', v_number, 'resolution', v_res);
end;
$$;
revoke execute on function core.next_document_number(uuid, text, date) from public, anon;
grant execute on function core.next_document_number(uuid, text, date) to authenticated, service_role;

-- =============================================================================================
-- 2. The export, frozen at «Emitir»
-- =============================================================================================
alter table invoicing.invoices add column is_export boolean not null default false;

-- Issued invoices predate the flag: their buyer's country against the company's (what «Emitir» computes from now on). The frozen trigger
-- refuses any change of an issued invoice, so the backfill runs with the triggers off for this statement only.
set local session_replication_role = replica;
update invoicing.invoices i
   set is_export = true
  from core.parties p, kernel.companies c
 where p.id = i.party_id and c.id = i.company_id and i.stage <> 'draft'
   and coalesce(p.country_code, c.country_code) <> c.country_code;
set local session_replication_role = origin;

-- =============================================================================================
-- 3. Backstops
-- =============================================================================================
alter table invoicing.invoices add constraint invoices_credited_within_total check (credited_amount <= total + debited_amount);

alter table invoicing.note_lines drop constraint note_lines_note_id_fkey;
alter table invoicing.note_lines add constraint note_lines_note_id_fkey foreign key (note_id) references invoicing.notes (id) on delete cascade;

create or replace function invoicing.note_line_of_invoice() returns trigger
language plpgsql
as $$
begin
  if not exists (
    select 1 from invoicing.invoice_lines il join invoicing.notes n on n.invoice_id = il.invoice_id
    where il.id = new.invoice_line_id and n.id = new.note_id
  ) then
    raise exception 'erp:invalid_input:La línea % de la nota no es de la factura de la nota', new.line_no;
  end if;
  return new;
end;
$$;
create trigger note_line_of_invoice before insert or update of invoice_line_id, note_id on invoicing.note_lines
  for each row execute function invoicing.note_line_of_invoice();
