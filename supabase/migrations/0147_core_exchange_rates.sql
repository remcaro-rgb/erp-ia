-- 0147_core_exchange_rates
-- Forward-only migration (rule 34). Covered by packages/modules/core/src/__tests__/exchange-rate.integration.test.ts and views.test.ts
-- (the masked views). Plan 2B.2 Task 34.1 (FX design §2, §11 0147; owner items 121, 122; R34-2, R34-3):
--   * core.exchange_rates: one rate per company, currency and day (rule 7 columns, RLS, row audit, seq), in company currency per unit;
--     `source` trm (the daily import of the country's official rate) or manual (core.exchange_rate.set, or override_official over a TRM
--     row); `official_rate` keeps the published rate on a manual day (an override, or a manual day the import skipped). Written only by
--     the core.exchange_rate.* processes (restrictive policies on the process id); never deleted by a user session.
--   * core.v_exchange_rates: its masked view (maskedViewSql of core.exchange_rate), the only way other modules read rates (R34-2, rule 3);
--     it publishes company_id, currency, rate_date, rate and source with the rest.
--   * core.exchange_rate_imports: the import log, one row per company, currency and day asked for; a failed row is the subject of the
--     kernel recommendation core.trm_import_failed (one open per day, Task 38 API). Written only by core.exchange_rate.import_official.
--   * EUR in core.currencies (owner item 122: currencies without an official rate take manual rates).

insert into core.currencies (code, name, symbol) values ('EUR', 'Euro', '€') on conflict (code) do nothing;

create table core.exchange_rates (
  id            uuid primary key default kernel.uuid_v7(),
  seq           bigint not null,
  company_id    uuid not null references kernel.companies (id),
  currency      char(3) not null references core.currencies (code),
  rate_date     date not null,
  rate          numeric(18,6) not null check (rate > 0),
  source        text not null check (source in ('trm', 'manual')),
  official_rate numeric(18,6) check (official_rate is null or official_rate > 0),
  note          text check (note is null or char_length(note) <= 500),
  extra         jsonb not null default '{}'::jsonb,
  extra_free    jsonb not null default '[]'::jsonb,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  created_by    uuid default kernel.current_user_id(),
  updated_by    uuid,
  unique (company_id, seq),
  unique (company_id, currency, rate_date)
);

select kernel.enable_company_rls('core', 'exchange_rates');
select kernel.enable_row_audit('core', 'exchange_rates');
create trigger assign_seq before insert on core.exchange_rates for each row execute function core.assign_seq('core.exchange_rate');
create trigger touch_row before update on core.exchange_rates for each row execute function core.touch_row();

grant select, insert, update on core.exchange_rates to authenticated;
grant all on core.exchange_rates to service_role;

create policy via_process_insert on core.exchange_rates as restrictive for insert to authenticated
  with check (coalesce(current_setting('erp.audit_process_id', true), '') like 'core.exchange\_rate.%');
create policy via_process_update on core.exchange_rates as restrictive for update to authenticated
  using (coalesce(current_setting('erp.audit_process_id', true), '') like 'core.exchange\_rate.%')
  with check (coalesce(current_setting('erp.audit_process_id', true), '') like 'core.exchange\_rate.%');

create table core.exchange_rate_imports (
  id         uuid primary key default kernel.uuid_v7(),
  seq        bigint not null,
  company_id uuid not null references kernel.companies (id),
  currency   char(3) not null references core.currencies (code),
  rate_date  date not null,
  status     text not null check (status in ('imported', 'failed')),
  attempts   int not null default 1 check (attempts > 0),
  written    int not null default 0 check (written >= 0),
  error      text check (error is null or char_length(error) <= 500),
  extra      jsonb not null default '{}'::jsonb,
  extra_free jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid default kernel.current_user_id(),
  updated_by uuid,
  unique (company_id, seq),
  unique (company_id, currency, rate_date)
);

select kernel.enable_company_rls('core', 'exchange_rate_imports');
select kernel.enable_row_audit('core', 'exchange_rate_imports');
create trigger assign_seq before insert on core.exchange_rate_imports for each row execute function core.assign_seq('core.exchange_rate_import');
create trigger touch_row before update on core.exchange_rate_imports for each row execute function core.touch_row();

grant select, insert, update on core.exchange_rate_imports to authenticated;
grant all on core.exchange_rate_imports to service_role;

create policy via_process_insert on core.exchange_rate_imports as restrictive for insert to authenticated
  with check (coalesce(current_setting('erp.audit_process_id', true), '') = 'core.exchange_rate.import_official');
create policy via_process_update on core.exchange_rate_imports as restrictive for update to authenticated
  using (coalesce(current_setting('erp.audit_process_id', true), '') = 'core.exchange_rate.import_official')
  with check (coalesce(current_setting('erp.audit_process_id', true), '') = 'core.exchange_rate.import_official');

-- The masked views, generated from the entities (maskedViewSql; rule 14).
create or replace view core.v_exchange_rates with (security_invoker = true) as
select
  "id",
  "company_id",
  case when (select kernel.field_visible('core.exchange_rate', 'seq')) then "seq" else null end as "seq",
  case when (select kernel.field_visible('core.exchange_rate', 'currency')) then "currency" else null end as "currency",
  case when (select kernel.field_visible('core.exchange_rate', 'rate_date')) then "rate_date" else null end as "rate_date",
  case when (select kernel.field_visible('core.exchange_rate', 'rate')) then "rate" else null end as "rate",
  case when (select kernel.field_visible('core.exchange_rate', 'source')) then "source" else null end as "source",
  case when (select kernel.field_visible('core.exchange_rate', 'official_rate')) then "official_rate" else null end as "official_rate",
  case when (select kernel.field_visible('core.exchange_rate', 'note')) then "note" else null end as "note",
  case when (select kernel.field_visible('core.exchange_rate', 'extra')) then kernel.mask_extra('core.exchange_rate', "extra") else null end as "extra",
  case when (select kernel.field_visible('core.exchange_rate', 'extra_free')) then "extra_free" else null end as "extra_free",
  "created_at",
  "updated_at"
from core.exchange_rates;
grant select on core.v_exchange_rates to authenticated;
create or replace view core.v_exchange_rate_imports with (security_invoker = true) as
select
  "id",
  "company_id",
  case when (select kernel.field_visible('core.exchange_rate_import', 'seq')) then "seq" else null end as "seq",
  case when (select kernel.field_visible('core.exchange_rate_import', 'currency')) then "currency" else null end as "currency",
  case when (select kernel.field_visible('core.exchange_rate_import', 'rate_date')) then "rate_date" else null end as "rate_date",
  case when (select kernel.field_visible('core.exchange_rate_import', 'status')) then "status" else null end as "status",
  case when (select kernel.field_visible('core.exchange_rate_import', 'attempts')) then "attempts" else null end as "attempts",
  case when (select kernel.field_visible('core.exchange_rate_import', 'written')) then "written" else null end as "written",
  case when (select kernel.field_visible('core.exchange_rate_import', 'error')) then "error" else null end as "error",
  case when (select kernel.field_visible('core.exchange_rate_import', 'extra')) then kernel.mask_extra('core.exchange_rate_import', "extra") else null end as "extra",
  case when (select kernel.field_visible('core.exchange_rate_import', 'extra_free')) then "extra_free" else null end as "extra_free",
  "created_at",
  "updated_at"
from core.exchange_rate_imports;
grant select on core.v_exchange_rate_imports to authenticated;

