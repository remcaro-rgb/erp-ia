-- 0009_kernel_verifiers
-- Forward-only migration (rule 34). Covered by packages/kernel/src/__tests__/verify.integration.test.ts
-- External verification hooks (design §5.16, rule 11): the provider the company chose per kind of
-- datum (e-mail, phone, identification) and the requests made. While no provider is configured a
-- request is queued and the UI shows "en cola".

-- One row per kind. `config` holds non-secret options; provider keys live in Supabase Vault (rule 12).
create table kernel.verifiers (
  company_id uuid not null references kernel.companies (id),
  kind       text not null check (kind in ('email', 'phone', 'document')),
  provider   text check (provider is null or btrim(provider) <> ''),
  config     jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid default kernel.current_user_id(),
  updated_by uuid,
  primary key (company_id, kind)
);
create trigger verifiers_touch_updated before update on kernel.verifiers
  for each row execute function kernel.touch_updated();

grant select, insert, update, delete on kernel.verifiers to authenticated;
grant all on kernel.verifiers to service_role;

select kernel.enable_company_rls('kernel', 'verifiers');
create policy admin_insert on kernel.verifiers as restrictive for insert to authenticated
  with check ((select kernel.is_company_admin()));
create policy admin_update on kernel.verifiers as restrictive for update to authenticated
  using ((select kernel.is_company_admin())) with check ((select kernel.is_company_admin()));
create policy admin_delete on kernel.verifiers as restrictive for delete to authenticated
  using ((select kernel.is_company_admin()));
select kernel.enable_row_audit('kernel', 'verifiers');

-- Requests. Immutable: kernel.verify.request inserts the row with its final status ('queued' when
-- there is no provider yet, else 'verified' or 'failed' from the provider's answer).
create table kernel.verification_requests (
  id         uuid primary key default kernel.uuid_v7(),
  company_id uuid not null references kernel.companies (id),
  kind       text not null check (kind in ('email', 'phone', 'document')),
  value      text not null check (btrim(value) <> ''),
  entity     text not null check (entity ~ '^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$'),
  record_id  uuid not null,
  status     text not null check (status in ('queued', 'verified', 'failed')),
  provider   text,
  result     jsonb,
  created_at timestamptz not null default now(),
  created_by uuid default kernel.current_user_id()
);
create index verification_requests_record_idx on kernel.verification_requests (company_id, entity, record_id, kind, created_at desc);

grant select, insert on kernel.verification_requests to authenticated;
grant all on kernel.verification_requests to service_role;
select kernel.enable_company_rls('kernel', 'verification_requests');
select kernel.enable_row_audit('kernel', 'verification_requests');

-- Writes only through the process pipeline (rule 1), as for attachments (0007).
create policy via_process_insert on kernel.verification_requests as restrictive for insert to authenticated
  with check (coalesce(current_setting('erp.audit_process_id', true), '') like 'kernel.verify.%');
