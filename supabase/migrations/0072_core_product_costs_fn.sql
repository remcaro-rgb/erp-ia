-- 0072_core_product_costs_fn
-- Forward-only migration (rule 34). Covered by packages/modules/inventory/src/__tests__/adjustment.integration.test.ts.
-- Valuing an inventory adjustment is a computation, not a display: it must not depend on whether the caller's role may SEE the standard
-- cost (rule 14 governs what is shown). This function returns the standard cost of products of the caller's active company, unmasked,
-- for inventory's valuation only; it exposes nothing else and nothing outside the caller's company.

create or replace function core.product_standard_costs(p_ids uuid[]) returns table (id uuid, standard_cost numeric)
language sql stable security definer
set search_path = ''
as $$
  select p.id, p.standard_cost
  from core.products p
  where p.id = any (p_ids)
    and p.deleted_at is null
    and p.company_id = kernel.current_company_id()
    and array[p.company_id] <@ kernel.current_company_ids();
$$;
revoke execute on function core.product_standard_costs(uuid[]) from public, anon;
grant execute on function core.product_standard_costs(uuid[]) to authenticated, service_role;
