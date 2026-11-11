-- 0158_sales_commission_fixes
-- Forward-only migration (rule 34), plan 2B.2 Part G review fixes of Tasks 30.2–30.3 (PG §5.2, §5.3; RG-11, RG-12). Covered by
-- packages/modules/sales/src/__tests__/commission-reversal.integration.test.ts («events processed before the compute», (7)–(9)).
--
-- The documents that already moved each commission base: `applied_sources` lists the receipts, advance applications and credit notes whose
-- accrual or reduction the base has taken (sales.commission.accrue, sales.commission.adjust_for_note). Nothing orders sales' compute (the
-- consumer of invoicing.invoice.issued) before the consumers of payments.received, payments.advance.applied and invoicing.note.issued: compute
-- now catches up on what was posted before its bases existed, and a later run of those consumers must find the base already moved by that
-- document. The marker is per base, not per document: one receipt can settle an invoice whose bases existed (accrued by its consumer) and
-- another whose bases came later (accrued by that invoice's compute). Not a field of the entity (no screen shows it); moved only by the
-- sales.commission processes (0156's via_process policies), and never cleared: a voided document is never applied again.

alter table sales.commission_bases add column if not exists applied_sources uuid[] not null default '{}'::uuid[];

comment on column sales.commission_bases.applied_sources is
  'The receipts, advance applications and credit notes already applied to this base (accrual or reduction): a second run for one of them is a no-op (0158).';
