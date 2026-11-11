-- Account visibility once per statement in the ledger readers too (2026-11-04). 0057 did it for the chart, the tree and the balances;
-- the movements grid of an account's record page (ledger_lines), the tax lines and the entry lines still asked
-- accounting.can_view_account of every row (about 1 ms each). They now test accounting.hidden_account_ids() as an InitPlan and keep
-- the old rule that the line belongs to the active company. Same columns, same grants; forward-only.

create or replace view accounting.ledger_lines with (security_invoker = true) as
SELECT l.id,
    l.company_id,
    l.entry_id,
    e.number,
    e.date,
    e.period_id,
    COALESCE(fy.year, (EXTRACT(year FROM e.date))::integer) AS fiscal_year,
    e.journal_id,
    j.code AS journal_code,
    e.status,
    e.origin,
    e.created_by,
    e.posted_by,
    e.posted_at,
    e.source_entity,
    e.source_record_id,
        CASE
            WHEN (e.source_record_id IS NOT NULL) THEN ((COALESCE(e.source_entity, ''::text) || ':'::text) || (e.source_record_id)::text)
            ELSE NULL::text
        END AS source_ref,
    e.posting_rule_id,
    e.description AS entry_description,
    l.line_no,
    l.description,
    l.reference,
    l.account_id,
    a.code AS account_code,
    a.name AS account_name,
    "left"(a.code, 1) AS account_class,
    "left"(a.code, 2) AS account_group,
    a.level AS account_level,
    l.party_id,
    p.document_number AS party_document,
    p.legal_name AS party_name,
    l.cost_center_id,
    cc.code AS cost_center_code,
    cc.name AS cost_center_name,
    l.open_auxiliary_id,
    oa.code AS open_auxiliary_code,
    oa.name AS open_auxiliary_name,
    l.item_id,
    it.code AS item_code,
    it.name AS item_name,
    l.business_unit_id,
    bu.code AS business_unit_code,
    bu.name AS business_unit_name,
    l.debit,
    l.credit,
    (l.debit - l.credit) AS net,
        CASE
            WHEN (a.nature = 'debit'::text) THEN (l.debit - l.credit)
            ELSE (l.credit - l.debit)
        END AS signed_net,
    l.tax_code,
    l.tax_base,
    l.due_date,
    e.reversal_of_id,
    e.reversed_by_id,
    e.is_opening,
    e.is_closing,
    e.reverse_on
   FROM ((((((((((accounting.entry_lines l
     JOIN accounting.entries e ON ((e.id = l.entry_id)))
     JOIN accounting.journals j ON ((j.id = e.journal_id)))
     JOIN accounting.accounts a ON ((a.id = l.account_id)))
     LEFT JOIN accounting.periods per ON ((per.id = e.period_id)))
     LEFT JOIN accounting.fiscal_years fy ON ((fy.id = per.fiscal_year_id)))
     LEFT JOIN core.v_parties p ON ((p.id = l.party_id)))
     LEFT JOIN accounting.cost_centers cc ON ((cc.id = l.cost_center_id)))
     LEFT JOIN accounting.open_auxiliaries oa ON ((oa.id = l.open_auxiliary_id)))
     LEFT JOIN accounting.items it ON ((it.id = l.item_id)))
     LEFT JOIN accounting.business_units bu ON ((bu.id = l.business_unit_id)))
  WHERE ((l.company_id = ( SELECT kernel.current_company_id())) AND (l.account_id <> ALL (( SELECT accounting.hidden_account_ids())::uuid[])));

create or replace view accounting.v_tax_lines with (security_invoker = true) as
SELECT l.company_id,
    l.entry_id,
    e.date,
    l.party_id,
    l.tax_code,
    l.tax_base,
    l.debit,
    l.credit
   FROM (accounting.entry_lines l
     JOIN accounting.entries e ON ((e.id = l.entry_id)))
  WHERE ((l.tax_code IS NOT NULL) AND (e.status = ANY (ARRAY['posted'::text, 'reversed'::text])) AND ((l.company_id = ( SELECT kernel.current_company_id())) AND (l.account_id <> ALL (( SELECT accounting.hidden_account_ids())::uuid[]))));

create or replace view accounting.v_entry_lines with (security_invoker = true) as
SELECT id,
    company_id,
        CASE
            WHEN ( SELECT kernel.field_visible('accounting.entry_line'::text, 'seq'::text) AS field_visible) THEN seq
            ELSE NULL::bigint
        END AS seq,
        CASE
            WHEN ( SELECT kernel.field_visible('accounting.entry_line'::text, 'entry_id'::text) AS field_visible) THEN entry_id
            ELSE NULL::uuid
        END AS entry_id,
        CASE
            WHEN ( SELECT kernel.field_visible('accounting.entry_line'::text, 'line_no'::text) AS field_visible) THEN line_no
            ELSE NULL::integer
        END AS line_no,
        CASE
            WHEN (( SELECT kernel.field_visible('accounting.entry_line'::text, 'account_id'::text) AS field_visible) AND can_view) THEN account_id
            ELSE NULL::uuid
        END AS account_id,
        CASE
            WHEN (( SELECT kernel.field_visible('accounting.entry_line'::text, 'party_id'::text) AS field_visible) AND can_view) THEN party_id
            ELSE NULL::uuid
        END AS party_id,
        CASE
            WHEN (( SELECT kernel.field_visible('accounting.entry_line'::text, 'cost_center_id'::text) AS field_visible) AND can_view) THEN cost_center_id
            ELSE NULL::uuid
        END AS cost_center_id,
        CASE
            WHEN (( SELECT kernel.field_visible('accounting.entry_line'::text, 'open_auxiliary_id'::text) AS field_visible) AND can_view) THEN open_auxiliary_id
            ELSE NULL::uuid
        END AS open_auxiliary_id,
        CASE
            WHEN (( SELECT kernel.field_visible('accounting.entry_line'::text, 'item_id'::text) AS field_visible) AND can_view) THEN item_id
            ELSE NULL::uuid
        END AS item_id,
        CASE
            WHEN (( SELECT kernel.field_visible('accounting.entry_line'::text, 'business_unit_id'::text) AS field_visible) AND can_view) THEN business_unit_id
            ELSE NULL::uuid
        END AS business_unit_id,
        CASE
            WHEN (( SELECT kernel.field_visible('accounting.entry_line'::text, 'description'::text) AS field_visible) AND can_view) THEN description
            ELSE NULL::text
        END AS description,
        CASE
            WHEN (( SELECT kernel.field_visible('accounting.entry_line'::text, 'debit'::text) AS field_visible) AND can_view) THEN debit
            ELSE NULL::numeric
        END AS debit,
        CASE
            WHEN (( SELECT kernel.field_visible('accounting.entry_line'::text, 'credit'::text) AS field_visible) AND can_view) THEN credit
            ELSE NULL::numeric
        END AS credit,
        CASE
            WHEN (( SELECT kernel.field_visible('accounting.entry_line'::text, 'debit_doc'::text) AS field_visible) AND can_view) THEN debit_doc
            ELSE NULL::numeric
        END AS debit_doc,
        CASE
            WHEN (( SELECT kernel.field_visible('accounting.entry_line'::text, 'credit_doc'::text) AS field_visible) AND can_view) THEN credit_doc
            ELSE NULL::numeric
        END AS credit_doc,
        CASE
            WHEN (( SELECT kernel.field_visible('accounting.entry_line'::text, 'tax_code'::text) AS field_visible) AND can_view) THEN tax_code
            ELSE NULL::text
        END AS tax_code,
        CASE
            WHEN (( SELECT kernel.field_visible('accounting.entry_line'::text, 'tax_rate'::text) AS field_visible) AND can_view) THEN tax_rate
            ELSE NULL::numeric
        END AS tax_rate,
        CASE
            WHEN (( SELECT kernel.field_visible('accounting.entry_line'::text, 'tax_base'::text) AS field_visible) AND can_view) THEN tax_base
            ELSE NULL::numeric
        END AS tax_base,
        CASE
            WHEN (( SELECT kernel.field_visible('accounting.entry_line'::text, 'reference'::text) AS field_visible) AND can_view) THEN reference
            ELSE NULL::text
        END AS reference,
        CASE
            WHEN (( SELECT kernel.field_visible('accounting.entry_line'::text, 'due_date'::text) AS field_visible) AND can_view) THEN due_date
            ELSE NULL::date
        END AS due_date,
        CASE
            WHEN ( SELECT kernel.field_visible('accounting.entry_line'::text, 'extra'::text) AS field_visible) THEN kernel.mask_extra('accounting.entry_line'::text, extra)
            ELSE NULL::jsonb
        END AS extra,
        CASE
            WHEN ( SELECT kernel.field_visible('accounting.entry_line'::text, 'extra_free'::text) AS field_visible) THEN extra_free
            ELSE NULL::jsonb
        END AS extra_free,
    created_at,
    updated_at,
    (NOT can_view) AS is_restricted
   FROM ( SELECT el.id,
            el.seq,
            el.company_id,
            el.entry_id,
            el.line_no,
            el.account_id,
            el.party_id,
            el.cost_center_id,
            el.open_auxiliary_id,
            el.item_id,
            el.business_unit_id,
            el.description,
            el.debit,
            el.credit,
            el.debit_doc,
            el.credit_doc,
            el.tax_code,
            el.tax_rate,
            el.tax_base,
            el.reference,
            el.due_date,
            el.extra,
            el.extra_free,
            el.created_at,
            el.updated_at,
            el.created_by,
            el.updated_by,
            ((el.company_id = ( SELECT kernel.current_company_id())) AND (el.account_id <> ALL (( SELECT accounting.hidden_account_ids())::uuid[]))) AS can_view
           FROM accounting.entry_lines el) entry_lines;
