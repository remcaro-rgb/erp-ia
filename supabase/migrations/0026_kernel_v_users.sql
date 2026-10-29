-- 0026_kernel_v_users
-- Forward-only migration (rule 34). Covered by packages/kernel/src/users/__tests__/users.integration.test.ts.
-- Every entity reference is a link (design §22.15, rule 21): a ticket's reporter, an audit actor and any other reference
-- to a user name that user and lead to their page. kernel.v_users is the read view of the registry entity `kernel.user`
-- (packages/kernel/src/users/entity.ts), which its grid, its lookups, the label of a reference and kernel.user.consult
-- read (rule 14: one view for every channel).
--   * The members of the caller's active company only, and only for a caller whose membership there is active (0025,
--     kernel.memberships.is_active): a user of another organization is never listed. A deactivated member is still
--     listed (their name stays on the records and the audit they are referenced from), but reads nothing here.
--   * Each field under the caller's field visibility (kernel.field_visible, as every masked view): the mobile is
--     confidential, so the role defaults mask it for every role but the admin.
--   * The mobile is personal data users have no column grant on (0021): owner's rights, like kernel.v_memberships, so
--     its own predicates do the isolation, and it is given only for a user of the caller's organization alone (a
--     profile shared with another organization, data from before the one-tenant rule, is not this one's to read).
--   * A security barrier: a caller's own predicates never run before the view's. Read only.

create or replace view kernel.v_users with (security_barrier = true) as
select u.id,
       case when (select kernel.field_visible('kernel.user', 'full_name')) then u.full_name end as full_name,
       case when (select kernel.field_visible('kernel.user', 'email')) then u.email end as email,
       case when (select kernel.field_visible('kernel.user', 'locale')) then u.locale end as locale,
       case when own.only and (select kernel.field_visible('kernel.user', 'mobile')) then u.mobile end as mobile,
       u.created_at
from kernel.users u
-- Same predicate as kernel.user_of_caller_tenant (0021), inline: every membership of the user is in the caller's tenant.
cross join lateral (
  select not exists (
    select 1 from kernel.memberships o join kernel.companies c on c.id = o.company_id
    where o.user_id = u.id and c.tenant_id is distinct from (select kernel.current_tenant_id())
  ) as only
) own
where exists (
    select 1 from kernel.memberships m
    where m.user_id = u.id
      and m.company_id = (select kernel.current_company_id())
      and array[m.company_id] <@ (select kernel.current_company_ids())
  )
  and exists (
    select 1 from kernel.memberships me
    where me.user_id = (select kernel.current_user_id())
      and me.company_id = (select kernel.current_company_id())
      and me.is_active
  );

revoke all on kernel.v_users from public, anon;
grant select on kernel.v_users to authenticated, service_role;
