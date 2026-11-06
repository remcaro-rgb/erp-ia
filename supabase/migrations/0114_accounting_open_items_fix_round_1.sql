-- 0114_accounting_open_items_fix_round_1
-- Forward-only migration (rule 34), plan 2B Task 22 review fix round 1. Covered by
-- packages/modules/accounting/src/__tests__/open-items-allocations.integration.test.ts. Re-runnable (create or replace, revoke, grant).
--
-- accounting.open_items_allocated (0112) is replaced, same signature:
--   * SECURITY DEFINER. It returns nothing unless p_company is one of the caller's companies, reads every table filtered by p_company,
--     and still takes account visibility from the caller's claims (accounting.hidden_account_ids for the active company,
--     accounting.can_view_account otherwise). The two functions payments and invoicing published for it in 0112,
--     payments.ledger_allocations and invoicing.ledger_note_invoices, are no longer callable by authenticated or service_role: only their
--     owner (the owner of this definer) runs them, so no member can list receipt → invoice → amount directly.
--   * Withholdings suffered are not customer items (owner ruling 2026-11-05, recorded in design §22 by the owner): the accounts mapped to a
--     withholding_*_suffered role, and their descendants by code (e.g. 135515), are left out of the receivable items in allocations
--     mode. FIFO mode is unchanged (it still lists them, the 0033 behaviour).
--   * A debit note is a document OF ITS INVOICE (its line takes the invoice id through invoicing.ledger_note_invoices), so a receipt that
--     allocates the invoice settles the invoice and its debit note, and nothing spills onto an older invoice.
--   * A reversal line is an application only when it is aimed at an invoice (a reversal of an allocated receipt, of a mapped note or of an
--     invoice). An unaimed reversal debit (the reversal of a receipt with no allocations, e.g. a ledger posted from events) is a document,
--     as FIFO has it, so a ledger with no allocations gives FIFO's documents exactly.
--   * What an invoice receives beyond its documents (a credit note on a paid invoice, a refund) is a 'credit' item of the account and party
--     at once, never a FIFO application onto other invoices. Unaimed applications still go FIFO; what they leave beyond every document is
--     added to that credit item.
--   * A net debit left over (the aimed applications of an invoice are a net debit with no document to add it to) is a 'document' item with
--     no comprobante (entry_id null), so the items always add up to the ledger balance.
--   * A receipt's line is split over its allocations in cents by largest remainder: the shares add up to the line exactly (with the
--     whole credit or its reversal, each share is exactly the allocation's amount, as before).
--   * Hash joins only (set enable_nestloop = off on the function): the generic plan of a SQL function estimates the published functions and
--     the CTEs at a few rows and nested-looped over them. Measured locally on 40 000 receivable lines (20 000 invoices, 20 000 allocated
--     receipts): 14 s with nested loops, 0,24 s without (0112's version: 0,16 s, with fewer joins).
--   * A caller with no claims (the service role, a script) has no company: accounting.open_items_follow_allocations answers false and
--     open_items is FIFO, as for a company without payments.

create or replace function accounting.open_items_allocated(p_company uuid, p_as_of date)
returns table (
  company_id uuid, account_id uuid, party_id uuid, entry_id uuid, line_no int,
  date date, due_date date, original numeric, open numeric, kind text
)
language sql stable security definer
set search_path = ''
-- The CTEs over the published functions are estimated at a few rows; a nested loop over them is quadratic on a large ledger (14 s on 40 000
-- lines locally): hash joins only (0,24 s).
set enable_nestloop = off
as $$
  with member as (
    select array[p_company] <@ kernel.current_company_ids() as ok
  ),
  groups as (
    select distinct left(a.code, 2) as grp
    from accounting.account_role_mappings m
    join accounting.accounts a on a.id = m.account_id
    where m.company_id = p_company and (m.role = 'receivable' or m.role like '%\_receivable')
  ),
  withholding_accounts as (
    select distinct d.id
    from accounting.account_role_mappings m
    join accounting.accounts a on a.id = m.account_id
    join accounting.accounts d on d.company_id = p_company and d.code like a.code || '%'
    where m.company_id = p_company and m.role like 'withholding\_%\_suffered'
  ),
  allocations as (
    select a.receipt_id, a.invoice_id, a.amount, sum(a.amount) over (partition by a.receipt_id) as receipt_total
    from payments.ledger_allocations(p_company) a
    where (select ok from member)
  ),
  allocated_receipts as (
    select distinct receipt_id from allocations
  ),
  note_invoices as (
    select n.note_id, n.invoice_id from invoicing.ledger_note_invoices(p_company) n where (select ok from member)
  ),
  raw as (
    select l.account_id, l.party_id, l.entry_id, l.line_no, e.date, l.due_date, e.seq as entry_seq,
           l.debit - l.credit as net, e.source_entity, e.source_record_id, e.reversal_of_id is not null as is_reversal,
           case when e.source_entity = 'invoicing.invoice' then e.source_record_id
                when e.source_entity = 'invoicing.note' then ni.invoice_id end as invoice_id,
           (e.source_entity is not distinct from 'invoicing.invoice' or ni.invoice_id is not null or ar.receipt_id is not null) as aimed
    from accounting.entry_lines l
    join accounting.entries e on e.id = l.entry_id and e.company_id = p_company
    join accounting.accounts a on a.id = l.account_id and a.company_id = p_company
    join groups g on g.grp = left(a.code, 2)
    left join note_invoices ni on e.source_entity = 'invoicing.note' and ni.note_id = e.source_record_id
    left join allocated_receipts ar on e.source_entity = 'payments.receipt' and ar.receipt_id = e.source_record_id
    where (select ok from member)
      and l.company_id = p_company and a.requires_party and l.party_id is not null
      and e.status in ('posted', 'reversed') and e.date <= p_as_of
      and not exists (select 1 from withholding_accounts w where w.id = l.account_id)
      and case when p_company = (select kernel.current_company_id()) then l.account_id <> all ((select accounting.hidden_account_ids())::uuid[])
               else accounting.can_view_account(l.account_id) end
  ),
  lines as (
    select r.*, (r.net > 0 and (not r.is_reversal or not r.aimed)) as is_doc from raw r
  ),
  apps as (
    select account_id, party_id, entry_id, line_no, source_entity, source_record_id, invoice_id, aimed, -net as amount
    from lines where not is_doc and net <> 0
  ),
  -- A receipt's line over its allocations: each share in cents, the cents the floors leave going to the largest remainders.
  receipt_shares as (
    select ap.account_id, ap.party_id, ap.entry_id, ap.line_no, al.invoice_id, sign(ap.amount) as sign, abs(ap.amount) as line_amount,
           case when abs(ap.amount) = al.receipt_total then al.amount else abs(ap.amount) * al.amount / al.receipt_total end as exact
    from apps ap join allocations al on al.receipt_id = ap.source_record_id
    where ap.source_entity = 'payments.receipt' and ap.aimed and al.receipt_total > 0
  ),
  receipt_floors as (
    select s.*, floor(s.exact * 100) / 100 as base,
           row_number() over (partition by s.entry_id, s.line_no order by s.exact - floor(s.exact * 100) / 100 desc, s.invoice_id) as rank,
           round((s.line_amount - sum(floor(s.exact * 100) / 100) over (partition by s.entry_id, s.line_no)) * 100) as cents_left
    from receipt_shares s
  ),
  aimed as (
    select account_id, party_id, invoice_id, amount
    from apps where aimed and source_entity in ('invoicing.invoice', 'invoicing.note') and invoice_id is not null
    union all
    select account_id, party_id, invoice_id, (sign * (base + case when rank <= cents_left then 0.01 else 0 end))::numeric(18,4)
    from receipt_floors
  ),
  aimed_totals as (
    select account_id, party_id, invoice_id, sum(amount) as total from aimed group by account_id, party_id, invoice_id
  ),
  unaimed_totals as (
    select account_id, party_id, sum(amount) as total from apps where not aimed group by account_id, party_id
  ),
  docs as (
    select account_id, party_id, entry_id, line_no, date, due_date, entry_seq, net as amount, invoice_id from lines where is_doc
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
  -- What each invoice received beyond its documents (over: a credit at once) or as a net debit with no document (under: back to the pool).
  leftovers as (
    select t.account_id, t.party_id,
           sum(greatest(t.total - coalesce(s.settled, 0), 0)) as over,
           sum(least(t.total - coalesce(s.settled, 0), 0)) as under
    from aimed_totals t
    left join (select account_id, party_id, invoice_id, sum(settled) as settled from matched where invoice_id is not null
               group by account_id, party_id, invoice_id) s
      on s.account_id = t.account_id and s.party_id = t.party_id and s.invoice_id = t.invoice_id
    group by t.account_id, t.party_id
  ),
  rests as (
    select account_id, party_id, sum(rest) as rest from residual group by account_id, party_id
  ),
  pool as (
    select k.account_id, k.party_id,
           coalesce(u.total, 0) + coalesce(lo.under, 0) as amount, coalesce(lo.over, 0) as over, coalesce(r.rest, 0) as rest
    from (select distinct account_id, party_id from lines) k
    left join unaimed_totals u on u.account_id = k.account_id and u.party_id = k.party_id
    left join leftovers lo on lo.account_id = k.account_id and lo.party_id = k.party_id
    left join rests r on r.account_id = k.account_id and r.party_id = k.party_id
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
         greatest(0, r.rest - greatest(0, coalesce(p.amount, 0) - r.rest_before)), 'document'
  from residual r
  left join pool p on p.account_id = r.account_id and p.party_id = r.party_id
  union all
  select p_company, p.account_id, p.party_id, null, null, p_as_of, null,
         -(p.over + greatest(0, p.amount - p.rest)), -(p.over + greatest(0, p.amount - p.rest)), 'credit'
  from pool p
  where p.over + greatest(0, p.amount - p.rest) > 0
  union all
  select p_company, p.account_id, p.party_id, null, null, p_as_of, null, -p.amount, -p.amount, 'document'
  from pool p
  where p.amount < 0
  union all
  select p_company, l.account_id, l.party_id, null, null, max(e.date), null, sum(l.debit - l.credit), sum(l.debit - l.credit), 'advance'
  from accounting.entry_lines l
  join accounting.entries e on e.id = l.entry_id and e.company_id = p_company
  join advance_accounts aa on aa.id = l.account_id
  where (select ok from member)
    and l.company_id = p_company and l.party_id is not null
    and e.status in ('posted', 'reversed') and e.date <= p_as_of
    and case when p_company = (select kernel.current_company_id()) then l.account_id <> all ((select accounting.hidden_account_ids())::uuid[])
             else accounting.can_view_account(l.account_id) end
  group by l.account_id, l.party_id
  having sum(l.credit - l.debit) > 0
$$;
revoke execute on function accounting.open_items_allocated(uuid, date) from public, anon;
grant execute on function accounting.open_items_allocated(uuid, date) to authenticated, service_role;
comment on function accounting.open_items_allocated(uuid, date) is
  'The receivable open items of a company with payments, from the allocations (0112, 0114). Definer; nothing unless p_company is one of the caller''s companies; account visibility from the caller''s claims.';

-- The published inputs are the definer's only: no member reads receipt → invoice → amount directly.
revoke execute on function payments.ledger_allocations(uuid) from public, anon, authenticated, service_role;
revoke execute on function invoicing.ledger_note_invoices(uuid) from public, anon, authenticated, service_role;
comment on function payments.ledger_allocations(uuid) is
  'Published for accounting (rule 3): receipt → invoice → amount of every allocation of a company the caller belongs to. Definer, executable only by its owner (accounting.open_items_allocated).';
comment on function invoicing.ledger_note_invoices(uuid) is
  'Published for accounting (rule 3): note → invoice of every note of a company the caller belongs to. Definer, executable only by its owner (accounting.open_items_allocated).';

comment on function accounting.open_items_follow_allocations(uuid) is
  'Whether the receivable open items of a company follow the payments allocations: its payments module is on (kernel.entitled, module:payments). False for a company the caller does not belong to, and for a caller with no claims.';
