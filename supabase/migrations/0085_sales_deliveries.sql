-- 0085_sales_deliveries
-- Forward-only migration (rule 34). Covered by packages/modules/sales/src/__tests__/delivery.integration.test.ts (sales, inventory,
-- costing and accounting loaded together, the real posting engine on the demo chart) and packages/modules/sales/src/__tests__/entities.test.ts
-- (the masked views match the entity definitions).
-- Plan 2B Task 14 (the plan named it 0065; 0085 was the next free number), design §8.1 steps 3–4:
--   * the pedido's delivery stages: partially_delivered and delivered beside open, confirmed and cancelled; a pedido past confirmation
--     keeps what was confirmed (the frozen trigger now covers every firm stage) and its credit exposure counts while it is firm (INTERIM,
--     Task 16 redefines sales.credit_exposure as "pedidos not yet invoiced + open issued invoices");
--   * sales.deliveries (remisiones: a documento numbered REM- on save, never posted itself) with sales.delivery_lines (each names the
--     pedido line it delivers, `invoiced_qty` for invoicing to maintain, Task 16), and sales.returns (devoluciones, DEV-) with
--     sales.return_lines (each names the remisión line it returns);
--   * what inventory could not do of a despacho or an Anular (stock_refusal, stock_refused_at): inventory refuses a sale issue (or the
--     void of a sale return) it cannot apply and says so by event; sales puts the remisión back to open (the devolución back to
--     received) with the reason (Task 14 review). The stock sales reads at ship is inventory's own migration (0087, rule 3).
-- Every table: uuid v7, company, seq, extra / extra_free, audit columns, company RLS, row audit, and writes only through the module's
-- processes (restrictive policies on erp.audit_process_id). The bodega and the cost center are other modules' records, named by id: no
-- foreign key leaves the schema (rule 3).

-- =============================================================================================
-- Pedidos: the delivery stages
-- =============================================================================================
alter table sales.orders drop constraint orders_stage_check;
alter table sales.orders add constraint orders_stage_check check (stage in ('open', 'confirmed', 'partially_delivered', 'delivered', 'cancelled'));
alter table sales.orders drop constraint orders_check1;
alter table sales.orders add constraint orders_firm_confirmed_check check (stage not in ('confirmed', 'partially_delivered', 'delivered') or confirmed_at is not null);

-- A firm pedido (confirmed, partially delivered or delivered) keeps what was confirmed: its customer, currency, dates, bodega and amounts
-- never change and it never reopens; its stage moves between the firm stages as remisiones ship and are voided, and to cancelled (which the
-- process refuses once anything was delivered). A cancelled one stays cancelled.
create or replace function sales.order_confirmed_frozen() returns trigger
language plpgsql
as $$
begin
  if old.stage = 'cancelled' and new.stage <> 'cancelled' then
    raise exception 'erp:invalid_input:Un pedido cancelado no vuelve a abrirse';
  end if;
  if old.stage in ('confirmed', 'partially_delivered', 'delivered') and (new.stage = 'open' or (
       new.party_id, new.quote_id, new.opportunity_id, new.warehouse_id, new.issue_date, new.delivery_date, new.currency, new.exchange_rate,
       new.subtotal, new.discount_total, new.tax_total, new.total, new.total_company, new.max_discount_pct, new.confirmed_at
     ) is distinct from (
       old.party_id, old.quote_id, old.opportunity_id, old.warehouse_id, old.issue_date, old.delivery_date, old.currency, old.exchange_rate,
       old.subtotal, old.discount_total, old.tax_total, old.total, old.total_company, old.max_discount_pct, old.confirmed_at
     )) then
    raise exception 'erp:invalid_input:Un pedido confirmado no cambia';
  end if;
  return new;
end;
$$;

create or replace function sales.order_lines_locked() returns trigger
language plpgsql
as $$
declare
  v_order uuid := case when tg_op = 'DELETE' then old.order_id else new.order_id end;
  v_stage text;
  v_status text;
begin
  select stage, status into v_stage, v_status from sales.orders where id = v_order;
  if v_stage = 'open' and v_status in ('draft', 'saved', 'rejected') then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if v_stage in ('confirmed', 'partially_delivered', 'delivered') then
    raise exception 'erp:invalid_input:Las líneas de un pedido confirmado no cambian';
  end if;
  raise exception 'erp:invalid_input:Las líneas de un pedido solo cambian mientras está abierto y sin aprobar';
end;
$$;

-- The customer's credit (0084), now counting every firm pedido: a partially delivered or delivered pedido is still owed until it is
-- invoiced and paid. INTERIM until Task 16 (invoicing) replaces this function with "firm pedidos not yet invoiced + open issued invoices".
create or replace function sales.credit_exposure(p_party uuid, p_except uuid)
returns table (credit_limit numeric, exposure numeric)
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_company uuid := kernel.current_company_id();
begin
  if v_company is null or not (array[v_company] <@ kernel.current_company_ids()) then
    raise exception 'no active company' using errcode = 'insufficient_privilege';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('sales.credit:' || v_company::text || ':' || p_party::text, 0));
  return query
    select (select t.credit_limit from sales.customer_terms t where t.company_id = v_company and t.party_id = p_party),
           coalesce((select sum(o.total_company) from sales.orders o
                     where o.company_id = v_company and o.party_id = p_party and o.stage in ('confirmed', 'partially_delivered', 'delivered')
                       and o.status <> 'voided' and o.id is distinct from p_except), 0);
end;
$$;

-- =============================================================================================
-- Remisiones (entregas)
-- =============================================================================================
-- `stage`: open (written) → shipped (the goods left: sales.delivery.shipped). `cost_center_id` is accounting's id, carried to the cost of
-- sales (the demo chart's 613595 requires one). `warehouse_id` is inventory's bodega the goods leave from.
create table sales.deliveries (
  id             uuid primary key default kernel.uuid_v7(),
  seq            bigint not null,
  company_id     uuid not null references kernel.companies (id),
  number         text,
  order_id       uuid not null references sales.orders (id),
  party_id       uuid not null,
  warehouse_id   uuid not null,
  date           date not null,
  stage          text not null default 'open' check (stage in ('open', 'shipped')),
  shipped_at     timestamptz,
  stock_refusal  text check (stock_refusal is null or char_length(stock_refusal) <= 2000),
  stock_refused_at timestamptz,
  cost_center_id uuid,
  notes          text check (notes is null or char_length(notes) <= 2000),
  extra          jsonb not null default '{}'::jsonb,
  extra_free     jsonb not null default '[]'::jsonb,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  created_by     uuid default kernel.current_user_id(),
  updated_by     uuid,
  unique (company_id, seq),
  unique (company_id, number),
  check ((stage = 'shipped') = (shipped_at is not null))
);
create index deliveries_order_idx on sales.deliveries (company_id, order_id);

-- Lines: the pedido line delivered, its product (copied), the quantity; what invoicing billed of it (Task 16); and when inventory issued it
-- (the sale issue movement, recorded by sales' consumer of inventory.movement.posted).
create table sales.delivery_lines (
  id              uuid primary key default kernel.uuid_v7(),
  seq             bigint not null,
  company_id      uuid not null references kernel.companies (id),
  delivery_id     uuid not null references sales.deliveries (id),
  line_no         int not null check (line_no > 0),
  order_line_id   uuid not null references sales.order_lines (id),
  product_id      uuid not null,
  description     text check (description is null or char_length(description) <= 300),
  qty             numeric(18,4) not null check (qty > 0),
  invoiced_qty    numeric(18,4) not null default 0 check (invoiced_qty >= 0 and invoiced_qty <= qty),
  movement_id     uuid,
  stock_posted_at timestamptz,
  extra           jsonb not null default '{}'::jsonb,
  extra_free      jsonb not null default '[]'::jsonb,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  created_by      uuid default kernel.current_user_id(),
  updated_by      uuid,
  unique (company_id, seq),
  unique (delivery_id, line_no),
  unique (delivery_id, order_line_id)
);
create index delivery_lines_order_line_idx on sales.delivery_lines (company_id, order_line_id);
create index delivery_lines_product_idx on sales.delivery_lines (company_id, product_id) where stock_posted_at is null;

-- =============================================================================================
-- Devoluciones
-- =============================================================================================
create table sales.returns (
  id             uuid primary key default kernel.uuid_v7(),
  seq            bigint not null,
  company_id     uuid not null references kernel.companies (id),
  number         text,
  delivery_id    uuid not null references sales.deliveries (id),
  order_id       uuid not null references sales.orders (id),
  party_id       uuid not null,
  warehouse_id   uuid not null,
  date           date not null,
  stage          text not null default 'open' check (stage in ('open', 'received')),
  received_at    timestamptz,
  reason         text not null check (char_length(reason) between 1 and 500),
  stock_refusal  text check (stock_refusal is null or char_length(stock_refusal) <= 2000),
  stock_refused_at timestamptz,
  cost_center_id uuid,
  notes          text check (notes is null or char_length(notes) <= 2000),
  extra          jsonb not null default '{}'::jsonb,
  extra_free     jsonb not null default '[]'::jsonb,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  created_by     uuid default kernel.current_user_id(),
  updated_by     uuid,
  unique (company_id, seq),
  unique (company_id, number),
  check ((stage = 'received') = (received_at is not null))
);
create index returns_delivery_idx on sales.returns (company_id, delivery_id);

create table sales.return_lines (
  id               uuid primary key default kernel.uuid_v7(),
  seq              bigint not null,
  company_id       uuid not null references kernel.companies (id),
  return_id        uuid not null references sales.returns (id),
  line_no          int not null check (line_no > 0),
  delivery_line_id uuid not null references sales.delivery_lines (id),
  product_id       uuid not null,
  qty              numeric(18,4) not null check (qty > 0),
  extra            jsonb not null default '{}'::jsonb,
  extra_free       jsonb not null default '[]'::jsonb,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  created_by       uuid default kernel.current_user_id(),
  updated_by       uuid,
  unique (company_id, seq),
  unique (return_id, line_no),
  unique (return_id, delivery_line_id)
);
create index return_lines_delivery_line_idx on sales.return_lines (company_id, delivery_line_id);

-- =============================================================================================
-- RLS, audit, seq, the typed lifecycle, grants and the writes through the processes
-- =============================================================================================
select kernel.enable_company_rls('sales', 'deliveries');
select kernel.enable_company_rls('sales', 'delivery_lines');
select kernel.enable_company_rls('sales', 'returns');
select kernel.enable_company_rls('sales', 'return_lines');
select kernel.enable_row_audit('sales', 'deliveries');
select kernel.enable_row_audit('sales', 'delivery_lines');
select kernel.enable_row_audit('sales', 'returns');
select kernel.enable_row_audit('sales', 'return_lines');
create trigger assign_seq before insert on sales.deliveries     for each row execute function core.assign_seq('sales.delivery');
create trigger assign_seq before insert on sales.delivery_lines for each row execute function core.assign_seq('sales.delivery_line');
create trigger assign_seq before insert on sales.returns        for each row execute function core.assign_seq('sales.return');
create trigger assign_seq before insert on sales.return_lines   for each row execute function core.assign_seq('sales.return_line');
create trigger touch_row before update on sales.deliveries     for each row execute function core.touch_row();
create trigger touch_row before update on sales.delivery_lines for each row execute function core.touch_row();
create trigger touch_row before update on sales.returns        for each row execute function core.touch_row();
create trigger touch_row before update on sales.return_lines   for each row execute function core.touch_row();

select kernel.typed_columns('sales', 'deliveries', 'documento', 'sales.delivery');
select kernel.typed_lines('sales', 'delivery_lines', 'sales.delivery', 'delivery_id');
select kernel.typed_columns('sales', 'returns', 'documento', 'sales.return');
select kernel.typed_lines('sales', 'return_lines', 'sales.return', 'return_id');

-- Grants: the handlers run as the caller. A Borrador (never numbered) may be deleted by the lifecycle (D1).
grant select, insert, update, delete on sales.deliveries, sales.delivery_lines, sales.returns, sales.return_lines to authenticated;
grant all on sales.deliveries, sales.delivery_lines, sales.returns, sales.return_lines to service_role;

do $$
declare
  t text;
begin
  foreach t in array array['deliveries', 'delivery_lines', 'returns', 'return_lines'] loop
    execute format($p$create policy via_process_insert on sales.%I as restrictive for insert to authenticated
      with check (coalesce(current_setting('erp.audit_process_id', true), '') like 'sales.%%')$p$, t);
    execute format($p$create policy via_process_update on sales.%I as restrictive for update to authenticated
      using (coalesce(current_setting('erp.audit_process_id', true), '') like 'sales.%%')
      with check (coalesce(current_setting('erp.audit_process_id', true), '') like 'sales.%%')$p$, t);
    execute format($p$create policy via_process_delete on sales.%I as restrictive for delete to authenticated
      using (coalesce(current_setting('erp.audit_process_id', true), '') like 'sales.%%')$p$, t);
  end loop;
end;
$$;

-- Eliminar (D1): only a Borrador (0084's function).
create trigger delete_draft_only before delete on sales.deliveries for each row execute function sales.document_delete_draft_only();
create trigger delete_draft_only before delete on sales.returns    for each row execute function sales.document_delete_draft_only();

-- A shipped remisión (a received devolución) keeps what left (came back): its pedido, customer, bodega, date, cost center and stage never
-- change; only its lifecycle status (Anulado) and reason move. An open one changes through its processes. Two compensations of inventory's
-- refusal (Task 14 review) are the only way back: sales.delivery.reopen puts a shipped remisión whose stock was never issued (no line has
-- stock_posted_at) back to open, and sales.return.restore puts a voided received devolución whose stock inventory could not take back to
-- Grabado again. A remisión with anything invoiced (invoiced_qty, Task 16) is never voided, whoever writes.
create or replace function sales.delivery_shipped_frozen() returns trigger
language plpgsql
as $$
declare
  v_process text := coalesce(current_setting('erp.audit_process_id', true), '');
begin
  if old.stage = 'shipped' and new.stage = 'open' and v_process = 'sales.delivery.reopen' and old.status = 'saved' and new.status = 'saved'
     and not exists (select 1 from sales.delivery_lines l where l.delivery_id = old.id and l.stock_posted_at is not null)
     and (new.order_id, new.party_id, new.warehouse_id, new.date, new.cost_center_id)
         is not distinct from (old.order_id, old.party_id, old.warehouse_id, old.date, old.cost_center_id) then
    return new;
  end if;
  if old.stage = 'shipped' and (
       (new.stage, new.order_id, new.party_id, new.warehouse_id, new.date, new.shipped_at, new.cost_center_id)
       is distinct from (old.stage, old.order_id, old.party_id, old.warehouse_id, old.date, old.shipped_at, old.cost_center_id)) then
    raise exception 'erp:invalid_input:Una remisión despachada no cambia: anúlala';
  end if;
  if old.status = 'voided' and new.stage <> old.stage then
    raise exception 'erp:invalid_input:Una remisión anulada no cambia';
  end if;
  if new.status = 'voided' and old.status <> 'voided'
     and exists (select 1 from sales.delivery_lines l where l.delivery_id = old.id and l.invoiced_qty > 0) then
    raise exception 'erp:invalid_input:Una remisión con unidades facturadas no se anula';
  end if;
  return new;
end;
$$;
create trigger delivery_shipped_frozen before update on sales.deliveries for each row execute function sales.delivery_shipped_frozen();

create or replace function sales.return_received_frozen() returns trigger
language plpgsql
as $$
declare
  v_process text := coalesce(current_setting('erp.audit_process_id', true), '');
begin
  if old.status = 'voided' and new.status = 'saved' and old.stage = 'received' and new.stage = 'received' and v_process = 'sales.return.restore' then
    return new;
  end if;
  if old.stage = 'received' and (
       (new.stage, new.delivery_id, new.order_id, new.party_id, new.warehouse_id, new.date, new.received_at, new.cost_center_id)
       is distinct from (old.stage, old.delivery_id, old.order_id, old.party_id, old.warehouse_id, old.date, old.received_at, old.cost_center_id)) then
    raise exception 'erp:invalid_input:Una devolución recibida no cambia: anúlala';
  end if;
  if old.status = 'voided' and (new.stage <> old.stage or new.status <> old.status) then
    raise exception 'erp:invalid_input:Una devolución anulada no cambia';
  end if;
  return new;
end;
$$;
create trigger return_received_frozen before update on sales.returns for each row execute function sales.return_received_frozen();

-- The lines are written while their remisión is open and editable (Borrador or Grabado, not shipped, not voided). Once it shipped, a line
-- changes only in what follows it: what invoicing billed (invoiced_qty, Task 16) and when inventory issued it (movement_id, stock_posted_at).
create or replace function sales.delivery_lines_locked() returns trigger
language plpgsql
as $$
declare
  v_delivery uuid := case when tg_op = 'DELETE' then old.delivery_id else new.delivery_id end;
  v_stage text;
  v_status text;
begin
  select stage, status into v_stage, v_status from sales.deliveries where id = v_delivery;
  if v_stage = 'open' and v_status in ('draft', 'saved') then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if tg_op = 'UPDATE' and (new.delivery_id, new.line_no, new.order_line_id, new.product_id, new.description, new.qty)
       is not distinct from (old.delivery_id, old.line_no, old.order_line_id, old.product_id, old.description, old.qty) then
    -- Invoicing (Task 16, through its event consumer in sales) never bills a voided remisión: it re-checks the remisión under its lock.
    if v_status = 'voided' and new.invoiced_qty > old.invoiced_qty then
      raise exception 'erp:invalid_input:Una remisión anulada no se factura';
    end if;
    return new;
  end if;
  raise exception 'erp:invalid_input:Las líneas de una remisión despachada o anulada no cambian';
end;
$$;
create trigger delivery_lines_locked before insert or update or delete on sales.delivery_lines
  for each row execute function sales.delivery_lines_locked();

create or replace function sales.return_lines_locked() returns trigger
language plpgsql
as $$
declare
  v_return uuid := case when tg_op = 'DELETE' then old.return_id else new.return_id end;
  v_stage text;
  v_status text;
begin
  select stage, status into v_stage, v_status from sales.returns where id = v_return;
  if v_stage = 'open' and v_status in ('draft', 'saved') then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  raise exception 'erp:invalid_input:Las líneas de una devolución recibida o anulada no cambian';
end;
$$;
create trigger return_lines_locked before insert or update or delete on sales.return_lines
  for each row execute function sales.return_lines_locked();

-- The entity -> table rows syncModuleManifest also writes (an upsert there), so the usability gate, the reference check and Versiones work
-- from the migration on.
insert into kernel.entity_tables (entity, module_id, entity_type, table_schema, table_name, lines_entity) values
  ('sales.delivery', 'sales', 'documento', 'sales', 'deliveries', 'sales.delivery_line'),
  ('sales.return', 'sales', 'documento', 'sales', 'returns', 'sales.return_line')
on conflict (entity) do nothing;

select kernel.register_reference('core.party',   'sales', 'deliveries',     'party_id');
select kernel.register_reference('core.product', 'sales', 'delivery_lines', 'product_id');
select kernel.register_reference('core.party',   'sales', 'returns',        'party_id');
select kernel.register_reference('core.product', 'sales', 'return_lines',   'product_id');

-- =============================================================================================
-- Masked read views (rule 14). Generated by maskedViewSql (packages/kernel/src/security/masked-views.ts) from
-- packages/modules/sales/src/entities.ts and pasted here; the entities test fails when they drift.
-- =============================================================================================

create or replace view sales.v_deliveries with (security_invoker = true) as
select
  "id",
  "company_id",
  case when (select kernel.field_visible('sales.delivery', 'seq')) then "seq" else null end as "seq",
  case when (select kernel.field_visible('sales.delivery', 'number')) then "number" else null end as "number",
  case when (select kernel.field_visible('sales.delivery', 'order_id')) then "order_id" else null end as "order_id",
  case when (select kernel.field_visible('sales.delivery', 'party_id')) then "party_id" else null end as "party_id",
  case when (select kernel.field_visible('sales.delivery', 'warehouse_id')) then "warehouse_id" else null end as "warehouse_id",
  case when (select kernel.field_visible('sales.delivery', 'date')) then "date" else null end as "date",
  case when (select kernel.field_visible('sales.delivery', 'stage')) then "stage" else null end as "stage",
  case when (select kernel.field_visible('sales.delivery', 'shipped_at')) then "shipped_at" else null end as "shipped_at",
  case when (select kernel.field_visible('sales.delivery', 'stock_refusal')) then "stock_refusal" else null end as "stock_refusal",
  case when (select kernel.field_visible('sales.delivery', 'stock_refused_at')) then "stock_refused_at" else null end as "stock_refused_at",
  case when (select kernel.field_visible('sales.delivery', 'cost_center_id')) then "cost_center_id" else null end as "cost_center_id",
  case when (select kernel.field_visible('sales.delivery', 'notes')) then "notes" else null end as "notes",
  case when (select kernel.field_visible('sales.delivery', 'extra')) then kernel.mask_extra('sales.delivery', "extra") else null end as "extra",
  case when (select kernel.field_visible('sales.delivery', 'extra_free')) then "extra_free" else null end as "extra_free",
  "created_at",
  "updated_at",
  case when (select kernel.field_visible('sales.delivery', 'status')) then "status" else null end as "status",
  case when (select kernel.field_visible('sales.delivery', 'requires_approval')) then "requires_approval" else null end as "requires_approval",
  case when (select kernel.field_visible('sales.delivery', 'posts')) then "posts" else null end as "posts",
  case when (select kernel.field_visible('sales.delivery', 'void_reason')) then "void_reason" else null end as "void_reason"
from sales.deliveries;
grant select on sales.v_deliveries to authenticated;
create or replace view sales.v_delivery_lines with (security_invoker = true) as
select
  "id",
  "company_id",
  case when (select kernel.field_visible('sales.delivery_line', 'seq')) then "seq" else null end as "seq",
  case when (select kernel.field_visible('sales.delivery_line', 'delivery_id')) then "delivery_id" else null end as "delivery_id",
  case when (select kernel.field_visible('sales.delivery_line', 'line_no')) then "line_no" else null end as "line_no",
  case when (select kernel.field_visible('sales.delivery_line', 'order_line_id')) then "order_line_id" else null end as "order_line_id",
  case when (select kernel.field_visible('sales.delivery_line', 'product_id')) then "product_id" else null end as "product_id",
  case when (select kernel.field_visible('sales.delivery_line', 'description')) then "description" else null end as "description",
  case when (select kernel.field_visible('sales.delivery_line', 'qty')) then "qty" else null end as "qty",
  case when (select kernel.field_visible('sales.delivery_line', 'invoiced_qty')) then "invoiced_qty" else null end as "invoiced_qty",
  case when (select kernel.field_visible('sales.delivery_line', 'movement_id')) then "movement_id" else null end as "movement_id",
  case when (select kernel.field_visible('sales.delivery_line', 'stock_posted_at')) then "stock_posted_at" else null end as "stock_posted_at",
  case when (select kernel.field_visible('sales.delivery_line', 'extra')) then kernel.mask_extra('sales.delivery_line', "extra") else null end as "extra",
  case when (select kernel.field_visible('sales.delivery_line', 'extra_free')) then "extra_free" else null end as "extra_free",
  "created_at",
  "updated_at"
from sales.delivery_lines;
grant select on sales.v_delivery_lines to authenticated;
create or replace view sales.v_returns with (security_invoker = true) as
select
  "id",
  "company_id",
  case when (select kernel.field_visible('sales.return', 'seq')) then "seq" else null end as "seq",
  case when (select kernel.field_visible('sales.return', 'number')) then "number" else null end as "number",
  case when (select kernel.field_visible('sales.return', 'delivery_id')) then "delivery_id" else null end as "delivery_id",
  case when (select kernel.field_visible('sales.return', 'order_id')) then "order_id" else null end as "order_id",
  case when (select kernel.field_visible('sales.return', 'party_id')) then "party_id" else null end as "party_id",
  case when (select kernel.field_visible('sales.return', 'warehouse_id')) then "warehouse_id" else null end as "warehouse_id",
  case when (select kernel.field_visible('sales.return', 'date')) then "date" else null end as "date",
  case when (select kernel.field_visible('sales.return', 'stage')) then "stage" else null end as "stage",
  case when (select kernel.field_visible('sales.return', 'received_at')) then "received_at" else null end as "received_at",
  case when (select kernel.field_visible('sales.return', 'reason')) then "reason" else null end as "reason",
  case when (select kernel.field_visible('sales.return', 'stock_refusal')) then "stock_refusal" else null end as "stock_refusal",
  case when (select kernel.field_visible('sales.return', 'stock_refused_at')) then "stock_refused_at" else null end as "stock_refused_at",
  case when (select kernel.field_visible('sales.return', 'cost_center_id')) then "cost_center_id" else null end as "cost_center_id",
  case when (select kernel.field_visible('sales.return', 'notes')) then "notes" else null end as "notes",
  case when (select kernel.field_visible('sales.return', 'extra')) then kernel.mask_extra('sales.return', "extra") else null end as "extra",
  case when (select kernel.field_visible('sales.return', 'extra_free')) then "extra_free" else null end as "extra_free",
  "created_at",
  "updated_at",
  case when (select kernel.field_visible('sales.return', 'status')) then "status" else null end as "status",
  case when (select kernel.field_visible('sales.return', 'requires_approval')) then "requires_approval" else null end as "requires_approval",
  case when (select kernel.field_visible('sales.return', 'posts')) then "posts" else null end as "posts",
  case when (select kernel.field_visible('sales.return', 'void_reason')) then "void_reason" else null end as "void_reason"
from sales.returns;
grant select on sales.v_returns to authenticated;
create or replace view sales.v_return_lines with (security_invoker = true) as
select
  "id",
  "company_id",
  case when (select kernel.field_visible('sales.return_line', 'seq')) then "seq" else null end as "seq",
  case when (select kernel.field_visible('sales.return_line', 'return_id')) then "return_id" else null end as "return_id",
  case when (select kernel.field_visible('sales.return_line', 'line_no')) then "line_no" else null end as "line_no",
  case when (select kernel.field_visible('sales.return_line', 'delivery_line_id')) then "delivery_line_id" else null end as "delivery_line_id",
  case when (select kernel.field_visible('sales.return_line', 'product_id')) then "product_id" else null end as "product_id",
  case when (select kernel.field_visible('sales.return_line', 'qty')) then "qty" else null end as "qty",
  case when (select kernel.field_visible('sales.return_line', 'extra')) then kernel.mask_extra('sales.return_line', "extra") else null end as "extra",
  case when (select kernel.field_visible('sales.return_line', 'extra_free')) then "extra_free" else null end as "extra_free",
  "created_at",
  "updated_at"
from sales.return_lines;
grant select on sales.v_return_lines to authenticated;
