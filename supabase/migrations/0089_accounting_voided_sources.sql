-- 0089_accounting_voided_sources
-- Forward-only migration (rule 34). Covered by packages/modules/accounting/src/__tests__/posting.integration.test.ts (the void of a source
-- vs its own posting) and packages/modules/sales/src/__tests__/delivery.integration.test.ts.
-- Plan 2B Task 14, review round 2: the sources the posting engine has seen voided. accounting.posting.reverse_source records the source of
-- a rule `reverseOf` (the event it reverses and the source's id) once it voided it; every later write of that source's posting, the post
-- (accounting.entry.post_from_event), the record of a pending (accounting.posting_failure.record) and the retry (accounting.posting.retry),
-- finds it under the same per-source transaction lock and writes nothing (the retry dismisses the pending with code source_voided). The
-- marks of kernel.outbox_deliveries could not say this: a delivery that ran and a dismissal leave the same mark.
-- Written by the module's processes only (the engine's event runs); no masked view: nothing here is shown to a person.

create table accounting.voided_sources (
  id            uuid primary key default kernel.uuid_v7(),
  seq           bigint not null,
  company_id    uuid not null references kernel.companies (id),
  event         text not null,
  source_id     uuid not null,
  void_event_id uuid not null,
  extra         jsonb not null default '{}'::jsonb,
  extra_free    jsonb not null default '[]'::jsonb,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  created_by    uuid default kernel.current_user_id(),
  updated_by    uuid,
  constraint voided_sources_company_seq_key unique (company_id, seq),
  constraint voided_sources_company_event_source_key unique (company_id, event, source_id)
);
select accounting.setup_table('voided_sources', 'accounting.voided_source');
