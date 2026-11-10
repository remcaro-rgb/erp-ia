---
tags: [project, sales, commissions, migration, phase-2b]
date: 2026-11-10
status: built-uncommitted
---

# Commission plans and bases (2B.2 task 30.1)

Sub-task 30.1 of [[Part G design (2B.2 tasks 28-30)]], plan [[Plan phase-2b-sales-stock-chain]] (items 156–158, 162, 163; RG-11, RG-12, RG-14). Module: [[Module sales]]. Owner items: [[Plan phase-2b-owner-decisions-pending]] 167–169. Rules: [[Project Rules]].

## What was built
- Migration `0156_sales_commissions.sql`: `sales.settings.commission_basis` (`on_collection` default | `on_invoice`); `sales.commission_plans` (typed maestro) with child tables `commission_plan_users` and `commission_plan_lines` (rate per product category); `sales.commission_bases` (sistema, one per invoice line, unique `(company_id, invoice_line_id)`); `sales.commissions` (documento `COM-`, stage `posted|reversed|paid`) and `sales.commission_lines`. RLS, row audit, `seq`, masked views (rates and amounts `confidential`), `sales.commission_frozen` / `commission_base_frozen` triggers.
- Record rule RG-14 as restrictive `commission_scope` policies: a user reads the plans that list them, and those plans' bases and commissions; `kernel.can_run_process('sales.commission.consult_all')` reads all.
- Processes: `sales.commission_plan.create/update/consult` (payee invoice-ready employee or supplier; members of the company; one active plan per user and date, under an advisory lock and the definer `sales.commission_plan_overlaps`); `sales.commission.compute` (event only, idempotent per invoice, numeric rounding half up in SQL, emits `sales.commission.due` when it wrote bases); `sales.commission.consult_all` (the permission).
- Sales' consumer of `invoicing.invoice.issued` runs `record_invoiced`, then `compute` as a **separate run**: a failing compute never rolls back what the entregas recorded (RG-12).
- Payloads: `invoicing.invoice.issued.commissionLines` (pedido lines, free samples out), `invoicing.note.issued.lines[].invoiceLineId`, `payments.received` and `payments.advance.applied` allocations gain `openAfterDoc` (computed in the post hook, before the kernel marks the document posted). Accounting fixtures follow.
- Menu: Ventas › Maestros «Planes de comisión» (`/sales/commission-plans`, grid only, no record page yet: the record frame mapping is 30.4's file); its item also guards the `sales.commission.*` processes until the Comisiones screen (30.4).
- Guide: `docs/user-guide/es-419/ventas.md` § «Planes de comisión» and the basis in «Parámetros de ventas».

## Decisions and lessons
- **consult_all is kind update** (owner 2026-11-10, item 167): `kernel.seed_role_defaults` grants every consult process to a new role.
- `stage` instead of `status`, `is_active` instead of `active` (kernel typed columns own those names; item 169).
- Test lesson: a `role_ids` claim counts only with its `kernel.membership_roles` row (`kernel.current_role_ids`); a test role without it sees `can_run_process` false.
- Sales cannot depend on invoicing (cycle), so the sales test enqueues a synthetic `invoicing.invoice.issued` row; invoicing's own test checks the real payload.

## Open
- A form for the plan's users and category rates (item 168); until then through the assistant.
- 30.2 accrues and posts on `sales.commission.due`; 30.3 reverses on notes, annulments and voids; 30.4 screens, report, demo.
