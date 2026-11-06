-- 0100_core_document_sequence_register
-- Forward-only migration (rule 34). Covered by packages/modules/invoicing/src/__tests__/parametros.integration.test.ts.
-- Registering a numbering (plan 2B Task 19; design §5.7; Task 3's resolution shape): the DIAN resolution of invoices (number, prefix, range,
-- validity, technical key) and the numbering rows of credit and debit notes (Task 18: no resolution of their own). core owns
-- core.document_sequences (rule 3), so the register is the core process core.document_sequence.register (step-up), never an invoicing
-- write. The table stays closed to the authenticated role (0006 revoked insert and update): the process writes through this security
-- definer function, which only that process's transaction may call (erp.audit_process_id), for the caller's active company only, and which
-- never rewinds a counter (a number already drawn is never drawn again).

create or replace function core.register_document_sequence(
  p_company uuid, p_type text, p_prefix text, p_next bigint, p_resolution jsonb
) returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_row core.document_sequences;
  v_next bigint;
begin
  if coalesce(current_setting('erp.audit_process_id', true), '') <> 'core.document_sequence.register' then
    raise exception 'core.register_document_sequence runs only inside the process core.document_sequence.register' using errcode = 'insufficient_privilege';
  end if;
  if kernel.current_user_id() is not null
     and not (p_company = kernel.current_company_id() and array[p_company] <@ kernel.current_company_ids()) then
    raise exception 'company % is not the caller''s active company', p_company using errcode = 'insufficient_privilege';
  end if;
  if p_type not in ('invoice', 'credit_note', 'debit_note') then
    raise exception 'unknown document type %', p_type using errcode = 'invalid_parameter_value';
  end if;
  if p_type = 'invoice' and p_resolution is null then
    raise exception 'an invoice numbering needs its DIAN resolution' using errcode = 'invalid_parameter_value';
  end if;

  perform pg_advisory_xact_lock(hashtext(p_company::text || ':' || p_type));
  select * into v_row from core.document_sequences
   where company_id = p_company and document_type = p_type and prefix = coalesce(p_prefix, '')
   for update;

  if v_row.id is null then
    v_next := coalesce(p_next, (p_resolution ->> 'from')::bigint, 1);
    insert into core.document_sequences (company_id, document_type, prefix, next_number, resolution)
    values (p_company, p_type, coalesce(p_prefix, ''), v_next, p_resolution)
    returning * into v_row;
  else
    -- A counter never goes back: a lower next number is refused (the numbers below it may already be printed on documents).
    if p_next is not null and p_next < v_row.next_number then
      raise exception 'sequence_rewind: the next number % is below the next number already reached (%)', p_next, v_row.next_number using errcode = 'invalid_parameter_value';
    end if;
    update core.document_sequences
       set next_number = greatest(v_row.next_number, coalesce(p_next, v_row.next_number)),
           resolution = p_resolution,
           updated_at = now()
     where id = v_row.id
    returning * into v_row;
  end if;
  return jsonb_build_object('id', v_row.id, 'documentType', v_row.document_type, 'prefix', v_row.prefix, 'nextNumber', v_row.next_number, 'resolution', v_row.resolution);
end;
$$;

revoke all on function core.register_document_sequence(uuid, text, text, bigint, jsonb) from public, anon;
grant execute on function core.register_document_sequence(uuid, text, text, bigint, jsonb) to authenticated, service_role;
