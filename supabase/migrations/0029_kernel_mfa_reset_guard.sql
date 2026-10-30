-- 0029_kernel_mfa_reset_guard
-- Forward-only migration (rule 34). Covered by packages/kernel/src/users/__tests__/mfa.integration.test.ts and
-- packages/modules/core/src/__tests__/admin.integration.test.ts (kernel.admin.user.create's guard).
--
-- Two-step verification opt-out (design §22.19): kernel.admin.user.mfa.set { reset } removes the identity's factor, so it
-- must never reach a user who also belongs to another organization (their other tenant's second step would go with it).
-- The handler asks 0021's kernel.user_in_other_tenant(user) before any adapter call, as kernel.admin.user.create does.
-- 0021's body admits only kernel.admin.user.create; this repeats it with kernel.admin.user.mfa.set also admitted. Same
-- signature, same answer (whether the user has a membership in a company of another tenant, nothing more), same grants.
-- The exemption stays per membership and needs no guard.

create or replace function kernel.user_in_other_tenant(p_user uuid) returns boolean
language plpgsql stable security definer
set search_path = ''
as $$
begin
  if not (kernel.is_company_admin()
          and coalesce(current_setting('erp.audit_process_id', true), '') in ('kernel.admin.user.create', 'kernel.admin.user.mfa.set')) then
    raise exception 'only the company admin, inside kernel.admin.user.create or kernel.admin.user.mfa.set, may ask' using errcode = '42501';
  end if;
  return exists (
    select 1 from kernel.memberships m join kernel.companies c on c.id = m.company_id
    where m.user_id = p_user and c.tenant_id is distinct from kernel.current_tenant_id()
  );
end;
$$;
revoke execute on function kernel.user_in_other_tenant(uuid) from public, anon;
grant execute on function kernel.user_in_other_tenant(uuid) to authenticated, service_role;
