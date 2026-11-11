-- 0091_core_invoicing_facts
-- Forward-only migration (rule 34). Covered by packages/modules/invoicing/src/__tests__/issue.integration.test.ts (an issued invoice's number,
-- resolution and CUFE) and packages/modules/core/src/__tests__/document-number.integration.test.ts (the numbering itself, unchanged).
-- What the invoicing module (plan 2B Task 16) needs of core, published by core (rule 3: other modules read core only through views and
-- functions core publishes; precedents core.v_party_sales 0081, core.v_product_stock 0067):
--   * core.next_document_number (0065) now also answers, on success, the resolution it drew the number from: the invoice prints its
--     number, prefix, range and validity, and the pack computes the CUFE with its technical key. A refusal answered it already. Additive:
--     the pack's nextInvoiceNumber reads prefix and number as before.
--   * core.v_party_fiscal: the fiscal identity of a tercero as an electronic invoice carries it (document type and number, check digit, legal
--     name, tax scheme and responsibilities, location, invoice e-mail). core.v_parties masks these by field visibility; the CUFE and the
--     XML must carry them whatever the issuer's role may see, so they are published here unmasked, under the same company RLS, record read
--     and party scope (security_invoker).

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
  return jsonb_build_object('status', 'ok', 'prefix', v_res ->> 'prefix', 'number', v_number, 'resolution', v_res);
end;
$$;
revoke execute on function core.next_document_number(uuid, text, date) from public, anon;
grant execute on function core.next_document_number(uuid, text, date) to authenticated, service_role;

create or replace view core.v_party_fiscal with (security_invoker = true) as
select
  "id",
  "company_id",
  "person_type",
  "document_type",
  "document_number",
  "check_digit",
  "legal_name",
  "trade_name",
  "tax_responsibilities",
  "tax_scheme",
  "country_code",
  "department_code",
  "municipality_code",
  "address_line",
  "postal_code",
  "invoice_email",
  "phone_cc",
  "phone"
from core.parties
where deleted_at is null
  and core.party_scope_allows((select kernel.party_scope()), kind);
grant select on core.v_party_fiscal to authenticated;
comment on view core.v_party_fiscal is
  'Published for invoicing (rule 3): the fiscal identity an electronic invoice carries (CUFE, UBL). Unmasked, security_invoker (core RLS, record read and party scope as the caller).';
