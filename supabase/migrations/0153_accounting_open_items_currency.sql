-- 0153_accounting_open_items_currency
-- Forward-only migration (rule 34), plan 2B.2 Task 34.7 (FX §5 unrealized, §7, §11; owner items 126 (b), (c), (d) as recommended pending
-- the accountant, and 130, decided 2026-11-09). Covered by packages/modules/accounting/src/__tests__/open-items-currency.integration.test.ts
-- (every peso row equals 0138's, on a harness ledger and on the demo ledger; the split by amount_company; open_doc),
-- fx-revaluation.integration.test.ts (the run, its reversal, rerun, Anular, the close check), aging.integration.test.ts and views.test.ts
-- (the masked views are the generated ones). 0152 is left to plan Task 34.6 (advances in a foreign currency), which waits for the accountant.
--
--   * accounting.fx_revaluations (documento accounting.fx_revaluation) and accounting.fx_revaluation_lines (its lines): one run of
--     accounting.fx_revaluation.run over a period. The run posts one entry at the period's end, «Ajuste por diferencia en cambio», with one
--     receivable line per open foreign-currency invoice (pesos only, no document amount) and the fx_gain / fx_loss lines (fx_kind:unrealized),
--     and its reversal on the first day of the next period, so a later collection always settles at the invoice's own rate. Each line of the
--     documento names the receivable line it wrote and the invoice it adjusts. Written posted by the run, never numbered; a rerun of the
--     period or accounting.fx_revaluation.void voids it (two mirror entries, the same dates). One posted run per company and period.
--   * accounting.open_items_allocated and accounting.open_items gain three columns: `currency` (the document's: the invoice entry's currency;
--     the company's for credit and advance items and for everything FIFO answers), `amount_doc` and `open_doc` in that currency. The result
--     columns change, so both functions and accounting.v_open_items are dropped and created again (same grants and comments).
--   * A receipt's (or an application's) receivable line is split over its allocations by `amount_company`, the pesos each one takes off its
--     invoice at the invoice's rate (0150), not by `amount`, which is in each invoice's own currency: a COP receipt over two USD invoices at
--     two rates splits right. Every row before 0150 has amount_company = amount, so the peso figures are 0138's (pinned by the tests).
--   * open_doc of an invoice item: its dollars (the receivable line's debit_doc − credit_doc) less, in dollars, what its notes credited (their
--     entries are in the invoice's currency, OD-7) and what its allocations settled (`amount`, in the invoice's currency), earliest due date
--     first like the pesos; 0 when its pesos are 0. A company-currency item has open_doc = open.
--   * The receivable lines of a revaluation, of its reversal and of a void's mirrors (the entries whose source is the run, the same line_no
--     as the line the run recorded) are not documents or applications of their own: they add to the pesos of the invoice they adjust (its
--     earliest document), so the adjustment and its reversal attach to that invoice and never become FIFO items.
--   * accounting.period_close_checks takes the check `fx_revaluation` (a warning: «Diferencia en cambio no calculada»).

-- ---------------------------------------------------------------------------------------------
-- The run and its lines.
-- ---------------------------------------------------------------------------------------------
create table if not exists accounting.fx_revaluations (
  id                     uuid primary key default kernel.uuid_v7(),
  seq                    bigint not null,
  company_id             uuid not null references kernel.companies (id),
  period_id              uuid not null references accounting.periods (id),
  date                   date not null,
  closing_rates          jsonb not null default '{}'::jsonb,
  lines_count            int not null default 0 check (lines_count >= 0),
  entry_id               uuid references accounting.entries (id),
  reversal_entry_id      uuid references accounting.entries (id),
  void_entry_id          uuid references accounting.entries (id),
  void_reversal_entry_id uuid references accounting.entries (id),
  voided_at              timestamptz,
  extra                  jsonb not null default '{}'::jsonb,
  extra_free             jsonb not null default '[]'::jsonb,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  created_by             uuid default kernel.current_user_id(),
  updated_by             uuid,
  unique (company_id, seq)
);
create index if not exists fx_revaluations_period_idx on accounting.fx_revaluations (company_id, period_id);

create table if not exists accounting.fx_revaluation_lines (
  id             uuid primary key default kernel.uuid_v7(),
  seq            bigint not null,
  company_id     uuid not null references kernel.companies (id),
  revaluation_id uuid not null references accounting.fx_revaluations (id),
  line_no        int not null check (line_no > 0),
  entry_line_id  uuid not null references accounting.entry_lines (id),
  invoice_id     uuid not null,
  invoice_number text,
  party_id       uuid,
  currency       char(3) not null check (currency ~ '^[A-Z]{3}$'),
  open_doc       numeric(18,4) not null,
  carrying       numeric(18,4) not null,
  closing_rate   numeric(18,6) not null check (closing_rate > 0),
  revalued       numeric(18,4) not null,
  adjustment     numeric(18,4) not null check (adjustment <> 0),
  extra          jsonb not null default '{}'::jsonb,
  extra_free     jsonb not null default '[]'::jsonb,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  created_by     uuid default kernel.current_user_id(),
  updated_by     uuid,
  unique (company_id, seq),
  unique (revaluation_id, line_no),
  unique (entry_line_id)
);
create index if not exists fx_revaluation_lines_invoice_idx on accounting.fx_revaluation_lines (company_id, invoice_id);

do $$
begin
  if not exists (select 1 from pg_trigger where tgname = 'assign_seq' and tgrelid = 'accounting.fx_revaluations'::regclass) then
    perform accounting.setup_table('fx_revaluations', 'accounting.fx_revaluation');
    perform accounting.setup_table('fx_revaluation_lines', 'accounting.fx_revaluation_line');
  end if;
end;
$$;
select kernel.typed_columns('accounting', 'fx_revaluations', 'documento', 'accounting.fx_revaluation');
select kernel.typed_lines('accounting', 'fx_revaluation_lines', 'accounting.fx_revaluation', 'revaluation_id');
-- One posted run per company and period: a rerun voids the previous one first (in the same transaction).
create unique index if not exists fx_revaluations_one_posted on accounting.fx_revaluations (company_id, period_id) where status = 'posted';

-- What a run recorded does not change: a run is voided, never edited (its entries are the ledger's).
create or replace function accounting.fx_revaluation_lines_frozen() returns trigger
language plpgsql
as $$
begin
  raise exception 'erp:invalid_input:Las líneas de un ajuste por diferencia en cambio no cambian: anula el ajuste y calcúlalo de nuevo';
end;
$$;
drop trigger if exists fx_revaluation_lines_frozen on accounting.fx_revaluation_lines;
create trigger fx_revaluation_lines_frozen before update or delete on accounting.fx_revaluation_lines
  for each row execute function accounting.fx_revaluation_lines_frozen();

create or replace function accounting.fx_revaluations_frozen() returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'erp:invalid_input:Un ajuste por diferencia en cambio no se elimina: se anula';
  end if;
  if old.status = 'voided' and new.status <> 'voided' then
    raise exception 'erp:invalid_input:Un ajuste por diferencia en cambio anulado no vuelve a contabilizarse';
  end if;
  if (new.period_id, new.date, new.closing_rates) is distinct from (old.period_id, old.date, old.closing_rates) then
    raise exception 'erp:invalid_input:Un ajuste por diferencia en cambio no cambia: anúlalo y calcúlalo de nuevo';
  end if;
  return new;
end;
$$;
drop trigger if exists fx_revaluations_frozen on accounting.fx_revaluations;
create trigger fx_revaluations_frozen before update or delete on accounting.fx_revaluations
  for each row execute function accounting.fx_revaluations_frozen();

insert into kernel.entity_tables (entity, module_id, entity_type, table_schema, table_name, lines_entity) values
  ('accounting.fx_revaluation', 'accounting', 'documento', 'accounting', 'fx_revaluations', 'accounting.fx_revaluation_line')
on conflict (entity) do nothing;
select kernel.register_reference('core.party', 'accounting', 'fx_revaluation_lines', 'party_id');

-- The close check «Diferencia en cambio no calculada» (a warning: it never keeps a period open).
alter table accounting.period_close_checks drop constraint if exists period_close_checks_check_check;
alter table accounting.period_close_checks add constraint period_close_checks_check_check check ("check" in (
  'drafts', 'pending_failures', 'pending_approvals', 'undispatched_events', 'control_receivable', 'control_payable',
  'control_inventory', 'suspense_zero', 'rounding_within_tolerance', 'contra_nature_balances', 'fx_revaluation'));

-- ---------------------------------------------------------------------------------------------
-- Open items from allocations, in both currencies (0138's body; the changes are marked FX).
-- ---------------------------------------------------------------------------------------------
drop view if exists accounting.v_open_items;
drop function if exists accounting.open_items(uuid, date);
drop function if exists accounting.open_items_allocated(uuid, date);

create function accounting.open_items_allocated(p_company uuid, p_as_of date)
returns table (
  company_id uuid, account_id uuid, party_id uuid, entry_id uuid, line_no int,
  date date, due_date date, original numeric, open numeric, kind text,
  currency text, amount_doc numeric, open_doc numeric
)
language sql stable security definer
set search_path = ''
-- The CTEs over the published functions are estimated at a few rows; a nested loop over them is quadratic on a large ledger: hash joins only.
set enable_nestloop = off
as $$
  with member as (
    select array[p_company] <@ kernel.current_company_ids() as ok
  ),
  company as (
    select c.currency_code::text as currency from kernel.companies c where c.id = p_company
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
  -- FX: the split is by the pesos each allocation takes off its invoice (amount_company), its dollars (`amount`) kept for open_doc.
  allocations as (
    select a.receipt_id, a.invoice_id, a.amount, a.amount_company, sum(a.amount_company) over (partition by a.receipt_id) as receipt_total
    from payments.ledger_allocations(p_company) a
    where (select ok from member)
  ),
  allocated_receipts as (
    select distinct receipt_id from allocations
  ),
  note_invoices as (
    select n.note_id, n.invoice_id from invoicing.ledger_note_invoices(p_company) n where (select ok from member)
  ),
  -- FX: the receivable lines of the revaluation runs (the run's entry, its reversal, a void's mirrors: same line_no) and the invoice each adjusts.
  revaluation_lines as (
    select l2.id as line_id, r.invoice_id
    from accounting.fx_revaluation_lines r
    join accounting.entry_lines l1 on l1.id = r.entry_line_id
    join accounting.entries e2 on e2.company_id = p_company and e2.source_entity = 'accounting.fx_revaluation' and e2.source_record_id = r.revaluation_id
    join accounting.entry_lines l2 on l2.entry_id = e2.id and l2.line_no = l1.line_no
    where r.company_id = p_company and (select ok from member)
  ),
  visible as (
    select l.id, l.account_id, l.party_id, l.entry_id, l.line_no, l.due_date, l.debit, l.credit, l.debit_doc, l.credit_doc,
           e.date, e.seq as entry_seq, e.currency, e.source_entity, e.source_record_id, e.reversal_of_id
    from accounting.entry_lines l
    join accounting.entries e on e.id = l.entry_id and e.company_id = p_company
    join accounting.accounts a on a.id = l.account_id and a.company_id = p_company
    join groups g on g.grp = left(a.code, 2)
    where (select ok from member)
      and l.company_id = p_company and a.requires_party and l.party_id is not null
      and e.status in ('posted', 'reversed') and e.date <= p_as_of
      and not exists (select 1 from withholding_accounts w where w.id = l.account_id)
      and case when p_company = (select kernel.current_company_id()) then l.account_id <> all ((select accounting.hidden_account_ids())::uuid[])
               else accounting.can_view_account(l.account_id) end
  ),
  revaluations as (
    select v.account_id, v.party_id, rl.invoice_id, sum(v.debit - v.credit) as amount
    from visible v join revaluation_lines rl on rl.line_id = v.id
    group by v.account_id, v.party_id, rl.invoice_id
  ),
  raw as (
    select v.account_id, v.party_id, v.entry_id, v.line_no, v.date, v.due_date, v.entry_seq,
           v.debit - v.credit as net, v.debit_doc - v.credit_doc as net_doc, v.currency::text as currency,
           v.source_entity, v.source_record_id, v.reversal_of_id is not null as is_reversal,
           case when v.source_entity = 'invoicing.invoice' then v.source_record_id
                when v.source_entity = 'invoicing.note' then ni.invoice_id end as invoice_id,
           (v.source_entity is not distinct from 'invoicing.invoice' or ni.invoice_id is not null or ar.receipt_id is not null) as aimed
    from visible v
    left join note_invoices ni on v.source_entity = 'invoicing.note' and ni.note_id = v.source_record_id
    left join allocated_receipts ar on v.source_entity in ('payments.receipt', 'payments.advance_application') and ar.receipt_id = v.source_record_id
    where not exists (select 1 from revaluation_lines rl where rl.line_id = v.id)
  ),
  lines as (
    select r.*, (r.net > 0 and (not r.is_reversal or not r.aimed)) as is_doc from raw r
  ),
  apps as (
    select account_id, party_id, entry_id, line_no, source_entity, source_record_id, invoice_id, aimed, -net as amount, -net_doc as amount_doc
    from lines where not is_doc and net <> 0
  ),
  -- A receipt's line over its allocations: each share in cents, the cents the floors leave going to the largest remainders.
  receipt_shares as (
    select ap.account_id, ap.party_id, ap.entry_id, ap.line_no, al.invoice_id, sign(ap.amount) as sign, abs(ap.amount) as line_amount,
           case when abs(ap.amount) = al.receipt_total then al.amount_company else abs(ap.amount) * al.amount_company / al.receipt_total end as exact,
           sign(ap.amount) * case when abs(ap.amount) = al.receipt_total then al.amount else round(abs(ap.amount) * al.amount / al.receipt_total, 2) end as doc
    from apps ap join allocations al on al.receipt_id = ap.source_record_id
    where ap.source_entity in ('payments.receipt', 'payments.advance_application') and ap.aimed and al.receipt_total > 0
  ),
  receipt_floors as (
    select s.*, floor(s.exact * 100) / 100 as base,
           row_number() over (partition by s.entry_id, s.line_no order by s.exact - floor(s.exact * 100) / 100 desc, s.invoice_id) as rank,
           round((s.line_amount - sum(floor(s.exact * 100) / 100) over (partition by s.entry_id, s.line_no)) * 100) as cents_left
    from receipt_shares s
  ),
  aimed as (
    select account_id, party_id, invoice_id, amount, amount_doc
    from apps where aimed and source_entity in ('invoicing.invoice', 'invoicing.note') and invoice_id is not null
    union all
    select account_id, party_id, invoice_id, (sign * (base + case when rank <= cents_left then 0.01 else 0 end))::numeric(18,4), doc
    from receipt_floors
  ),
  aimed_totals as (
    select account_id, party_id, invoice_id, sum(amount) as total, sum(amount_doc) as total_doc from aimed group by account_id, party_id, invoice_id
  ),
  unaimed_totals as (
    select account_id, party_id, sum(amount) as total from apps where not aimed group by account_id, party_id
  ),
  -- FX: an invoice's revaluation adds to the pesos of its earliest document.
  docs as (
    select l.account_id, l.party_id, l.entry_id, l.line_no, l.date, l.due_date, l.entry_seq, l.invoice_id, l.currency, l.net_doc as amount_doc,
           l.net + case when l.invoice_id is not null and row_number() over (
                          partition by l.account_id, l.party_id, l.invoice_id order by coalesce(l.due_date, l.date), l.date, l.entry_seq, l.line_no) = 1
                        then coalesce(rv.amount, 0) else 0 end as amount
    from lines l
    left join revaluations rv on rv.account_id = l.account_id and rv.party_id = l.party_id and rv.invoice_id = l.invoice_id
    where l.is_doc
  ),
  matched as (
    select d.*,
           case when d.invoice_id is null then 0
                else least(d.amount, greatest(0, coalesce(t.total, 0) - coalesce(sum(d.amount) over (
                       partition by d.account_id, d.party_id, d.invoice_id order by coalesce(d.due_date, d.date), d.date, d.entry_seq, d.line_no
                       rows between unbounded preceding and 1 preceding), 0))) end as settled,
           case when d.invoice_id is null then 0
                else least(d.amount_doc, greatest(0, coalesce(t.total_doc, 0) - coalesce(sum(d.amount_doc) over (
                       partition by d.account_id, d.party_id, d.invoice_id order by coalesce(d.due_date, d.date), d.date, d.entry_seq, d.line_no
                       rows between unbounded preceding and 1 preceding), 0))) end as settled_doc
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
  ),
  documents as (
    select r.*, greatest(0, r.rest - greatest(0, coalesce(p.amount, 0) - r.rest_before)) as open
    from residual r
    left join pool p on p.account_id = r.account_id and p.party_id = r.party_id
  )
  select p_company, d.account_id, d.party_id, d.entry_id, d.line_no, d.date, d.due_date, d.amount, d.open, 'document',
         d.currency, d.amount_doc,
         case when d.currency = (select currency from company) then d.open
              when d.open = 0 then 0
              else greatest(0, d.amount_doc - d.settled_doc) end
  from documents d
  union all
  select p_company, p.account_id, p.party_id, null, null, p_as_of, null,
         -(p.over + greatest(0, p.amount - p.rest)), -(p.over + greatest(0, p.amount - p.rest)), 'credit',
         (select currency from company), -(p.over + greatest(0, p.amount - p.rest)), -(p.over + greatest(0, p.amount - p.rest))
  from pool p
  where p.over + greatest(0, p.amount - p.rest) > 0
  union all
  select p_company, p.account_id, p.party_id, null, null, p_as_of, null, -p.amount, -p.amount, 'document', (select currency from company), -p.amount, -p.amount
  from pool p
  where p.amount < 0
  union all
  select p_company, l.account_id, l.party_id, null, null, max(e.date), null, sum(l.debit - l.credit), sum(l.debit - l.credit), 'advance',
         (select currency from company), sum(l.debit - l.credit), sum(l.debit - l.credit)
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
  'The receivable open items of a company with payments, from the allocations (0112, 0114, 0138, 0153), in pesos and in the document''s currency. Definer; nothing unless p_company is one of the caller''s companies; account visibility from the caller''s claims.';

create function accounting.open_items(p_company uuid, p_as_of date)
returns table (
  company_id uuid, account_id uuid, party_id uuid, entry_id uuid, line_no int,
  date date, due_date date, original numeric, open numeric, kind text,
  currency text, amount_doc numeric, open_doc numeric
)
language sql stable
set search_path = ''
as $$
  with mode as (select accounting.open_items_follow_allocations(p_company) as allocated),
  company as (select c.currency_code::text as currency from kernel.companies c where c.id = p_company)
  select f.company_id, f.account_id, f.party_id, f.entry_id, f.line_no, f.date, f.due_date, f.original, f.open, 'document'::text,
         (select currency from company), f.original, f.open
  from accounting.open_items_fifo(p_company, p_as_of, (select allocated from mode)) f
  union all
  select a.company_id, a.account_id, a.party_id, a.entry_id, a.line_no, a.date, a.due_date, a.original, a.open, a.kind,
         a.currency, a.amount_doc, a.open_doc
  from accounting.open_items_allocated(p_company, p_as_of) a
  where (select allocated from mode)
$$;
revoke execute on function accounting.open_items(uuid, date) from public, anon;
grant execute on function accounting.open_items(uuid, date) to authenticated, service_role;
comment on function accounting.open_items(uuid, date) is
  'Receivable and payable open items at a date: FIFO, or from the payments allocations for the receivables of a company with payments (0112, 0153); currency, amount_doc and open_doc in the document''s currency (the company''s for FIFO).';

create view accounting.v_open_items with (security_invoker = true) as
select o.company_id, o.account_id, o.party_id, o.entry_id, o.line_no, o.date, o.due_date, o.original, o.open, o.kind, o.currency, o.amount_doc, o.open_doc
from accounting.open_items((select kernel.current_company_id()), current_date) o;
grant select on accounting.v_open_items to authenticated;
comment on view accounting.v_open_items is
  'Published (accounting design §4.12): receivable and payable open items at today, FIFO, or from the payments allocations for the receivables of a company with payments (kind document | credit | advance), with the document currency figures of 0153.';

-- ---------------------------------------------------------------------------------------------
-- Masked read views (rule 14). Generated by maskedViewSql (packages/kernel/src/security/masked-views.ts) from
-- packages/modules/accounting/src/entities.ts and pasted here; views.test.ts fails when they drift.
-- ---------------------------------------------------------------------------------------------
drop view if exists accounting.v_fx_revaluation_lines;
drop view if exists accounting.v_fx_revaluations;

create or replace view accounting.v_fx_revaluations with (security_invoker = true) as
select
  "id",
  "company_id",
  case when (select kernel.field_visible('accounting.fx_revaluation', 'seq')) then "seq" else null end as "seq",
  case when (select kernel.field_visible('accounting.fx_revaluation', 'period_id')) then "period_id" else null end as "period_id",
  case when (select kernel.field_visible('accounting.fx_revaluation', 'date')) then "date" else null end as "date",
  case when (select kernel.field_visible('accounting.fx_revaluation', 'closing_rates')) then "closing_rates" else null end as "closing_rates",
  case when (select kernel.field_visible('accounting.fx_revaluation', 'lines_count')) then "lines_count" else null end as "lines_count",
  case when (select kernel.field_visible('accounting.fx_revaluation', 'entry_id')) then "entry_id" else null end as "entry_id",
  case when (select kernel.field_visible('accounting.fx_revaluation', 'reversal_entry_id')) then "reversal_entry_id" else null end as "reversal_entry_id",
  case when (select kernel.field_visible('accounting.fx_revaluation', 'void_entry_id')) then "void_entry_id" else null end as "void_entry_id",
  case when (select kernel.field_visible('accounting.fx_revaluation', 'void_reversal_entry_id')) then "void_reversal_entry_id" else null end as "void_reversal_entry_id",
  case when (select kernel.field_visible('accounting.fx_revaluation', 'voided_at')) then "voided_at" else null end as "voided_at",
  case when (select kernel.field_visible('accounting.fx_revaluation', 'extra')) then kernel.mask_extra('accounting.fx_revaluation', "extra") else null end as "extra",
  case when (select kernel.field_visible('accounting.fx_revaluation', 'extra_free')) then "extra_free" else null end as "extra_free",
  "created_at",
  "updated_at",
  case when (select kernel.field_visible('accounting.fx_revaluation', 'status')) then "status" else null end as "status",
  case when (select kernel.field_visible('accounting.fx_revaluation', 'requires_approval')) then "requires_approval" else null end as "requires_approval",
  case when (select kernel.field_visible('accounting.fx_revaluation', 'posts')) then "posts" else null end as "posts",
  case when (select kernel.field_visible('accounting.fx_revaluation', 'void_reason')) then "void_reason" else null end as "void_reason"
from accounting.fx_revaluations;
grant select on accounting.v_fx_revaluations to authenticated;

create or replace view accounting.v_fx_revaluation_lines with (security_invoker = true) as
select
  "id",
  "company_id",
  case when (select kernel.field_visible('accounting.fx_revaluation_line', 'seq')) then "seq" else null end as "seq",
  case when (select kernel.field_visible('accounting.fx_revaluation_line', 'revaluation_id')) then "revaluation_id" else null end as "revaluation_id",
  case when (select kernel.field_visible('accounting.fx_revaluation_line', 'line_no')) then "line_no" else null end as "line_no",
  case when (select kernel.field_visible('accounting.fx_revaluation_line', 'entry_line_id')) then "entry_line_id" else null end as "entry_line_id",
  case when (select kernel.field_visible('accounting.fx_revaluation_line', 'invoice_id')) then "invoice_id" else null end as "invoice_id",
  case when (select kernel.field_visible('accounting.fx_revaluation_line', 'invoice_number')) then "invoice_number" else null end as "invoice_number",
  case when (select kernel.field_visible('accounting.fx_revaluation_line', 'party_id')) then "party_id" else null end as "party_id",
  case when (select kernel.field_visible('accounting.fx_revaluation_line', 'currency')) then "currency" else null end as "currency",
  case when (select kernel.field_visible('accounting.fx_revaluation_line', 'open_doc')) then "open_doc" else null end as "open_doc",
  case when (select kernel.field_visible('accounting.fx_revaluation_line', 'carrying')) then "carrying" else null end as "carrying",
  case when (select kernel.field_visible('accounting.fx_revaluation_line', 'closing_rate')) then "closing_rate" else null end as "closing_rate",
  case when (select kernel.field_visible('accounting.fx_revaluation_line', 'revalued')) then "revalued" else null end as "revalued",
  case when (select kernel.field_visible('accounting.fx_revaluation_line', 'adjustment')) then "adjustment" else null end as "adjustment",
  case when (select kernel.field_visible('accounting.fx_revaluation_line', 'extra')) then kernel.mask_extra('accounting.fx_revaluation_line', "extra") else null end as "extra",
  case when (select kernel.field_visible('accounting.fx_revaluation_line', 'extra_free')) then "extra_free" else null end as "extra_free",
  "created_at",
  "updated_at"
from accounting.fx_revaluation_lines;
grant select on accounting.v_fx_revaluation_lines to authenticated;
