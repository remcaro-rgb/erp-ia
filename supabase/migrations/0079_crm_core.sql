-- 0079_crm_core
-- Forward-only migration (rule 34). Covered by packages/modules/crm/src/__tests__/lead.integration.test.ts,
-- opportunity.integration.test.ts and entities.test.ts (the masked views match the entity definitions).
-- The crm module (design §8, plan 2B Task 11): prospectos (leads) and embudos with their etapas (maestros), oportunidades (a documento
-- numbered OP- on save, never posted) and actividades (sistema). Rule 3: no foreign key leaves the schema (party ids are core's, checked by the
-- processes through core.v_parties). Every table: uuid v7, company, seq, extra / extra_free, audit columns, company RLS, row audit, and
-- writes only through the crm processes (restrictive policies on erp.audit_process_id). Row isolation (design §6): a salesperson sees only
-- the oportunidades and actividades they own (or that nobody owns); whoever may run crm.opportunity.reassign (and a company admin) sees all.

create schema if not exists crm;
grant usage on schema crm to authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- Prospectos. The document columns are optional until the prospecto is converted into a tercero (core.party validates them then).
-- ---------------------------------------------------------------------------------------------
create table crm.leads (
  id                       uuid primary key default kernel.uuid_v7(),
  seq                      bigint not null,
  company_id               uuid not null references kernel.companies (id),
  name                     text not null check (char_length(btrim(name)) between 1 and 160),
  contact_name             text check (contact_name is null or char_length(contact_name) <= 120),
  email                    text check (email is null or (char_length(email) <= 200 and email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$')),
  phone_cc                 text check (phone_cc is null or phone_cc ~ '^[0-9]{1,3}$'),
  phone                    text check (phone is null or phone ~ '^[0-9]{4,15}$'),
  person_type              text check (person_type is null or person_type in ('1', '2')),
  document_type            text check (document_type is null or char_length(document_type) between 1 and 4),
  document_number          text check (document_number is null or char_length(document_number) <= 20),
  source                   text not null default 'other' check (source in ('web', 'referral', 'event', 'call', 'social', 'other')),
  stage                    text not null default 'new' check (stage in ('new', 'contacted', 'qualified', 'converted', 'discarded')),
  owner_id                 uuid,
  notes                    text check (notes is null or char_length(notes) <= 2000),
  converted_party_id       uuid,
  converted_opportunity_id uuid,
  converted_at             timestamptz,
  extra                    jsonb not null default '{}'::jsonb,
  extra_free               jsonb not null default '[]'::jsonb,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  created_by               uuid default kernel.current_user_id(),
  updated_by               uuid,
  unique (company_id, seq),
  check ((stage = 'converted') = (converted_party_id is not null)),
  check ((stage = 'converted') = (converted_at is not null)),
  check ((phone_cc is null) = (phone is null))
);
create index leads_company_stage_idx on crm.leads (company_id, stage);
create index leads_owner_idx on crm.leads (company_id, owner_id);

-- ---------------------------------------------------------------------------------------------
-- Embudos and etapas. An etapa is `open` (the deal goes on), `won` (probability 100) or `lost` (probability 0).
-- ---------------------------------------------------------------------------------------------
create table crm.pipelines (
  id          uuid primary key default kernel.uuid_v7(),
  seq         bigint not null,
  company_id  uuid not null references kernel.companies (id),
  code        text not null check (code ~ '^[A-Za-z0-9][A-Za-z0-9_.-]{0,19}$'),
  name        text not null check (char_length(btrim(name)) between 1 and 120),
  description text check (description is null or char_length(description) <= 500),
  is_default  boolean not null default false,
  extra       jsonb not null default '{}'::jsonb,
  extra_free  jsonb not null default '[]'::jsonb,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  created_by  uuid default kernel.current_user_id(),
  updated_by  uuid,
  unique (company_id, seq)
);

create table crm.stages (
  id          uuid primary key default kernel.uuid_v7(),
  seq         bigint not null,
  company_id  uuid not null references kernel.companies (id),
  pipeline_id uuid not null references crm.pipelines (id),
  line_no     int not null check (line_no > 0),
  name        text not null check (char_length(btrim(name)) between 1 and 80),
  probability numeric(5,2) not null check (probability between 0 and 100),
  kind        text not null default 'open' check (kind in ('open', 'won', 'lost')),
  extra       jsonb not null default '{}'::jsonb,
  extra_free  jsonb not null default '[]'::jsonb,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  created_by  uuid default kernel.current_user_id(),
  updated_by  uuid,
  unique (company_id, seq),
  unique (id, pipeline_id),
  check (kind <> 'won' or probability = 100),
  check (kind <> 'lost' or probability = 0),
  check (kind <> 'open' or probability < 100)
);
-- crm.pipeline.update renumbers in two passes (out of the way, then into place) so the order can change without a clash.
create unique index stages_pipeline_line_key on crm.stages (pipeline_id, line_no);
create unique index stages_pipeline_name_key on crm.stages (pipeline_id, lower(name));

-- ---------------------------------------------------------------------------------------------
-- Oportunidades. `outcome` follows the kind of the etapa (open / won / lost). Money (rule 8): the amount is in the document currency with
-- its exchange-rate snapshot. `order_id` is the sales order that won it (set by the consumer of sales.order.confirmed). The etapa must belong
-- to the oportunidad's embudo (composite key).
-- ---------------------------------------------------------------------------------------------
create table crm.opportunities (
  id            uuid primary key default kernel.uuid_v7(),
  seq           bigint not null,
  company_id    uuid not null references kernel.companies (id),
  number        text,
  title         text not null check (char_length(btrim(title)) between 1 and 160),
  party_id      uuid,
  lead_id       uuid references crm.leads (id),
  pipeline_id   uuid not null references crm.pipelines (id),
  stage_id      uuid not null,
  owner_id      uuid,
  amount        numeric(18,4) not null default 0 check (amount >= 0),
  currency      text not null default 'COP' check (currency ~ '^[A-Z]{3}$'),
  exchange_rate numeric(18,6) not null default 1 check (exchange_rate > 0),
  probability   numeric(5,2) not null default 0 check (probability between 0 and 100),
  expected_close date,
  outcome       text not null default 'open' check (outcome in ('open', 'won', 'lost')),
  closed_at     timestamptz,
  lost_reason   text check (lost_reason is null or char_length(lost_reason) <= 500),
  order_id      uuid,
  description   text check (description is null or char_length(description) <= 500),
  extra         jsonb not null default '{}'::jsonb,
  extra_free    jsonb not null default '[]'::jsonb,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  created_by    uuid default kernel.current_user_id(),
  updated_by    uuid,
  unique (company_id, seq),
  unique (company_id, number),
  foreign key (stage_id, pipeline_id) references crm.stages (id, pipeline_id),
  check (party_id is not null or lead_id is not null),
  check ((outcome = 'open') = (closed_at is null)),
  check (outcome <> 'lost' or lost_reason is not null),
  check (order_id is null or outcome = 'won')
);
create index opportunities_company_outcome_idx on crm.opportunities (company_id, outcome);
create index opportunities_stage_idx on crm.opportunities (stage_id);
create index opportunities_party_idx on crm.opportunities (company_id, party_id) where party_id is not null;
create index opportunities_owner_idx on crm.opportunities (company_id, owner_id);

-- Lines: what the deal is about. A line names a product (core's, checked by the process) or only a description; the quantity and the
-- unit price are the ones talked about. Written while the oportunidad is a Borrador only.
create table crm.opportunity_lines (
  id             uuid primary key default kernel.uuid_v7(),
  seq            bigint not null,
  company_id     uuid not null references kernel.companies (id),
  opportunity_id uuid not null references crm.opportunities (id),
  line_no        int not null check (line_no > 0),
  product_id     uuid,
  description    text check (description is null or char_length(description) <= 300),
  qty            numeric(18,4) not null check (qty > 0),
  unit_price     numeric(18,4) not null default 0 check (unit_price >= 0),
  extra          jsonb not null default '{}'::jsonb,
  extra_free     jsonb not null default '[]'::jsonb,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  created_by     uuid default kernel.current_user_id(),
  updated_by     uuid,
  unique (company_id, seq),
  unique (opportunity_id, line_no),
  check (product_id is not null or description is not null)
);
create index opportunity_lines_product_idx on crm.opportunity_lines (company_id, product_id) where product_id is not null;

-- ---------------------------------------------------------------------------------------------
-- Actividades. `source_entity` / `source_id` is the idempotency key of the ones an event logs: one activity per source record.
-- ---------------------------------------------------------------------------------------------
create table crm.activities (
  id             uuid primary key default kernel.uuid_v7(),
  seq            bigint not null,
  company_id     uuid not null references kernel.companies (id),
  kind           text not null check (kind in ('call', 'meeting', 'email', 'note', 'task', 'payment')),
  subject        text not null check (char_length(btrim(subject)) between 1 and 200),
  notes          text check (notes is null or char_length(notes) <= 2000),
  opportunity_id uuid references crm.opportunities (id),
  lead_id        uuid references crm.leads (id),
  party_id       uuid,
  owner_id       uuid,
  due_at         timestamptz,
  done_at        timestamptz,
  source_entity  text check (source_entity is null or source_entity ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'),
  source_id      uuid,
  extra          jsonb not null default '{}'::jsonb,
  extra_free     jsonb not null default '[]'::jsonb,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  created_by     uuid default kernel.current_user_id(),
  updated_by     uuid,
  unique (company_id, seq),
  check (opportunity_id is not null or lead_id is not null or party_id is not null),
  check ((source_entity is null) = (source_id is null))
);
create unique index activities_source_key on crm.activities (company_id, source_entity, source_id) where source_id is not null;
create index activities_opportunity_idx on crm.activities (opportunity_id) where opportunity_id is not null;
create index activities_lead_idx on crm.activities (lead_id) where lead_id is not null;
create index activities_owner_idx on crm.activities (company_id, owner_id);

-- ---------------------------------------------------------------------------------------------
-- Opportunity numbers (D9: company sequence): one gap-free counter per company and prefix (OP-), drawn in the opportunity's transaction.
-- ---------------------------------------------------------------------------------------------
create table crm.document_numbers (
  company_id uuid not null references kernel.companies (id),
  prefix     text not null check (prefix ~ '^[A-Z]{1,5}-$'),
  next       bigint not null default 1 check (next > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (company_id, prefix)
);
select kernel.enable_company_rls('crm', 'document_numbers');
grant select on crm.document_numbers to authenticated;
grant all on crm.document_numbers to service_role;

create or replace function crm.next_number(p_company uuid, p_prefix text) returns text
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_number bigint;
begin
  if kernel.current_user_id() is not null
     and not (p_company = kernel.current_company_id() and array[p_company] <@ kernel.current_company_ids()) then
    raise exception 'company % is not the caller''s active company', p_company using errcode = 'insufficient_privilege';
  end if;
  insert into crm.document_numbers as n (company_id, prefix, next)
  values (p_company, p_prefix, 2)
  on conflict (company_id, prefix) do update set next = n.next + 1, updated_at = now()
  returning n.next - 1 into v_number;
  return p_prefix || v_number::text;
end;
$$;
revoke execute on function crm.next_number(uuid, text) from public, anon;
grant execute on function crm.next_number(uuid, text) to authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- Company RLS (rule 12), row audit (rule 16), the record number `seq` (core's shared trigger, rule 7) and the touch trigger.
-- ---------------------------------------------------------------------------------------------
select kernel.enable_company_rls('crm', 'leads');
select kernel.enable_company_rls('crm', 'pipelines');
select kernel.enable_company_rls('crm', 'stages');
select kernel.enable_company_rls('crm', 'opportunities');
select kernel.enable_company_rls('crm', 'opportunity_lines');
select kernel.enable_company_rls('crm', 'activities');
select kernel.enable_row_audit('crm', 'leads');
select kernel.enable_row_audit('crm', 'pipelines');
select kernel.enable_row_audit('crm', 'stages');
select kernel.enable_row_audit('crm', 'opportunities');
select kernel.enable_row_audit('crm', 'opportunity_lines');
select kernel.enable_row_audit('crm', 'activities');

create trigger assign_seq before insert on crm.leads         for each row execute function core.assign_seq('crm.lead');
create trigger assign_seq before insert on crm.pipelines     for each row execute function core.assign_seq('crm.pipeline');
create trigger assign_seq before insert on crm.stages        for each row execute function core.assign_seq('crm.stage');
create trigger assign_seq before insert on crm.opportunities for each row execute function core.assign_seq('crm.opportunity');
create trigger assign_seq before insert on crm.opportunity_lines for each row execute function core.assign_seq('crm.opportunity_line');
create trigger assign_seq before insert on crm.activities    for each row execute function core.assign_seq('crm.activity');
create trigger touch_row before update on crm.leads         for each row execute function core.touch_row();
create trigger touch_row before update on crm.pipelines     for each row execute function core.touch_row();
create trigger touch_row before update on crm.stages        for each row execute function core.touch_row();
create trigger touch_row before update on crm.opportunities for each row execute function core.touch_row();
create trigger touch_row before update on crm.opportunity_lines for each row execute function core.touch_row();
create trigger touch_row before update on crm.activities    for each row execute function core.touch_row();

-- The typed lifecycle (entity types spec §5): the maestros' and the oportunidad's state columns, the flags copied at insert and the
-- record-access read policy; the etapas inherit the embudo's read right.
select kernel.typed_columns('crm', 'leads', 'maestro', 'crm.lead');
select kernel.typed_columns('crm', 'pipelines', 'maestro', 'crm.pipeline');
select kernel.typed_columns('crm', 'opportunities', 'documento', 'crm.opportunity');
select kernel.typed_lines('crm', 'stages', 'crm.pipeline', 'pipeline_id');
select kernel.typed_lines('crm', 'opportunity_lines', 'crm.opportunity', 'opportunity_id');

-- Codes are unique among the records not deleted, whatever their case; one default embudo per company.
create unique index pipelines_company_code_key on crm.pipelines (company_id, lower(code)) where deleted_at is null;
create unique index pipelines_default_key on crm.pipelines (company_id) where is_default and deleted_at is null;

-- Grants: the handlers run as the caller. A Borrador oportunidad (never numbered) may be deleted by the lifecycle (D1); an etapa no deal uses
-- may be removed by crm.pipeline.update.
grant select, insert, update on crm.leads, crm.pipelines, crm.stages, crm.opportunities, crm.opportunity_lines, crm.activities to authenticated;
grant delete on crm.opportunities, crm.opportunity_lines, crm.stages to authenticated;
grant all on crm.leads, crm.pipelines, crm.stages, crm.opportunities, crm.opportunity_lines, crm.activities to service_role;

-- Writes only through the process pipeline (rule 1): runProcess sets erp.audit_process_id for its transaction.
do $$
declare
  t text;
begin
  foreach t in array array['leads', 'pipelines', 'stages', 'opportunities', 'opportunity_lines', 'activities'] loop
    execute format($p$create policy via_process_insert on crm.%I as restrictive for insert to authenticated
      with check (coalesce(current_setting('erp.audit_process_id', true), '') like 'crm.%%')$p$, t);
    execute format($p$create policy via_process_update on crm.%I as restrictive for update to authenticated
      using (coalesce(current_setting('erp.audit_process_id', true), '') like 'crm.%%')
      with check (coalesce(current_setting('erp.audit_process_id', true), '') like 'crm.%%')$p$, t);
  end loop;
  foreach t in array array['opportunities', 'opportunity_lines', 'stages'] loop
    execute format($p$create policy via_process_delete on crm.%I as restrictive for delete to authenticated
      using (coalesce(current_setting('erp.audit_process_id', true), '') like 'crm.%%')$p$, t);
  end loop;
end;
$$;

-- Row isolation (design §6): a salesperson sees only the oportunidades and actividades they own, and the ones nobody owns yet. Whoever may
-- run crm.opportunity.reassign (the sales manager; a company admin always may) sees all. The restrictive policy narrows the company policy
-- and applies to every statement that reads the rows, so each security_invoker view follows (grids, lookups, exports, the assistant).
create policy owner_scope on crm.opportunities as restrictive for select to authenticated
  using (owner_id is null or owner_id = (select kernel.current_user_id()) or (select kernel.can_run_process('crm.opportunity.reassign')));
create policy owner_scope on crm.activities as restrictive for select to authenticated
  using (owner_id is null or owner_id = (select kernel.current_user_id()) or (select kernel.can_run_process('crm.opportunity.reassign')));

-- Eliminar (D1): only a Borrador (never numbered), whoever issues the statement.
create or replace function crm.document_delete_draft_only() returns trigger
language plpgsql
as $$
begin
  if old.status <> 'draft' then
    raise exception 'erp:invalid_input:Solo se elimina un documento en Borrador';
  end if;
  return old;
end;
$$;
create trigger delete_draft_only before delete on crm.opportunities for each row execute function crm.document_delete_draft_only();

-- An oportunidad's lines are written while it is a Borrador only: what the deal is about does not change after (the quote carries the changes).
create or replace function crm.opportunity_lines_frozen() returns trigger
language plpgsql
as $$
declare
  v_opportunity uuid := case when tg_op = 'DELETE' then old.opportunity_id else new.opportunity_id end;
  v_status text;
begin
  select status into v_status from crm.opportunities where id = v_opportunity;
  if v_status = 'draft' then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  raise exception 'erp:invalid_input:Las líneas de una oportunidad registrada no cambian';
end;
$$;
create trigger opportunity_lines_frozen before insert or update or delete on crm.opportunity_lines
  for each row execute function crm.opportunity_lines_frozen();

-- ---------------------------------------------------------------------------------------------
-- The entity -> table rows syncModuleManifest also writes (an upsert there), so the usability gate, the reference check and Versiones
-- work from the migration on.
-- ---------------------------------------------------------------------------------------------
insert into kernel.entity_tables (entity, module_id, entity_type, table_schema, table_name, lines_entity) values
  ('crm.lead',        'crm', 'maestro',   'crm', 'leads',         null),
  ('crm.pipeline',    'crm', 'maestro',   'crm', 'pipelines',     'crm.stage'),
  ('crm.opportunity', 'crm', 'documento', 'crm', 'opportunities', null)
on conflict (entity) do nothing;

-- Who uses a crm maestro or a tercero (kernel."references", 0040): a referenced one cannot be deleted, only set Activo = no.
select kernel.register_reference('crm.pipeline', 'crm', 'opportunities', 'pipeline_id');
select kernel.register_reference('crm.lead',     'crm', 'opportunities', 'lead_id');
select kernel.register_reference('crm.lead',     'crm', 'activities',    'lead_id');
select kernel.register_reference('core.party',   'crm', 'leads',         'converted_party_id');
select kernel.register_reference('core.party',   'crm', 'opportunities', 'party_id');
select kernel.register_reference('core.party',   'crm', 'activities',    'party_id');
select kernel.register_reference('core.product', 'crm', 'opportunity_lines', 'product_id');

-- ---------------------------------------------------------------------------------------------
-- Hooks every module that owns entities defines (kernel.notify_attachments_changed, 0007, and kernel.notify_custom_field_changed, 0008,
-- raise when the module has none). Crm records derive no readiness from their files or their extra data: both are no-ops.
-- ---------------------------------------------------------------------------------------------
create or replace function crm.attachments_changed(p_entity text, p_company uuid, p_record_id uuid) returns void
language sql
set search_path = ''
as $$
  select;
$$;
revoke execute on function crm.attachments_changed(text, uuid, uuid) from public, anon, authenticated;
grant execute on function crm.attachments_changed(text, uuid, uuid) to service_role;

create or replace function crm.custom_field_changed(p_entity text, p_company uuid) returns void
language sql
set search_path = ''
as $$
  select;
$$;
revoke execute on function crm.custom_field_changed(text, uuid) from public, anon, authenticated;
grant execute on function crm.custom_field_changed(text, uuid) to service_role;

-- ---------------------------------------------------------------------------------------------
-- Masked read views (rule 14). Generated by maskedViewSql (packages/kernel/src/security/masked-views.ts) from
-- packages/modules/crm/src/entities.ts and pasted here; entities.test.ts fails when they drift. The maestros' views drop deleted rows.
-- ---------------------------------------------------------------------------------------------

create or replace view crm.v_leads with (security_invoker = true) as
select
  "id",
  "company_id",
  case when (select kernel.field_visible('crm.lead', 'seq')) then "seq" else null end as "seq",
  case when (select kernel.field_visible('crm.lead', 'name')) then "name" else null end as "name",
  case when (select kernel.field_visible('crm.lead', 'contact_name')) then "contact_name" else null end as "contact_name",
  case when (select kernel.field_visible('crm.lead', 'email')) then "email" else null end as "email",
  case when (select kernel.field_visible('crm.lead', 'phone_cc')) then "phone_cc" else null end as "phone_cc",
  case when (select kernel.field_visible('crm.lead', 'phone')) then "phone" else null end as "phone",
  case when (select kernel.field_visible('crm.lead', 'person_type')) then "person_type" else null end as "person_type",
  case when (select kernel.field_visible('crm.lead', 'document_type')) then "document_type" else null end as "document_type",
  case when (select kernel.field_visible('crm.lead', 'document_number')) then "document_number" else null end as "document_number",
  case when (select kernel.field_visible('crm.lead', 'source')) then "source" else null end as "source",
  case when (select kernel.field_visible('crm.lead', 'stage')) then "stage" else null end as "stage",
  case when (select kernel.field_visible('crm.lead', 'owner_id')) then "owner_id" else null end as "owner_id",
  case when (select kernel.field_visible('crm.lead', 'notes')) then "notes" else null end as "notes",
  case when (select kernel.field_visible('crm.lead', 'converted_party_id')) then "converted_party_id" else null end as "converted_party_id",
  case when (select kernel.field_visible('crm.lead', 'converted_opportunity_id')) then "converted_opportunity_id" else null end as "converted_opportunity_id",
  case when (select kernel.field_visible('crm.lead', 'converted_at')) then "converted_at" else null end as "converted_at",
  case when (select kernel.field_visible('crm.lead', 'is_active')) then "is_active" else null end as "is_active",
  case when (select kernel.field_visible('crm.lead', 'extra')) then kernel.mask_extra('crm.lead', "extra") else null end as "extra",
  case when (select kernel.field_visible('crm.lead', 'extra_free')) then "extra_free" else null end as "extra_free",
  "created_at",
  "updated_at",
  case when (select kernel.field_visible('crm.lead', 'status')) then "status" else null end as "status",
  case when (select kernel.field_visible('crm.lead', 'requires_approval')) then "requires_approval" else null end as "requires_approval"
from crm.leads
where deleted_at is null;
grant select on crm.v_leads to authenticated;

create or replace view crm.v_pipelines with (security_invoker = true) as
select
  "id",
  "company_id",
  case when (select kernel.field_visible('crm.pipeline', 'seq')) then "seq" else null end as "seq",
  case when (select kernel.field_visible('crm.pipeline', 'code')) then "code" else null end as "code",
  case when (select kernel.field_visible('crm.pipeline', 'name')) then "name" else null end as "name",
  case when (select kernel.field_visible('crm.pipeline', 'description')) then "description" else null end as "description",
  case when (select kernel.field_visible('crm.pipeline', 'is_default')) then "is_default" else null end as "is_default",
  case when (select kernel.field_visible('crm.pipeline', 'is_active')) then "is_active" else null end as "is_active",
  case when (select kernel.field_visible('crm.pipeline', 'extra')) then kernel.mask_extra('crm.pipeline', "extra") else null end as "extra",
  case when (select kernel.field_visible('crm.pipeline', 'extra_free')) then "extra_free" else null end as "extra_free",
  "created_at",
  "updated_at",
  case when (select kernel.field_visible('crm.pipeline', 'status')) then "status" else null end as "status",
  case when (select kernel.field_visible('crm.pipeline', 'requires_approval')) then "requires_approval" else null end as "requires_approval"
from crm.pipelines
where deleted_at is null;
grant select on crm.v_pipelines to authenticated;

create or replace view crm.v_stages with (security_invoker = true) as
select
  "id",
  "company_id",
  case when (select kernel.field_visible('crm.stage', 'seq')) then "seq" else null end as "seq",
  case when (select kernel.field_visible('crm.stage', 'pipeline_id')) then "pipeline_id" else null end as "pipeline_id",
  case when (select kernel.field_visible('crm.stage', 'line_no')) then "line_no" else null end as "line_no",
  case when (select kernel.field_visible('crm.stage', 'name')) then "name" else null end as "name",
  case when (select kernel.field_visible('crm.stage', 'probability')) then "probability" else null end as "probability",
  case when (select kernel.field_visible('crm.stage', 'kind')) then "kind" else null end as "kind",
  case when (select kernel.field_visible('crm.stage', 'extra')) then kernel.mask_extra('crm.stage', "extra") else null end as "extra",
  case when (select kernel.field_visible('crm.stage', 'extra_free')) then "extra_free" else null end as "extra_free",
  "created_at",
  "updated_at"
from crm.stages;
grant select on crm.v_stages to authenticated;

create or replace view crm.v_opportunities with (security_invoker = true) as
select
  "id",
  "company_id",
  case when (select kernel.field_visible('crm.opportunity', 'seq')) then "seq" else null end as "seq",
  case when (select kernel.field_visible('crm.opportunity', 'number')) then "number" else null end as "number",
  case when (select kernel.field_visible('crm.opportunity', 'title')) then "title" else null end as "title",
  case when (select kernel.field_visible('crm.opportunity', 'party_id')) then "party_id" else null end as "party_id",
  case when (select kernel.field_visible('crm.opportunity', 'lead_id')) then "lead_id" else null end as "lead_id",
  case when (select kernel.field_visible('crm.opportunity', 'pipeline_id')) then "pipeline_id" else null end as "pipeline_id",
  case when (select kernel.field_visible('crm.opportunity', 'stage_id')) then "stage_id" else null end as "stage_id",
  case when (select kernel.field_visible('crm.opportunity', 'owner_id')) then "owner_id" else null end as "owner_id",
  case when (select kernel.field_visible('crm.opportunity', 'amount')) then "amount" else null end as "amount",
  case when (select kernel.field_visible('crm.opportunity', 'currency')) then "currency" else null end as "currency",
  case when (select kernel.field_visible('crm.opportunity', 'exchange_rate')) then "exchange_rate" else null end as "exchange_rate",
  case when (select kernel.field_visible('crm.opportunity', 'probability')) then "probability" else null end as "probability",
  case when (select kernel.field_visible('crm.opportunity', 'expected_close')) then "expected_close" else null end as "expected_close",
  case when (select kernel.field_visible('crm.opportunity', 'outcome')) then "outcome" else null end as "outcome",
  case when (select kernel.field_visible('crm.opportunity', 'closed_at')) then "closed_at" else null end as "closed_at",
  case when (select kernel.field_visible('crm.opportunity', 'lost_reason')) then "lost_reason" else null end as "lost_reason",
  case when (select kernel.field_visible('crm.opportunity', 'order_id')) then "order_id" else null end as "order_id",
  case when (select kernel.field_visible('crm.opportunity', 'description')) then "description" else null end as "description",
  case when (select kernel.field_visible('crm.opportunity', 'extra')) then kernel.mask_extra('crm.opportunity', "extra") else null end as "extra",
  case when (select kernel.field_visible('crm.opportunity', 'extra_free')) then "extra_free" else null end as "extra_free",
  "created_at",
  "updated_at",
  case when (select kernel.field_visible('crm.opportunity', 'status')) then "status" else null end as "status",
  case when (select kernel.field_visible('crm.opportunity', 'requires_approval')) then "requires_approval" else null end as "requires_approval",
  case when (select kernel.field_visible('crm.opportunity', 'posts')) then "posts" else null end as "posts",
  case when (select kernel.field_visible('crm.opportunity', 'void_reason')) then "void_reason" else null end as "void_reason"
from crm.opportunities;
grant select on crm.v_opportunities to authenticated;

create or replace view crm.v_opportunity_lines with (security_invoker = true) as
select
  "id",
  "company_id",
  case when (select kernel.field_visible('crm.opportunity_line', 'seq')) then "seq" else null end as "seq",
  case when (select kernel.field_visible('crm.opportunity_line', 'opportunity_id')) then "opportunity_id" else null end as "opportunity_id",
  case when (select kernel.field_visible('crm.opportunity_line', 'line_no')) then "line_no" else null end as "line_no",
  case when (select kernel.field_visible('crm.opportunity_line', 'product_id')) then "product_id" else null end as "product_id",
  case when (select kernel.field_visible('crm.opportunity_line', 'description')) then "description" else null end as "description",
  case when (select kernel.field_visible('crm.opportunity_line', 'qty')) then "qty" else null end as "qty",
  case when (select kernel.field_visible('crm.opportunity_line', 'unit_price')) then "unit_price" else null end as "unit_price",
  case when (select kernel.field_visible('crm.opportunity_line', 'extra')) then kernel.mask_extra('crm.opportunity_line', "extra") else null end as "extra",
  case when (select kernel.field_visible('crm.opportunity_line', 'extra_free')) then "extra_free" else null end as "extra_free",
  "created_at",
  "updated_at"
from crm.opportunity_lines;
grant select on crm.v_opportunity_lines to authenticated;

create or replace view crm.v_activities with (security_invoker = true) as
select
  "id",
  "company_id",
  case when (select kernel.field_visible('crm.activity', 'seq')) then "seq" else null end as "seq",
  case when (select kernel.field_visible('crm.activity', 'kind')) then "kind" else null end as "kind",
  case when (select kernel.field_visible('crm.activity', 'subject')) then "subject" else null end as "subject",
  case when (select kernel.field_visible('crm.activity', 'notes')) then "notes" else null end as "notes",
  case when (select kernel.field_visible('crm.activity', 'opportunity_id')) then "opportunity_id" else null end as "opportunity_id",
  case when (select kernel.field_visible('crm.activity', 'lead_id')) then "lead_id" else null end as "lead_id",
  case when (select kernel.field_visible('crm.activity', 'party_id')) then "party_id" else null end as "party_id",
  case when (select kernel.field_visible('crm.activity', 'owner_id')) then "owner_id" else null end as "owner_id",
  case when (select kernel.field_visible('crm.activity', 'due_at')) then "due_at" else null end as "due_at",
  case when (select kernel.field_visible('crm.activity', 'done_at')) then "done_at" else null end as "done_at",
  case when (select kernel.field_visible('crm.activity', 'source_entity')) then "source_entity" else null end as "source_entity",
  case when (select kernel.field_visible('crm.activity', 'source_id')) then "source_id" else null end as "source_id",
  case when (select kernel.field_visible('crm.activity', 'extra')) then kernel.mask_extra('crm.activity', "extra") else null end as "extra",
  case when (select kernel.field_visible('crm.activity', 'extra_free')) then "extra_free" else null end as "extra_free",
  "created_at",
  "updated_at"
from crm.activities;
grant select on crm.v_activities to authenticated;

