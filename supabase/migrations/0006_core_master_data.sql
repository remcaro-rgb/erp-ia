-- 0006_core_master_data
-- Forward-only migration (rule 34). Covered by packages/modules/core/src/__tests__/*.integration.test.ts
-- (party, contact, category, product, sequence) and views.test.ts (views match the entity definitions).
-- Core master data (design §5.7, §5.8a, §5.8b, §5.15, §5.17, §5.18): parties and their contacts,
-- product categories and products, units of measure, currencies, price lists, the per-entity record
-- number `seq` (rule 7) and the document number sequences.

create schema if not exists core;

grant usage on schema core to authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- Global reference tables (no company): readable by every user, written only by migrations.
-- ---------------------------------------------------------------------------------------------
create table core.currencies (
  code   char(3) primary key,
  name   text not null,
  symbol text not null
);

insert into core.currencies (code, name, symbol) values
  ('COP', 'Peso colombiano', '$'),
  ('USD', 'Dólar estadounidense', 'US$');

-- DIAN units of measure (table 13.3.6). Rows copied at authoring time from the Colombian pack's
-- UOM_CODES (packages/localization/co/data/uom.json); the pack validates products against its own
-- list, so this table only serves lookups and reports.
create table core.uoms (
  id   uuid primary key default kernel.uuid_v7(),
  code text not null unique,
  name text not null
);

insert into core.uoms (code, name) values
  ('94', 'Unidad'),
  ('EA', 'Cada uno'),
  ('KGM', 'Kilogramo'),
  ('GRM', 'Gramo'),
  ('LTR', 'Litro'),
  ('MLT', 'Mililitro'),
  ('MTR', 'Metro'),
  ('CMT', 'Centímetro'),
  ('MTK', 'Metro cuadrado'),
  ('MTQ', 'Metro cúbico'),
  ('HUR', 'Hora'),
  ('DAY', 'Día'),
  ('MON', 'Mes'),
  ('BX', 'Caja'),
  ('PK', 'Paquete'),
  ('BG', 'Bolsa'),
  ('BO', 'Botella'),
  ('DZN', 'Docena'),
  ('PR', 'Par'),
  ('SET', 'Juego'),
  ('TNE', 'Tonelada');

grant select on core.currencies, core.uoms to authenticated;
grant all on core.currencies, core.uoms to service_role;
alter table core.currencies enable row level security;
alter table core.uoms enable row level security;
create policy readable on core.currencies for select to authenticated using (true);
create policy readable on core.uoms for select to authenticated using (true);

-- The entity core.uom has no company, so its read view is written by hand (maskedViewSql always
-- selects company_id); nothing in it is sensitive.
create or replace view core.v_uoms with (security_invoker = true) as
select "id", "code", "name"
from core.uoms;
grant select on core.v_uoms to authenticated;

-- ---------------------------------------------------------------------------------------------
-- Record numbers (design §5.15). Every company row gets `seq` from core.next_seq(company, entity):
-- one counter row per company and entity, incremented under its row lock, so numbers are
-- consecutive and gap-free (a rolled-back insert rolls its increment back too). Users only read
-- the counters; the before-insert trigger assigns `seq` and the update trigger keeps it.
-- ---------------------------------------------------------------------------------------------
create table core.entity_sequences (
  company_id uuid not null references kernel.companies (id),
  entity     text not null,
  next       bigint not null default 1 check (next > 0),
  primary key (company_id, entity)
);

grant select on core.entity_sequences to authenticated;
grant all on core.entity_sequences to service_role;
select kernel.enable_company_rls('core', 'entity_sequences');

create or replace function core.next_seq(p_company uuid, p_entity text) returns bigint
language sql volatile security definer
set search_path = ''
as $$
  insert into core.entity_sequences as s (company_id, entity, next)
  values (p_company, p_entity, 2)
  on conflict (company_id, entity) do update set next = s.next + 1
  returning s.next - 1;
$$;
-- Only the trigger below (security definer) and the service role call it: a user calling it for
-- another company would leave a gap there.
revoke execute on function core.next_seq(uuid, text) from public, anon, authenticated;
grant execute on function core.next_seq(uuid, text) to service_role;

-- Before insert: `seq` is always assigned here, whatever the insert says. tg_argv[0] is the entity id.
create or replace function core.assign_seq() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  new.seq := core.next_seq(new.company_id, tg_argv[0]);
  return new;
end;
$$;

-- Before update: identity and creation columns never change; updated_at / updated_by are kept current.
create or replace function core.touch_row() returns trigger
language plpgsql
as $$
begin
  new.id := old.id;
  new.seq := old.seq;
  new.company_id := old.company_id;
  new.created_at := old.created_at;
  new.created_by := old.created_by;
  new.updated_at := now();
  new.updated_by := kernel.current_user_id();
  return new;
end;
$$;

-- Company RLS (rule 12), row audit (rule 16), `seq` and touch triggers, and the grants handlers need
-- (they run as the caller). Deletes are granted per table where a process deletes.
create or replace function core.setup_table(tbl text, entity text) returns void
language plpgsql
as $$
begin
  perform kernel.enable_company_rls('core', tbl);
  perform kernel.enable_row_audit('core', tbl);
  execute format('create trigger assign_seq before insert on core.%I for each row execute function core.assign_seq(%L)', tbl, entity);
  execute format('create trigger touch_row before update on core.%I for each row execute function core.touch_row()', tbl);
  execute format('grant select, insert, update on core.%I to authenticated', tbl);
  execute format('grant all on core.%I to service_role', tbl);
end;
$$;
revoke all on function core.setup_table(text, text) from public;

-- Invoice readiness (design §5.17): DIAN-complete and active. Task 9b adds the required attachments.
create or replace function core.compute_invoice_ready() returns trigger
language plpgsql
as $$
begin
  new.invoice_ready := new.dian_status = 'complete' and new.is_active;
  return new;
end;
$$;

-- Party scope of a role (design §5.18, rule 13) applied to a party's kinds. kernel.party_scope()
-- gives the caller's scope (the union of their roles' scopes).
create or replace function core.party_scope_allows(scope text, kind text[]) returns boolean
language sql immutable parallel safe
as $$
  select case scope
    when 'ambos' then true
    when 'clientes' then kind @> array['customer']
    when 'proveedores' then kind @> array['supplier']
    else false
  end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Parties (design §5.8a, §5.18). dian_status / dian_missing are written by core.party.create and
-- core.party.update from the country pack's validateParty, never by the client; invoice_ready by
-- the trigger. balance is read-only in phase 1 (no process writes it).
-- ---------------------------------------------------------------------------------------------
create table core.parties (
  id                   uuid primary key default kernel.uuid_v7(),
  seq                  bigint not null,
  company_id           uuid not null references kernel.companies (id),
  kind                 text[] not null check (cardinality(kind) > 0 and kind <@ '{customer,supplier,employee}'::text[]),
  person_type          text not null check (person_type in ('1', '2')),
  document_type        text not null,
  document_number      text not null,
  check_digit          text,
  legal_name           text not null,
  first_surname        text,
  second_surname       text,
  first_name           text,
  other_names          text,
  trade_name           text,
  tax_responsibilities text[] not null default '{R-99-PN}',
  tax_scheme           text not null default 'ZZ',
  ciiu                 text,
  country_code         text not null default 'CO',
  department_code      text,
  municipality_code    text,
  address_line         text,
  postal_code          text,
  invoice_email        text,
  supplier_email       text,
  phone_cc             text default '57',
  phone                text,
  contact_name         text,
  credit_limit         numeric(18,4) default 0,
  balance              numeric(18,4) default 0,
  dian_status          text not null check (dian_status in ('complete', 'errors') or dian_status ~ '^missing: [1-9][0-9]*$'),
  dian_missing         text[] not null default '{}',
  invoice_ready        boolean not null default false,
  is_active            boolean not null default true,
  extra                jsonb not null default '{}'::jsonb,
  extra_free           jsonb not null default '[]'::jsonb,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  created_by           uuid default kernel.current_user_id(),
  updated_by           uuid,
  unique (company_id, document_type, document_number),
  unique (company_id, seq)
);
select core.setup_table('parties', 'core.party');
create trigger compute_invoice_ready before insert or update on core.parties
  for each row execute function core.compute_invoice_ready();

create table core.party_contacts (
  id         uuid primary key default kernel.uuid_v7(),
  seq        bigint not null,
  company_id uuid not null references kernel.companies (id),
  party_id   uuid not null references core.parties (id),
  name       text not null,
  job_title  text,
  email      text,
  phone_cc   text default '57',
  phone      text,
  ext        text,
  mobile_cc  text default '57',
  mobile     text,
  extra      jsonb not null default '{}'::jsonb,
  extra_free jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid default kernel.current_user_id(),
  updated_by uuid,
  unique (company_id, seq)
);
create index party_contacts_party_id_idx on core.party_contacts (party_id);
select core.setup_table('party_contacts', 'core.party_contact');
grant delete on core.party_contacts to authenticated;

-- ---------------------------------------------------------------------------------------------
-- Product categories and products (design §5.8b, §5.18). A product copies its category's taxes
-- unless the input overrides them (tax_override); changing a category never rewrites products.
-- ---------------------------------------------------------------------------------------------
create table core.product_categories (
  id             uuid primary key default kernel.uuid_v7(),
  seq            bigint not null,
  company_id     uuid not null references kernel.companies (id),
  name           text not null,
  iva_rate       text not null,
  inc_rate       text,
  other_taxes    text[] not null default '{}',
  default_uom    text,
  income_account text,
  status         text not null default 'active' check (status in ('active', 'inactive')),
  extra          jsonb not null default '{}'::jsonb,
  extra_free     jsonb not null default '[]'::jsonb,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  created_by     uuid default kernel.current_user_id(),
  updated_by     uuid,
  unique (company_id, name),
  unique (company_id, seq)
);
select core.setup_table('product_categories', 'core.product_category');

create table core.products (
  id                   uuid primary key default kernel.uuid_v7(),
  seq                  bigint not null,
  company_id           uuid not null references kernel.companies (id),
  sku                  text not null,
  description          text not null,
  kind                 text not null check (kind in ('good', 'service')),
  id_scheme            text not null default '999',
  standard_code        text,
  brand                text,
  model                text,
  category_id          uuid references core.product_categories (id),
  uom_code             text not null,
  iva_rate             text not null,
  inc_rate             text,
  other_taxes          text[] not null default '{}',
  tax_override         boolean not null default false,
  list_price           numeric(18,4) not null,
  is_free_sample       boolean not null default false,
  reference_price_type text,
  reference_price      numeric(18,4),
  standard_cost        numeric(18,4),
  track_stock          boolean not null,
  min_stock            numeric(18,4),
  supplier_id          uuid references core.parties (id),
  dian_status          text not null check (dian_status in ('complete', 'errors') or dian_status ~ '^missing: [1-9][0-9]*$'),
  dian_missing         text[] not null default '{}',
  invoice_ready        boolean not null default false,
  is_active            boolean not null default true,
  extra                jsonb not null default '{}'::jsonb,
  extra_free           jsonb not null default '[]'::jsonb,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  created_by           uuid default kernel.current_user_id(),
  updated_by           uuid,
  unique (company_id, sku),
  unique (company_id, seq)
);
create index products_category_id_idx on core.products (category_id);
create index products_supplier_id_idx on core.products (supplier_id);
select core.setup_table('products', 'core.product');
create trigger compute_invoice_ready before insert or update on core.products
  for each row execute function core.compute_invoice_ready();

-- ---------------------------------------------------------------------------------------------
-- Price lists (processes arrive with the sales module).
-- ---------------------------------------------------------------------------------------------
create table core.price_lists (
  id            uuid primary key default kernel.uuid_v7(),
  seq           bigint not null,
  company_id    uuid not null references kernel.companies (id),
  name          text not null,
  currency_code char(3) not null default 'COP' references core.currencies (code),
  extra         jsonb not null default '{}'::jsonb,
  extra_free    jsonb not null default '[]'::jsonb,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  created_by    uuid default kernel.current_user_id(),
  updated_by    uuid,
  unique (company_id, name),
  unique (company_id, seq)
);
select core.setup_table('price_lists', 'core.price_list');

create table core.price_list_items (
  id            uuid primary key default kernel.uuid_v7(),
  seq           bigint not null,
  company_id    uuid not null references kernel.companies (id),
  price_list_id uuid not null references core.price_lists (id),
  product_id    uuid not null references core.products (id),
  price         numeric(18,4) not null check (price >= 0),
  extra         jsonb not null default '{}'::jsonb,
  extra_free    jsonb not null default '[]'::jsonb,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  created_by    uuid default kernel.current_user_id(),
  updated_by    uuid,
  unique (price_list_id, product_id),
  unique (company_id, seq)
);
create index price_list_items_product_id_idx on core.price_list_items (product_id);
select core.setup_table('price_list_items', 'core.price_list_item');
grant delete on core.price_list_items to authenticated;

-- ---------------------------------------------------------------------------------------------
-- Document number sequences (design §5.7): one row per (company, document type, prefix).
-- core.next_sequence takes the row lock with its update, so concurrent callers queue and numbers
-- are consecutive; the increment commits or rolls back with the caller's document. Users only read
-- the rows: numbers are drawn through core.next_sequence, which checks the company itself, so a
-- user can never rewind a counter. Configuring sequences (resolution, range) comes with its own process.
-- ---------------------------------------------------------------------------------------------
create table core.document_sequences (
  id            uuid primary key default kernel.uuid_v7(),
  seq           bigint not null,
  company_id    uuid not null references kernel.companies (id),
  document_type text not null,
  prefix        text not null default '',
  next_number   bigint not null default 1 check (next_number > 0),
  padding       int not null default 0 check (padding between 0 and 20),
  resolution    jsonb,
  extra         jsonb not null default '{}'::jsonb,
  extra_free    jsonb not null default '[]'::jsonb,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  created_by    uuid default kernel.current_user_id(),
  updated_by    uuid,
  unique (company_id, document_type, prefix),
  unique (company_id, seq)
);
select core.setup_table('document_sequences', 'core.document_sequence');
revoke insert, update on core.document_sequences from authenticated;

-- Returns prefix || number left-padded with zeros to `padding` digits (never truncated). A caller
-- with user claims may only draw from its active company; the service role draws for any company.
create or replace function core.next_sequence(p_company uuid, p_type text, p_prefix text) returns text
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_number  bigint;
  v_padding int;
begin
  if kernel.current_user_id() is not null
     and not (p_company = kernel.current_company_id() and array[p_company] <@ kernel.current_company_ids()) then
    raise exception 'company % is not the caller''s active company', p_company using errcode = 'insufficient_privilege';
  end if;
  update core.document_sequences
     set next_number = next_number + 1
   where company_id = p_company and document_type = p_type and prefix = p_prefix
  returning next_number - 1, padding into v_number, v_padding;
  if v_number is null then
    raise exception 'no document sequence % / % in company %', p_type, p_prefix, p_company using errcode = 'no_data_found';
  end if;
  return p_prefix || case when length(v_number::text) >= v_padding then v_number::text
                          else lpad(v_number::text, v_padding, '0') end;
end;
$$;
revoke execute on function core.next_sequence(uuid, text, text) from public, anon;
grant execute on function core.next_sequence(uuid, text, text) to authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- Masked read views (rule 14). Generated at authoring time by maskedViewSql
-- (packages/kernel/src/security/masked-views.ts) from the entity definitions in
-- packages/modules/core/src/entities.ts and pasted here; views.test.ts fails when they drift.
-- core.v_parties and core.v_party_contacts add the caller's party scope as a where clause.
-- ---------------------------------------------------------------------------------------------
create or replace view core.v_parties with (security_invoker = true) as
select
  "id",
  "company_id",
  case when (select kernel.field_visible('core.party', 'seq')) then "seq" else null end as "seq",
  case when (select kernel.field_visible('core.party', 'kind')) then "kind" else null end as "kind",
  case when (select kernel.field_visible('core.party', 'person_type')) then "person_type" else null end as "person_type",
  case when (select kernel.field_visible('core.party', 'document_type')) then "document_type" else null end as "document_type",
  case when (select kernel.field_visible('core.party', 'document_number')) then "document_number" else null end as "document_number",
  case when (select kernel.field_visible('core.party', 'check_digit')) then "check_digit" else null end as "check_digit",
  case when (select kernel.field_visible('core.party', 'legal_name')) then "legal_name" else null end as "legal_name",
  case when (select kernel.field_visible('core.party', 'first_surname')) then "first_surname" else null end as "first_surname",
  case when (select kernel.field_visible('core.party', 'second_surname')) then "second_surname" else null end as "second_surname",
  case when (select kernel.field_visible('core.party', 'first_name')) then "first_name" else null end as "first_name",
  case when (select kernel.field_visible('core.party', 'other_names')) then "other_names" else null end as "other_names",
  case when (select kernel.field_visible('core.party', 'trade_name')) then "trade_name" else null end as "trade_name",
  case when (select kernel.field_visible('core.party', 'tax_responsibilities')) then "tax_responsibilities" else null end as "tax_responsibilities",
  case when (select kernel.field_visible('core.party', 'tax_scheme')) then "tax_scheme" else null end as "tax_scheme",
  case when (select kernel.field_visible('core.party', 'ciiu')) then "ciiu" else null end as "ciiu",
  case when (select kernel.field_visible('core.party', 'country_code')) then "country_code" else null end as "country_code",
  case when (select kernel.field_visible('core.party', 'department_code')) then "department_code" else null end as "department_code",
  case when (select kernel.field_visible('core.party', 'municipality_code')) then "municipality_code" else null end as "municipality_code",
  case when (select kernel.field_visible('core.party', 'address_line')) then "address_line" else null end as "address_line",
  case when (select kernel.field_visible('core.party', 'postal_code')) then "postal_code" else null end as "postal_code",
  case when (select kernel.field_visible('core.party', 'invoice_email')) then "invoice_email" else null end as "invoice_email",
  case when (select kernel.field_visible('core.party', 'supplier_email')) then "supplier_email" else null end as "supplier_email",
  case when (select kernel.field_visible('core.party', 'phone_cc')) then "phone_cc" else null end as "phone_cc",
  case when (select kernel.field_visible('core.party', 'phone')) then "phone" else null end as "phone",
  case when (select kernel.field_visible('core.party', 'contact_name')) then "contact_name" else null end as "contact_name",
  case when (select kernel.field_visible('core.party', 'credit_limit')) then "credit_limit" else null end as "credit_limit",
  case when (select kernel.field_visible('core.party', 'balance')) then "balance" else null end as "balance",
  case when (select kernel.field_visible('core.party', 'dian_status')) then "dian_status" else null end as "dian_status",
  case when (select kernel.field_visible('core.party', 'dian_missing')) then "dian_missing" else null end as "dian_missing",
  case when (select kernel.field_visible('core.party', 'invoice_ready')) then "invoice_ready" else null end as "invoice_ready",
  case when (select kernel.field_visible('core.party', 'is_active')) then "is_active" else null end as "is_active",
  case when (select kernel.field_visible('core.party', 'extra')) then "extra" else null end as "extra",
  case when (select kernel.field_visible('core.party', 'extra_free')) then "extra_free" else null end as "extra_free",
  "created_at",
  "updated_at"
from core.parties
where core.party_scope_allows((select kernel.party_scope()), kind);
grant select on core.v_parties to authenticated;

create or replace view core.v_party_contacts with (security_invoker = true) as
select
  "id",
  "company_id",
  case when (select kernel.field_visible('core.party_contact', 'seq')) then "seq" else null end as "seq",
  case when (select kernel.field_visible('core.party_contact', 'party_id')) then "party_id" else null end as "party_id",
  case when (select kernel.field_visible('core.party_contact', 'name')) then "name" else null end as "name",
  case when (select kernel.field_visible('core.party_contact', 'job_title')) then "job_title" else null end as "job_title",
  case when (select kernel.field_visible('core.party_contact', 'email')) then "email" else null end as "email",
  case when (select kernel.field_visible('core.party_contact', 'phone_cc')) then "phone_cc" else null end as "phone_cc",
  case when (select kernel.field_visible('core.party_contact', 'phone')) then "phone" else null end as "phone",
  case when (select kernel.field_visible('core.party_contact', 'ext')) then "ext" else null end as "ext",
  case when (select kernel.field_visible('core.party_contact', 'mobile_cc')) then "mobile_cc" else null end as "mobile_cc",
  case when (select kernel.field_visible('core.party_contact', 'mobile')) then "mobile" else null end as "mobile",
  case when (select kernel.field_visible('core.party_contact', 'extra')) then "extra" else null end as "extra",
  case when (select kernel.field_visible('core.party_contact', 'extra_free')) then "extra_free" else null end as "extra_free",
  "created_at",
  "updated_at"
from core.party_contacts
where exists (
  select 1 from core.parties p
  where p.id = party_contacts.party_id and core.party_scope_allows((select kernel.party_scope()), p.kind)
);
grant select on core.v_party_contacts to authenticated;

create or replace view core.v_product_categories with (security_invoker = true) as
select
  "id",
  "company_id",
  case when (select kernel.field_visible('core.product_category', 'seq')) then "seq" else null end as "seq",
  case when (select kernel.field_visible('core.product_category', 'name')) then "name" else null end as "name",
  case when (select kernel.field_visible('core.product_category', 'iva_rate')) then "iva_rate" else null end as "iva_rate",
  case when (select kernel.field_visible('core.product_category', 'inc_rate')) then "inc_rate" else null end as "inc_rate",
  case when (select kernel.field_visible('core.product_category', 'other_taxes')) then "other_taxes" else null end as "other_taxes",
  case when (select kernel.field_visible('core.product_category', 'default_uom')) then "default_uom" else null end as "default_uom",
  case when (select kernel.field_visible('core.product_category', 'income_account')) then "income_account" else null end as "income_account",
  case when (select kernel.field_visible('core.product_category', 'status')) then "status" else null end as "status",
  case when (select kernel.field_visible('core.product_category', 'extra')) then "extra" else null end as "extra",
  case when (select kernel.field_visible('core.product_category', 'extra_free')) then "extra_free" else null end as "extra_free",
  "created_at",
  "updated_at"
from core.product_categories;
grant select on core.v_product_categories to authenticated;

create or replace view core.v_products with (security_invoker = true) as
select
  "id",
  "company_id",
  case when (select kernel.field_visible('core.product', 'seq')) then "seq" else null end as "seq",
  case when (select kernel.field_visible('core.product', 'sku')) then "sku" else null end as "sku",
  case when (select kernel.field_visible('core.product', 'description')) then "description" else null end as "description",
  case when (select kernel.field_visible('core.product', 'kind')) then "kind" else null end as "kind",
  case when (select kernel.field_visible('core.product', 'id_scheme')) then "id_scheme" else null end as "id_scheme",
  case when (select kernel.field_visible('core.product', 'standard_code')) then "standard_code" else null end as "standard_code",
  case when (select kernel.field_visible('core.product', 'brand')) then "brand" else null end as "brand",
  case when (select kernel.field_visible('core.product', 'model')) then "model" else null end as "model",
  case when (select kernel.field_visible('core.product', 'category_id')) then "category_id" else null end as "category_id",
  case when (select kernel.field_visible('core.product', 'uom_code')) then "uom_code" else null end as "uom_code",
  case when (select kernel.field_visible('core.product', 'iva_rate')) then "iva_rate" else null end as "iva_rate",
  case when (select kernel.field_visible('core.product', 'inc_rate')) then "inc_rate" else null end as "inc_rate",
  case when (select kernel.field_visible('core.product', 'other_taxes')) then "other_taxes" else null end as "other_taxes",
  case when (select kernel.field_visible('core.product', 'tax_override')) then "tax_override" else null end as "tax_override",
  case when (select kernel.field_visible('core.product', 'list_price')) then "list_price" else null end as "list_price",
  case when (select kernel.field_visible('core.product', 'is_free_sample')) then "is_free_sample" else null end as "is_free_sample",
  case when (select kernel.field_visible('core.product', 'reference_price_type')) then "reference_price_type" else null end as "reference_price_type",
  case when (select kernel.field_visible('core.product', 'reference_price')) then "reference_price" else null end as "reference_price",
  case when (select kernel.field_visible('core.product', 'standard_cost')) then "standard_cost" else null end as "standard_cost",
  case when (select kernel.field_visible('core.product', 'track_stock')) then "track_stock" else null end as "track_stock",
  case when (select kernel.field_visible('core.product', 'min_stock')) then "min_stock" else null end as "min_stock",
  case when (select kernel.field_visible('core.product', 'supplier_id')) then "supplier_id" else null end as "supplier_id",
  case when (select kernel.field_visible('core.product', 'dian_status')) then "dian_status" else null end as "dian_status",
  case when (select kernel.field_visible('core.product', 'dian_missing')) then "dian_missing" else null end as "dian_missing",
  case when (select kernel.field_visible('core.product', 'invoice_ready')) then "invoice_ready" else null end as "invoice_ready",
  case when (select kernel.field_visible('core.product', 'is_active')) then "is_active" else null end as "is_active",
  case when (select kernel.field_visible('core.product', 'extra')) then "extra" else null end as "extra",
  case when (select kernel.field_visible('core.product', 'extra_free')) then "extra_free" else null end as "extra_free",
  "created_at",
  "updated_at"
from core.products;
grant select on core.v_products to authenticated;

create or replace view core.v_price_lists with (security_invoker = true) as
select
  "id",
  "company_id",
  case when (select kernel.field_visible('core.price_list', 'seq')) then "seq" else null end as "seq",
  case when (select kernel.field_visible('core.price_list', 'name')) then "name" else null end as "name",
  case when (select kernel.field_visible('core.price_list', 'currency_code')) then "currency_code" else null end as "currency_code",
  case when (select kernel.field_visible('core.price_list', 'extra')) then "extra" else null end as "extra",
  case when (select kernel.field_visible('core.price_list', 'extra_free')) then "extra_free" else null end as "extra_free",
  "created_at",
  "updated_at"
from core.price_lists;
grant select on core.v_price_lists to authenticated;
