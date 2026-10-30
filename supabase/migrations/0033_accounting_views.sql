-- Accounting · published views (design §4.12, §4.16, §5.11, §5.13; plan Task 17).
-- Every view is security_invoker: the caller's RLS applies to the tables underneath, so company B reads nothing of company A.
-- Lines of a restricted account are filtered or masked with accounting.can_view_account (§5.13) in every view that carries them.
-- "Posted" lines are those of entries in status posted or reversed: a reversed comprobante keeps its effect until its reversal
-- (itself posted) cancels it, so balances and open items stay exact.

-- ---------------------------------------------------------------------------------------------
-- v_entry_lines: the masked view of 0032 redefined. A restricted line keeps its row (line_no, entry_id) so the record shows
-- "••••" and the comprobante totals stay, but every figure and every link that could identify the account is null and
-- is_restricted is true. The where clause is deliberately absent. The generated masking of 0032 is kept (rule 14).
-- ---------------------------------------------------------------------------------------------
create or replace view accounting.v_entry_lines with (security_invoker = true) as
select
  "id",
  "company_id",
  case when (select kernel.field_visible('accounting.entry_line', 'seq')) then "seq" else null end as "seq",
  case when (select kernel.field_visible('accounting.entry_line', 'entry_id')) then "entry_id" else null end as "entry_id",
  case when (select kernel.field_visible('accounting.entry_line', 'line_no')) then "line_no" else null end as "line_no",
  case when (select kernel.field_visible('accounting.entry_line', 'account_id')) and "can_view" then "account_id" else null end as "account_id",
  case when (select kernel.field_visible('accounting.entry_line', 'party_id')) and "can_view" then "party_id" else null end as "party_id",
  case when (select kernel.field_visible('accounting.entry_line', 'cost_center_id')) and "can_view" then "cost_center_id" else null end as "cost_center_id",
  case when (select kernel.field_visible('accounting.entry_line', 'open_auxiliary_id')) and "can_view" then "open_auxiliary_id" else null end as "open_auxiliary_id",
  case when (select kernel.field_visible('accounting.entry_line', 'item_id')) and "can_view" then "item_id" else null end as "item_id",
  case when (select kernel.field_visible('accounting.entry_line', 'business_unit_id')) and "can_view" then "business_unit_id" else null end as "business_unit_id",
  case when (select kernel.field_visible('accounting.entry_line', 'description')) and "can_view" then "description" else null end as "description",
  case when (select kernel.field_visible('accounting.entry_line', 'debit')) and "can_view" then "debit" else null end as "debit",
  case when (select kernel.field_visible('accounting.entry_line', 'credit')) and "can_view" then "credit" else null end as "credit",
  case when (select kernel.field_visible('accounting.entry_line', 'debit_doc')) and "can_view" then "debit_doc" else null end as "debit_doc",
  case when (select kernel.field_visible('accounting.entry_line', 'credit_doc')) and "can_view" then "credit_doc" else null end as "credit_doc",
  case when (select kernel.field_visible('accounting.entry_line', 'tax_code')) and "can_view" then "tax_code" else null end as "tax_code",
  case when (select kernel.field_visible('accounting.entry_line', 'tax_rate')) and "can_view" then "tax_rate" else null end as "tax_rate",
  case when (select kernel.field_visible('accounting.entry_line', 'tax_base')) and "can_view" then "tax_base" else null end as "tax_base",
  case when (select kernel.field_visible('accounting.entry_line', 'reference')) and "can_view" then "reference" else null end as "reference",
  case when (select kernel.field_visible('accounting.entry_line', 'due_date')) and "can_view" then "due_date" else null end as "due_date",
  case when (select kernel.field_visible('accounting.entry_line', 'extra')) then kernel.mask_extra('accounting.entry_line', "extra") else null end as "extra",
  case when (select kernel.field_visible('accounting.entry_line', 'extra_free')) then "extra_free" else null end as "extra_free",
  "created_at",
  "updated_at",
  not "can_view" as "is_restricted"
from (select el.*, accounting.can_view_account(el.account_id) as can_view from accounting.entry_lines el) as entry_lines;
grant select on accounting.v_entry_lines to authenticated;

-- ---------------------------------------------------------------------------------------------
-- Indexes used by the FIFO of open items and by the balances.
-- ---------------------------------------------------------------------------------------------
create index if not exists entry_lines_open_items_idx on accounting.entry_lines (company_id, account_id, party_id) where party_id is not null;

-- ---------------------------------------------------------------------------------------------
-- v_account_balances (§4.12): posted lines aggregated per period, account, party and the four dimensions. is_opening and
-- is_closing are added at the end so reports can leave out opening and year-close comprobantes (§4.6).
-- ---------------------------------------------------------------------------------------------
create or replace view accounting.v_account_balances with (security_invoker = true) as
select
  l.company_id,
  e.period_id,
  l.account_id,
  l.party_id,
  l.cost_center_id,
  l.open_auxiliary_id,
  l.item_id,
  l.business_unit_id,
  sum(l.debit)  as debit,
  sum(l.credit) as credit,
  e.is_opening,
  e.is_closing
from accounting.entry_lines l
join accounting.entries e on e.id = l.entry_id
where e.status in ('posted', 'reversed') and accounting.can_view_account(l.account_id)
group by l.company_id, e.period_id, l.account_id, l.party_id, l.cost_center_id, l.open_auxiliary_id, l.item_id, l.business_unit_id, e.is_opening, e.is_closing;
grant select on accounting.v_account_balances to authenticated;

-- ---------------------------------------------------------------------------------------------
-- v_entries_for_source (§4.12): the "Contabilidad" tab of any document.
-- ---------------------------------------------------------------------------------------------
create or replace view accounting.v_entries_for_source with (security_invoker = true) as
select
  e.company_id,
  e.source_entity,
  e.source_record_id,
  e.id as entry_id,
  e.number,
  e.date,
  e.status,
  e.total_debit
from accounting.entries e
where e.source_record_id is not null;
grant select on accounting.v_entries_for_source to authenticated;

-- ---------------------------------------------------------------------------------------------
-- v_tax_lines (§4.12): tax and withholding lines of posted comprobantes, for exógena and certificates.
-- ---------------------------------------------------------------------------------------------
create or replace view accounting.v_tax_lines with (security_invoker = true) as
select
  l.company_id,
  l.entry_id,
  e.date,
  l.party_id,
  l.tax_code,
  l.tax_base,
  l.debit,
  l.credit
from accounting.entry_lines l
join accounting.entries e on e.id = l.entry_id
where l.tax_code is not null and e.status in ('posted', 'reversed') and accounting.can_view_account(l.account_id);
grant select on accounting.v_tax_lines to authenticated;

-- ---------------------------------------------------------------------------------------------
-- open_items (§4.12, §5.11): receivable and payable lines with their unapplied amount, by FIFO per party and account.
-- A receivable account is one that requires a party and sits in the PUC group (first two digits) of an account mapped to a role
-- `receivable` or `*_receivable`; a payable account likewise for `payable` or `*_payable`. The groups come from the company's
-- role mappings, so no chart code is written here. On a receivable account debits are the documents and credits the applications
-- (receipts, credit notes); on a payable account credits are the documents and debits the applications. Applications are spread
-- over the documents oldest due date first (due date, else date). An application beyond the documents (an advance) opens nothing.
-- Rows of a restricted account the caller cannot view are left out.
-- ---------------------------------------------------------------------------------------------
create or replace function accounting.open_items(p_company uuid, p_as_of date)
returns table (
  company_id uuid, account_id uuid, party_id uuid, entry_id uuid, line_no int,
  date date, due_date date, original numeric, open numeric
)
language sql stable
set search_path = ''
as $$
  with groups as (
    select distinct left(a.code, 2) as grp, (m.role = 'receivable' or m.role like '%\_receivable') as is_receivable
    from accounting.account_role_mappings m
    join accounting.accounts a on a.id = m.account_id
    where m.company_id = p_company
      and (m.role = 'receivable' or m.role like '%\_receivable' or m.role = 'payable' or m.role like '%\_payable')
  ),
  lines as (
    select l.company_id, l.account_id, l.party_id, l.entry_id, l.line_no, e.date, l.due_date, e.seq as entry_seq,
           case when g.is_receivable then l.debit else l.credit end as doc_amount,
           case when g.is_receivable then l.credit else l.debit end as applied_amount
    from accounting.entry_lines l
    join accounting.entries e on e.id = l.entry_id
    join accounting.accounts a on a.id = l.account_id
    join groups g on g.grp = left(a.code, 2)
    where l.company_id = p_company and a.requires_party and l.party_id is not null
      and e.status in ('posted', 'reversed') and e.date <= p_as_of
      and accounting.can_view_account(l.account_id)
  ),
  applied as (
    select account_id, party_id, sum(applied_amount) as total from lines group by account_id, party_id
  ),
  docs as (
    select d.*, sum(d.doc_amount) over (
      partition by d.account_id, d.party_id order by coalesce(d.due_date, d.date), d.date, d.entry_seq, d.line_no
      rows between unbounded preceding and 1 preceding
    ) as before_amount
    from lines d where d.doc_amount > 0
  )
  select d.company_id, d.account_id, d.party_id, d.entry_id, d.line_no, d.date, d.due_date,
         d.doc_amount as original,
         greatest(0, d.doc_amount - greatest(0, coalesce(a.total, 0) - coalesce(d.before_amount, 0))) as open
  from docs d
  left join applied a on a.account_id = d.account_id and a.party_id = d.party_id
$$;
revoke execute on function accounting.open_items(uuid, date) from public, anon;
grant execute on function accounting.open_items(uuid, date) to authenticated, service_role;

create or replace view accounting.v_open_items with (security_invoker = true) as
select o.company_id, o.account_id, o.party_id, o.entry_id, o.line_no, o.date, o.due_date, o.original, o.open
from accounting.open_items((select kernel.current_company_id()), current_date) o;
grant select on accounting.v_open_items to authenticated;

-- ---------------------------------------------------------------------------------------------
-- ledger_lines (base) and v_ledger_lines (masked, §4.16): every field of a comprobante line as one column, posted and unposted
-- lines both. The base view joins the line with its comprobante, Fuente, account, party (through the published core.v_parties)
-- and the four dimensions, and keeps only lines whose account the caller may view. v_ledger_lines is the maskedViewSql output of
-- the accounting.ledger_line entity over it (views.test.ts guards the drift).
-- ---------------------------------------------------------------------------------------------
create or replace view accounting.ledger_lines with (security_invoker = true) as
select
  l.id,
  l.company_id,
  l.entry_id,
  e.number,
  e.date,
  e.period_id,
  coalesce(fy.year, extract(year from e.date)::int) as fiscal_year,
  e.journal_id,
  j.code as journal_code,
  e.status,
  e.origin,
  e.created_by,
  e.posted_by,
  e.posted_at,
  e.source_entity,
  e.source_record_id,
  case when e.source_record_id is not null then coalesce(e.source_entity, '') || ':' || e.source_record_id::text end as source_ref,
  e.posting_rule_id,
  e.description as entry_description,
  l.line_no,
  l.description,
  l.reference,
  l.account_id,
  a.code as account_code,
  a.name as account_name,
  left(a.code, 1) as account_class,
  left(a.code, 2) as account_group,
  a.level as account_level,
  l.party_id,
  p.document_number as party_document,
  p.legal_name as party_name,
  l.cost_center_id,
  cc.code as cost_center_code,
  cc.name as cost_center_name,
  l.open_auxiliary_id,
  oa.code as open_auxiliary_code,
  oa.name as open_auxiliary_name,
  l.item_id,
  it.code as item_code,
  it.name as item_name,
  l.business_unit_id,
  bu.code as business_unit_code,
  bu.name as business_unit_name,
  l.debit,
  l.credit,
  l.debit - l.credit as net,
  case when a.nature = 'debit' then l.debit - l.credit else l.credit - l.debit end as signed_net,
  l.tax_code,
  l.tax_base,
  l.due_date,
  e.reversal_of_id,
  e.reversed_by_id,
  e.is_opening,
  e.is_closing,
  e.reverse_on
from accounting.entry_lines l
join accounting.entries e on e.id = l.entry_id
join accounting.journals j on j.id = e.journal_id
join accounting.accounts a on a.id = l.account_id
left join accounting.periods per on per.id = e.period_id
left join accounting.fiscal_years fy on fy.id = per.fiscal_year_id
left join core.v_parties p on p.id = l.party_id
left join accounting.cost_centers cc on cc.id = l.cost_center_id
left join accounting.open_auxiliaries oa on oa.id = l.open_auxiliary_id
left join accounting.items it on it.id = l.item_id
left join accounting.business_units bu on bu.id = l.business_unit_id
where accounting.can_view_account(l.account_id);
grant select on accounting.ledger_lines to authenticated;

create or replace view accounting.v_ledger_lines with (security_invoker = true) as
select
  "id",
  "company_id",
  case when (select kernel.field_visible('accounting.ledger_line', 'entry_id')) then "entry_id" else null end as "entry_id",
  case when (select kernel.field_visible('accounting.ledger_line', 'number')) then "number" else null end as "number",
  case when (select kernel.field_visible('accounting.ledger_line', 'date')) then "date" else null end as "date",
  case when (select kernel.field_visible('accounting.ledger_line', 'period_id')) then "period_id" else null end as "period_id",
  case when (select kernel.field_visible('accounting.ledger_line', 'fiscal_year')) then "fiscal_year" else null end as "fiscal_year",
  case when (select kernel.field_visible('accounting.ledger_line', 'journal_id')) then "journal_id" else null end as "journal_id",
  case when (select kernel.field_visible('accounting.ledger_line', 'journal_code')) then "journal_code" else null end as "journal_code",
  case when (select kernel.field_visible('accounting.ledger_line', 'status')) then "status" else null end as "status",
  case when (select kernel.field_visible('accounting.ledger_line', 'origin')) then "origin" else null end as "origin",
  "created_by",
  case when (select kernel.field_visible('accounting.ledger_line', 'posted_by')) then "posted_by" else null end as "posted_by",
  case when (select kernel.field_visible('accounting.ledger_line', 'posted_at')) then "posted_at" else null end as "posted_at",
  case when (select kernel.field_visible('accounting.ledger_line', 'source_entity')) then "source_entity" else null end as "source_entity",
  case when (select kernel.field_visible('accounting.ledger_line', 'source_record_id')) then "source_record_id" else null end as "source_record_id",
  case when (select kernel.field_visible('accounting.ledger_line', 'source_ref')) then "source_ref" else null end as "source_ref",
  case when (select kernel.field_visible('accounting.ledger_line', 'posting_rule_id')) then "posting_rule_id" else null end as "posting_rule_id",
  case when (select kernel.field_visible('accounting.ledger_line', 'entry_description')) then "entry_description" else null end as "entry_description",
  case when (select kernel.field_visible('accounting.ledger_line', 'line_no')) then "line_no" else null end as "line_no",
  case when (select kernel.field_visible('accounting.ledger_line', 'description')) then "description" else null end as "description",
  case when (select kernel.field_visible('accounting.ledger_line', 'reference')) then "reference" else null end as "reference",
  case when (select kernel.field_visible('accounting.ledger_line', 'account_id')) then "account_id" else null end as "account_id",
  case when (select kernel.field_visible('accounting.ledger_line', 'account_code')) then "account_code" else null end as "account_code",
  case when (select kernel.field_visible('accounting.ledger_line', 'account_name')) then "account_name" else null end as "account_name",
  case when (select kernel.field_visible('accounting.ledger_line', 'account_class')) then "account_class" else null end as "account_class",
  case when (select kernel.field_visible('accounting.ledger_line', 'account_group')) then "account_group" else null end as "account_group",
  case when (select kernel.field_visible('accounting.ledger_line', 'account_level')) then "account_level" else null end as "account_level",
  case when (select kernel.field_visible('accounting.ledger_line', 'party_id')) then "party_id" else null end as "party_id",
  case when (select kernel.field_visible('accounting.ledger_line', 'party_document')) then "party_document" else null end as "party_document",
  case when (select kernel.field_visible('accounting.ledger_line', 'party_name')) then "party_name" else null end as "party_name",
  case when (select kernel.field_visible('accounting.ledger_line', 'cost_center_id')) then "cost_center_id" else null end as "cost_center_id",
  case when (select kernel.field_visible('accounting.ledger_line', 'cost_center_code')) then "cost_center_code" else null end as "cost_center_code",
  case when (select kernel.field_visible('accounting.ledger_line', 'cost_center_name')) then "cost_center_name" else null end as "cost_center_name",
  case when (select kernel.field_visible('accounting.ledger_line', 'open_auxiliary_id')) then "open_auxiliary_id" else null end as "open_auxiliary_id",
  case when (select kernel.field_visible('accounting.ledger_line', 'open_auxiliary_code')) then "open_auxiliary_code" else null end as "open_auxiliary_code",
  case when (select kernel.field_visible('accounting.ledger_line', 'open_auxiliary_name')) then "open_auxiliary_name" else null end as "open_auxiliary_name",
  case when (select kernel.field_visible('accounting.ledger_line', 'item_id')) then "item_id" else null end as "item_id",
  case when (select kernel.field_visible('accounting.ledger_line', 'item_code')) then "item_code" else null end as "item_code",
  case when (select kernel.field_visible('accounting.ledger_line', 'item_name')) then "item_name" else null end as "item_name",
  case when (select kernel.field_visible('accounting.ledger_line', 'business_unit_id')) then "business_unit_id" else null end as "business_unit_id",
  case when (select kernel.field_visible('accounting.ledger_line', 'business_unit_code')) then "business_unit_code" else null end as "business_unit_code",
  case when (select kernel.field_visible('accounting.ledger_line', 'business_unit_name')) then "business_unit_name" else null end as "business_unit_name",
  case when (select kernel.field_visible('accounting.ledger_line', 'debit')) then "debit" else null end as "debit",
  case when (select kernel.field_visible('accounting.ledger_line', 'credit')) then "credit" else null end as "credit",
  case when (select kernel.field_visible('accounting.ledger_line', 'net')) then "net" else null end as "net",
  case when (select kernel.field_visible('accounting.ledger_line', 'signed_net')) then "signed_net" else null end as "signed_net",
  case when (select kernel.field_visible('accounting.ledger_line', 'tax_code')) then "tax_code" else null end as "tax_code",
  case when (select kernel.field_visible('accounting.ledger_line', 'tax_base')) then "tax_base" else null end as "tax_base",
  case when (select kernel.field_visible('accounting.ledger_line', 'due_date')) then "due_date" else null end as "due_date",
  case when (select kernel.field_visible('accounting.ledger_line', 'reversal_of_id')) then "reversal_of_id" else null end as "reversal_of_id",
  case when (select kernel.field_visible('accounting.ledger_line', 'reversed_by_id')) then "reversed_by_id" else null end as "reversed_by_id",
  case when (select kernel.field_visible('accounting.ledger_line', 'is_opening')) then "is_opening" else null end as "is_opening",
  case when (select kernel.field_visible('accounting.ledger_line', 'is_closing')) then "is_closing" else null end as "is_closing",
  case when (select kernel.field_visible('accounting.ledger_line', 'reverse_on')) then "reverse_on" else null end as "reverse_on"
from accounting.ledger_lines;
grant select on accounting.v_ledger_lines to authenticated;
