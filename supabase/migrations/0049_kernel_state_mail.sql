-- 0049_kernel_state_mail
-- Forward-only migration (rule 34). Covered by packages/kernel/src/typed/__tests__/notify.integration.test.ts.
--
-- State e-mails and Notificar (entity types spec 2026-11-02 §7; Phase 2A.5 Task 12). kernel.mail_log (0040) gains:
--   * event_id: the outbox event (`<entity>.status_changed`) a state e-mail answers; unique, so a redelivered event never logs or
--     sends a second mail (the consumer reads it first and skips an event already sent). Null for Notificar (a process run).
--   * subject: what the mail said it was about (the audit of what left the system, next to the recipients and the template version).
--   * error: why the last send failed (the provider's answer, or the refusal that stopped it); cleared when a retry sends. A state
--     e-mail that left addresses of its list out (invalid, or over the limit) keeps that note here even when sent.
--   * body_hash: sha256 of what a state e-mail sends (recipients, subject, text, attachments), written by the first attempt. A retry
--     of the event renders the same bytes (the print time is the event's); the hash tells the provider's "this key was already used"
--     for the same mail (sent) from one for a different body (failed).
-- The guard (0040) still keeps the row append-only except for the outcome, which now includes `error`.
-- The state e-mail rows are written by the outbox consumer on the service connection (rule 12: inside the route handler / workflow
-- step only); Notificar's are written by kernel.record.notify as the caller (author_is_caller, 0040).

alter table kernel.mail_log
  add column event_id uuid,
  add column subject  text check (subject is null or (length(subject) <= 300 and subject !~ '[\r\n]')),
  add column error    text,
  add column body_hash text check (body_hash is null or body_hash ~ '^[0-9a-f]{64}$');

create unique index mail_log_event_idx on kernel.mail_log (event_id) where event_id is not null;

create or replace function kernel.mail_log_guard() returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'mail_log_immutable: mail_log is append-only' using errcode = 'insufficient_privilege';
  end if;
  -- Only the provider outcome changes (updated_at / updated_by are kept by touch_row).
  if (to_jsonb(new) - 'status' - 'provider_id' - 'error' - 'updated_at' - 'updated_by')
     is distinct from (to_jsonb(old) - 'status' - 'provider_id' - 'error' - 'updated_at' - 'updated_by') then
    raise exception 'mail_log_immutable: only status, provider_id and error may change' using errcode = 'insufficient_privilege';
  end if;
  return new;
end;
$$;

-- The claim on a state e-mail's event (fix round 2, ruling N1/N2): a delivery leases the event in a short transaction of its own,
-- renders and sends holding no connection and no session state (so it works through the transaction pooler), records the outcome in
-- mail_log and releases the lease. A parallel delivery finds the lease live and is retried later; a delivery that died leaves a
-- lease that expires (lease_until) and is then taken over. Written only by the outbox consumer on the service connection: no grant
-- to authenticated or anon, RLS on.
create table kernel.mail_claims (
  event_id    uuid primary key,
  company_id  uuid not null references kernel.companies (id),
  lease_until timestamptz not null,
  claimed_by  text not null,
  created_at  timestamptz not null default now()
);
revoke all on kernel.mail_claims from public, anon, authenticated;
grant all on kernel.mail_claims to service_role;
select kernel.enable_company_rls('kernel', 'mail_claims');
