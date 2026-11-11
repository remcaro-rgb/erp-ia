-- 0061_kernel_manifest_hashes
-- Forward-only migration (rule 34). Covered by packages/kernel/src/__tests__/entitlements.integration.test.ts.
-- What each module's manifest looked like the last time a server registered it in SQL (design §5.2). Every server instance used to
-- rewrite the whole registry (processes, menu items, thousands of entity fields) when it started, and a serverless instance starts
-- often: the first request after a deploy waited for it. The server now compares a hash of the manifest with this one and
-- writes only what changed. Service connection only: no role may read or write it.

create table kernel.manifest_hashes (
  module_id  text primary key,
  hash       text not null,
  updated_at timestamptz not null default now()
);

alter table kernel.manifest_hashes enable row level security;
grant all on kernel.manifest_hashes to service_role;
