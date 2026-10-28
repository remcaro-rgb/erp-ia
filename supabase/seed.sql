-- The demo company of a local stack (Task 22). LOCAL USE ONLY.
--
-- Two halves, so that `supabase db reset` (and the Docker init job) can load what needs no registry, and the rest goes
-- through the real processes:
--   1. This file (applied after the migrations by `supabase db reset`, by the compose `db-init` job, and again, it is
--      idempotent, by `pnpm db:seed`): the tenant "Demo", the company Café del Norte S.A.S. (NIT 900373115-3), its roles
--      admin, gerente_comercial, contador and cajero, the Colombian required files, and the starter plan's entitlements
--      (module:core, module:support, limit:ai_tokens_month = 2000000).
--   2. `pnpm db:seed` (scripts/seed.ts, the compose `seed` job): registers the modules' manifests, enables the modules,
--      creates the Auth users laura@demo.local (admin + gerente comercial, TOTP) and marcela@demo.local (cajero) through
--      the Auth Admin API, seeds the company's role defaults, sets the permissions through the kernel.admin.* processes
--      as Laura with her step-up, creates 6 categories, 40 parties and 25 products through their processes, and offers
--      2 recommendations. The accounts are in README.md.
--
-- The ids are fixed (scripts/demo/accounts.ts) so both halves and the smoke test name the same rows. Users, memberships
-- and everything that reads the registry are not here: Auth users are created only through the Admin API, never by an
-- insert into auth.users.

insert into kernel.tenants (id, name)
values ('019a2c4e-0000-7000-8000-00000000d001', 'Demo')
on conflict (id) do nothing;

insert into kernel.companies (id, tenant_id, legal_name, trade_name, tax_id, country_code, currency_code, timezone)
values ('019a2c4e-0000-7000-8000-00000000d002', '019a2c4e-0000-7000-8000-00000000d001', 'Café del Norte S.A.S.', 'Café del Norte',
        '900373115', 'CO', 'COP', 'America/Bogota')
on conflict (id) do nothing;

insert into kernel.roles (id, company_id, name, is_system, party_scope, description)
values
  ('019a2c4e-0000-7000-8000-00000000d101', '019a2c4e-0000-7000-8000-00000000d002', 'admin', true, 'ambos',
   'Administra la empresa: usuarios, roles, permisos, módulos y auditoría'),
  ('019a2c4e-0000-7000-8000-00000000d102', '019a2c4e-0000-7000-8000-00000000d002', 'gerente_comercial', false, 'ambos',
   'Clientes, proveedores, productos y categorías; importa datos'),
  ('019a2c4e-0000-7000-8000-00000000d103', '019a2c4e-0000-7000-8000-00000000d002', 'contador', false, 'ambos',
   'Consulta terceros y productos para la contabilidad'),
  ('019a2c4e-0000-7000-8000-00000000d104', '019a2c4e-0000-7000-8000-00000000d002', 'cajero', false, 'clientes',
   'Caja: consulta clientes y productos; no ve el cupo de crédito')
on conflict (id) do nothing;

-- RUT and Cámara de Comercio for parties, the optional technical sheet for products (kernel.seed_required_attachments).
select kernel.seed_required_attachments('019a2c4e-0000-7000-8000-00000000d002');

-- The starter plan (0005): its modules and its monthly AI token allowance, for every company of the tenant.
insert into kernel.tenant_entitlements (tenant_id, key, source)
select '019a2c4e-0000-7000-8000-00000000d001', k.key, 'plan'
from kernel.plans p cross join unnest(p.included_keys) as k (key)
where p.id = 'starter'
  and not exists (
    select 1 from kernel.tenant_entitlements te
    where te.tenant_id = '019a2c4e-0000-7000-8000-00000000d001' and te.company_id is null and te.key = k.key
  );

insert into kernel.tenant_entitlements (tenant_id, key, limit_value, source)
select '019a2c4e-0000-7000-8000-00000000d001', 'limit:ai_tokens_month', (p.limits ->> 'ai_tokens_month')::numeric, 'plan'
from kernel.plans p
where p.id = 'starter'
  and not exists (
    select 1 from kernel.tenant_entitlements te
    where te.tenant_id = '019a2c4e-0000-7000-8000-00000000d001' and te.company_id is null and te.key = 'limit:ai_tokens_month'
  );
