-- 0011_kernel_auth_attempts
-- Forward-only migration (rule 34). Covered by apps/web/src/lib/auth/__tests__/limiter.integration.test.ts.
-- Per-account counter of sign-in and TOTP attempts (design §6). Auth's own rate limits are per IP and every
-- request of the web app reaches Auth from the Next server, so they cannot protect one account from guessing.
-- Keys: `login:<lower(email)>`, `mfa:<user id>`, `stepup:<user id>`. Written only by the server (service role).

create table kernel.auth_attempts (
  key          text primary key,
  window_start timestamptz not null default now(),
  count        integer not null default 0
);

revoke all on kernel.auth_attempts from anon, authenticated, public;
grant all on kernel.auth_attempts to service_role;

-- No policy for a user role: with RLS on and no policy nothing is visible or writable to it.
alter table kernel.auth_attempts enable row level security;
