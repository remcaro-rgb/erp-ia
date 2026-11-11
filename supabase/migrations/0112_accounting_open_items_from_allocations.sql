-- 0112_accounting_open_items_from_allocations
-- Forward-only migration (rule 34). Covered by packages/modules/accounting/src/__tests__/open-items-allocations.integration.test.ts (a company
-- with payments) and, unchanged, by views.integration.test.ts and reports-controls.integration.test.ts (a company without payments: FIFO).
--
-- Open items from allocations (plan 2B Task 22; accounting design §4.12, §5.11 «when its allocations exist, v_open_items reads them instead
-- of FIFO, so the report does not change»; main design §22.17).
--
--   * accounting.open_items gains a last column `kind`: 'document' (a receivable or payable line and what is still open of it, as before),
--     'credit' (what the applications of a party and receivable account leave beyond every document: a saldo a favor, negative) and
--     'advance' (the party's net credit on the accounts mapped to customer_advances, negative). The signature changes, so the function and
--     accounting.v_open_items are dropped and created again (control_party_balances reads the function by name and is not touched).
--   * A company whose payments module is on (kernel.entitled(company, 'module:payments'): entitled and not switched off in
--     kernel.company_modules) gets its RECEIVABLE items from accounting.open_items_allocated; its payables, and every item of a company
--     without payments, come from accounting.open_items_fifo, the FIFO of 0033 verbatim (restricted to the payable groups when the other
--     branch answers the receivable ones). Switching payments off goes back to FIFO; nothing is stored.
--   * open_items_allocated, over the same lines FIFO reads (posted, dated up to as_of, receivable groups, party required, account visible):
--       - a document is a line whose net is a debit and that is not a reversal;
--       - every other line is an application of credit − debit (a reversal's lines too, so a reversal cancels what its original did);
--       - an application is aimed at an invoice by its comprobante's source: an invoicing.invoice's own id; an invoicing.note's invoice
--         (invoicing.ledger_note_invoices); a payments.receipt's allocations (payments.ledger_allocations), the line split over them in
--         their proportion (exactly each allocation's amount when the line is the receipt's whole credit or its reversal);
--       - what is aimed at an invoice settles that invoice's documents on the same account and party, earliest due date first; what is not
--         aimed (a manual entry), or exceeds the invoice, applies FIFO by due date over what the documents still owe, like 0033; what is
--         left beyond every document is one 'credit' item of the account and party (so the items add up to the ledger balance);
--       - an advance (Cr customer_advances, the remainder of a receipt) settles nothing: the party's net credit on the accounts mapped to
--         customer_advances (and their descendants by code) outside the receivable groups is one 'advance' item.
--     Set-based: one pass over the lines, hash joins to the published allocations and notes, window sums; no per-row subselect.
--   * Account visibility once per statement (the 0057 / 0059 pattern), in FIFO too: for the active company a line's account is tested
--     against accounting.hidden_account_ids() (an InitPlan) instead of accounting.can_view_account per line (same rule, §5.13); another
--     company (a definer caller passing one) keeps can_view_account. FIFO's results do not change. Measured locally on 40 000 receivable
--     lines (20 000 invoices, 20 000 allocated receipts): FIFO 6,6 s → 0,08 s, allocations 6,6 s → 0,16 s.
--   * Rule 3: accounting reads payments and invoicing only through what they publish here, two security definer functions answering the
--     caller's own companies only (like payments.allocated_amounts), so the open items do not depend on whether the caller may read the
--     receipts or the notes (the ledger and its account permissions decide, as in FIFO). No foreign key crosses a schema.

-- ---------------------------------------------------------------------------------------------
-- Published by payments for accounting (rule 3): what every receipt of the company applied to each invoice, whatever its state (the
-- ledger says whether the receipt still counts at a date: a voided receipt's reversal cancels it).
-- ---------------------------------------------------------------------------------------------
create or replace function payments.ledger_allocations(p_company uuid)
returns table (receipt_id uuid, invoice_id uuid, amount numeric)
language sql stable security definer
set search_path = ''
as $$
  select a.receipt_id, a.invoice_id, a.amount
  from payments.receipt_allocations a
  where a.company_id = p_company and array[p_company] <@ kernel.current_company_ids();
$$;
revoke execute on function payments.ledger_allocations(uuid) from public, anon;
grant execute on function payments.ledger_allocations(uuid) to authenticated, service_role;
comment on function payments.ledger_allocations(uuid) is
  'Published for accounting (rule 3): receipt → invoice → amount of every allocation of a company the caller belongs to. Definer.';

-- ---------------------------------------------------------------------------------------------
-- Published by invoicing for accounting (rule 3): the invoice of every note of the company (credit, debit and annulment).
-- ---------------------------------------------------------------------------------------------
create or replace function invoicing.ledger_note_invoices(p_company uuid)
returns table (note_id uuid, invoice_id uuid)
language sql stable security definer
set search_path = ''
as $$
  select n.id, n.invoice_id
  from invoicing.notes n
  where n.company_id = p_company and array[p_company] <@ kernel.current_company_ids();
$$;
revoke execute on function invoicing.ledger_note_invoices(uuid) from public, anon;
grant execute on function invoicing.ledger_note_invoices(uuid) to authenticated, service_role;
comment on function invoicing.ledger_note_invoices(uuid) is
  'Published for accounting (rule 3): note → invoice of every note of a company the caller belongs to. Definer.';

-- ---------------------------------------------------------------------------------------------
-- Whether the company's open items follow the payments allocations: its payments module is on. Definer (kernel.entitled is the service
-- role's); answers only for a company the caller belongs to, false otherwise.
-- ---------------------------------------------------------------------------------------------
create or replace function accounting.open_items_follow_allocations(p_company uuid) returns boolean
language sql stable security definer
set search_path = ''
as $$
  select coalesce(array[p_company] <@ kernel.current_company_ids() and kernel.entitled(p_company, 'module:payments'), false);
$$;
revoke execute on function accounting.open_items_follow_allocations(uuid) from public, anon;
grant execute on function accounting.open_items_follow_allocations(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- FIFO (0033, same results; account visibility once per statement): receivable and payable lines with their unapplied amount,
-- applications spread over the documents oldest due date first. p_payables_only leaves the receivable groups out (the allocations
-- answer them).
-- ---------------------------------------------------------------------------------------------
create or replace function accounting.open_items_fifo(p_company uuid, p_as_of date, p_payables_only boolean)
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
      and case when p_company = (select kernel.current_company_id()) then l.account_id <> all ((select accounting.hidden_account_ids())::uuid[])
               else accounting.can_view_account(l.account_id) end
      and not (p_payables_only and g.is_receivable)
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
revoke execute on function accounting.open_items_fifo(uuid, date, boolean) from public, anon;
grant execute on function accounting.open_items_fifo(uuid, date, boolean) to authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- Receivable open items from the allocations (a company with payments). See the header for the computation.
-- ---------------------------------------------------------------------------------------------
create or replace function accounting.open_items_allocated(p_company uuid, p_as_of date)
returns table (
  company_id uuid, account_id uuid, party_id uuid, entry_id uuid, line_no int,
  date date, due_date date, original numeric, open numeric, kind text
)
language sql stable
set search_path = ''
as $$
  with groups as (
    select distinct left(a.code, 2) as grp
    from accounting.account_role_mappings m
    join accounting.accounts a on a.id = m.account_id
    where m.company_id = p_company and (m.role = 'receivable' or m.role like '%\_receivable')
  ),
  lines as (
    select l.account_id, l.party_id, l.entry_id, l.line_no, e.date, l.due_date, e.seq as entry_seq,
           l.debit - l.credit as net, e.source_entity, e.source_record_id,
           (l.debit - l.credit > 0 and e.reversal_of_id is null) as is_doc
    from accounting.entry_lines l
    join accounting.entries e on e.id = l.entry_id
    join accounting.accounts a on a.id = l.account_id
    join groups g on g.grp = left(a.code, 2)
    where l.company_id = p_company and a.requires_party and l.party_id is not null
      and e.status in ('posted', 'reversed') and e.date <= p_as_of
      and case when p_company = (select kernel.current_company_id()) then l.account_id <> all ((select accounting.hidden_account_ids())::uuid[])
               else accounting.can_view_account(l.account_id) end
  ),
  apps as (
    select account_id, party_id, source_entity, source_record_id, -net as amount from lines where not is_doc and net <> 0
  ),
  app_totals as (
    select account_id, party_id, sum(amount) as total from apps group by account_id, party_id
  ),
  allocations as (
    select a.receipt_id, a.invoice_id, a.amount, sum(a.amount) over (partition by a.receipt_id) as receipt_total
    from payments.ledger_allocations(p_company) a
  ),
  aimed as (
    select ap.account_id, ap.party_id, ap.source_record_id as invoice_id, ap.amount
    from apps ap where ap.source_entity = 'invoicing.invoice'
    union all
    select ap.account_id, ap.party_id, n.invoice_id, ap.amount
    from apps ap join invoicing.ledger_note_invoices(p_company) n on n.note_id = ap.source_record_id
    where ap.source_entity = 'invoicing.note'
    union all
    select ap.account_id, ap.party_id, al.invoice_id,
           case when abs(ap.amount) = al.receipt_total then sign(ap.amount) * al.amount
                else round(ap.amount * al.amount / al.receipt_total, 4) end
    from apps ap join allocations al on al.receipt_id = ap.source_record_id
    where ap.source_entity = 'payments.receipt' and al.receipt_total > 0
  ),
  aimed_totals as (
    select account_id, party_id, invoice_id, sum(amount) as total from aimed group by account_id, party_id, invoice_id
  ),
  docs as (
    select d.account_id, d.party_id, d.entry_id, d.line_no, d.date, d.due_date, d.entry_seq, d.net as amount,
           case when d.source_entity = 'invoicing.invoice' then d.source_record_id end as invoice_id
    from lines d where d.is_doc
  ),
  matched as (
    select d.*,
           case when d.invoice_id is null then 0
                else least(d.amount, greatest(0, coalesce(t.total, 0) - coalesce(sum(d.amount) over (
                       partition by d.account_id, d.party_id, d.invoice_id order by coalesce(d.due_date, d.date), d.date, d.entry_seq, d.line_no
                       rows between unbounded preceding and 1 preceding), 0))) end as settled
    from docs d
    left join aimed_totals t on t.account_id = d.account_id and t.party_id = d.party_id and t.invoice_id = d.invoice_id
  ),
  residual as (
    select m.*, m.amount - m.settled as rest,
           coalesce(sum(m.amount - m.settled) over (
             partition by m.account_id, m.party_id order by coalesce(m.due_date, m.date), m.date, m.entry_seq, m.line_no
             rows between unbounded preceding and 1 preceding), 0) as rest_before
    from matched m
  ),
  -- What the applications of an account and party leave once the aimed ones settled their invoices: applied FIFO over what is still owed.
  unaimed as (
    select t.account_id, t.party_id, t.total - coalesce(s.settled, 0) as amount, coalesce(s.rest, 0) as rest
    from app_totals t
    left join (select account_id, party_id, sum(settled) as settled, sum(rest) as rest from residual group by account_id, party_id) s
      on s.account_id = t.account_id and s.party_id = t.party_id
  ),
  advance_accounts as (
    select distinct d.id
    from accounting.account_role_mappings m
    join accounting.accounts a on a.id = m.account_id
    join accounting.accounts d on d.company_id = p_company and d.code like a.code || '%'
    where m.company_id = p_company and m.role = 'customer_advances'
      and left(d.code, 2) not in (select grp from groups)
  )
  select p_company, r.account_id, r.party_id, r.entry_id, r.line_no, r.date, r.due_date, r.amount,
         greatest(0, r.rest - greatest(0, coalesce(u.amount, 0) - r.rest_before)), 'document'
  from residual r
  left join unaimed u on u.account_id = r.account_id and u.party_id = r.party_id
  union all
  select p_company, u.account_id, u.party_id, null, null, p_as_of, null, u.rest - u.amount, u.rest - u.amount, 'credit'
  from unaimed u
  where u.amount > u.rest
  union all
  select p_company, l.account_id, l.party_id, null, null, max(e.date), null, sum(l.debit - l.credit), sum(l.debit - l.credit), 'advance'
  from accounting.entry_lines l
  join accounting.entries e on e.id = l.entry_id
  join advance_accounts aa on aa.id = l.account_id
  where l.company_id = p_company and l.party_id is not null
    and e.status in ('posted', 'reversed') and e.date <= p_as_of
    and case when p_company = (select kernel.current_company_id()) then l.account_id <> all ((select accounting.hidden_account_ids())::uuid[])
             else accounting.can_view_account(l.account_id) end
  group by l.account_id, l.party_id
  having sum(l.credit - l.debit) > 0
$$;
revoke execute on function accounting.open_items_allocated(uuid, date) from public, anon;
grant execute on function accounting.open_items_allocated(uuid, date) to authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- open_items: FIFO, or the allocations for the receivables of a company with payments. Same columns as 0033 plus `kind`.
-- ---------------------------------------------------------------------------------------------
drop view accounting.v_open_items;
drop function accounting.open_items(uuid, date);

create function accounting.open_items(p_company uuid, p_as_of date)
returns table (
  company_id uuid, account_id uuid, party_id uuid, entry_id uuid, line_no int,
  date date, due_date date, original numeric, open numeric, kind text
)
language sql stable
set search_path = ''
as $$
  with mode as (select accounting.open_items_follow_allocations(p_company) as allocated)
  select f.company_id, f.account_id, f.party_id, f.entry_id, f.line_no, f.date, f.due_date, f.original, f.open, 'document'::text
  from accounting.open_items_fifo(p_company, p_as_of, (select allocated from mode)) f
  union all
  select a.company_id, a.account_id, a.party_id, a.entry_id, a.line_no, a.date, a.due_date, a.original, a.open, a.kind
  from accounting.open_items_allocated(p_company, p_as_of) a
  where (select allocated from mode)
$$;
revoke execute on function accounting.open_items(uuid, date) from public, anon;
grant execute on function accounting.open_items(uuid, date) to authenticated, service_role;

create view accounting.v_open_items with (security_invoker = true) as
select o.company_id, o.account_id, o.party_id, o.entry_id, o.line_no, o.date, o.due_date, o.original, o.open, o.kind
from accounting.open_items((select kernel.current_company_id()), current_date) o;
grant select on accounting.v_open_items to authenticated;
comment on view accounting.v_open_items is
  'Published (accounting design §4.12): receivable and payable open items at today, FIFO, or from the payments allocations for the receivables of a company with payments (kind document | credit | advance).';
