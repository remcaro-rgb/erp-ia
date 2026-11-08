---
tags: [area, decisions]
date: 2026-11-07
status: active
---

# Owner Decisions (design §22)

Source: design §22, 29 numbered items. First line of each.

- **22.1** Multi-company per tenant: modelled from day one (tenant → companies, company_id everywhere). UI ships single-company in phases 1–2; company switcher and consolidated reports in phase 3.
- **22.2** POS hardware: barcode scanners from v1 (keyboard devices). ESC/POS receipt printing and cash-drawer kick through WebUSB or a small local print agent in phase 5. No fiscal printer; the DIAN electronic POS document is the legal path. POS is Chromium-only.
- **22.3** AI pricing: token allowance per seat included in each module plan, metered above it, with a per-company monthly cap the admin can raise. Background agents count against the company allowance. Usage dashboard and alerts are a launch requirement. Cheap tasks rou
- **22.4** English UI: i18n plumbing from day one (all strings through packages/i18n, locale per user). Spanish only at launch; English in phase 3.
- **22.5** Billing provider: Bold (Colombian payment gateway). The Serena project already has a Bold integration; reuse its adapter and webhook handling behind the billing adapter interface. Manual invoicing (through the platform's own invoicing module) for enterprise an
- **22.6** On-prem: later option, not a launch requirement. docker-compose.yml and the Workflow Postgres World run in CI from phase 1 so the path stays working; first on-prem delivery in phase 6.
- **22.7** Party fiscal data: core.parties captures the full DIAN identity (person type, 12 document types, computed DV, split names, tax responsibilities, tributo, DANE location, invoice e-mail) with format validation from day one; see §5.8a. Money renders as $ 1.234.56
- **22.8** Product fiscal data and attachments: core.products carries the invoice-line data of §5.8b from day one; any entity accepts attachments (§5.13).
- **22.9** Prototype v5 changes (2026-10-27): module bar + tabs row shell with dark mode (§19a); record frame with open-in-new-tab, tabs, inline phone/e-mail validation and verification hooks (§5.16); tagged attachments with drag-and-drop, delete confirmation and admin-d
- **22.10** Adaptive UI agent (2026-10-28): approved as a phase 3 feature entirely; see 2026-10-28-adaptive-ui-agent-design.md. Key owner rules: proposals only on sufficient and significant evidence, try before accept, activation only on accept, no page showing the user w
- **22.11** UI density audit and follow-ups (2026-10-29), from docs/superpowers/reports/2026-10-28-ui-density-audit.md and prototype v6 (2026-10-28-erp-ia-prototype-v6-density.html):
- **22.12** Movable grid columns (2026-10-29): every grid lets the user reorder columns by dragging the header (and with the keyboard); the order is part of the view and is saved with it (rule 20).
- **22.13** Cloning (2026-10-29): every entity with a create process can be cloned from its record ("Duplicar"). The clone is created through the entity's own create process from the source's visible data with the entity's unique and identity fields cleared (document numb
- **22.14** Audit before/after and friendly names (2026-10-29): the audit viewer shows, per changed field, the previous and the new value (from the row-level diff the audit trigger already records), with the field's label, the process's description and the entity's name f
- **22.15** Every entity reference is a link (2026-10-29): wherever the UI shows a record of another entity (the actor of an audit row, a product's supplier, a ticket's reporter, the rows of an assistant result) it links to that record's page (rule 21). Users have a page 
- **22.16** Editable users (2026-10-29): the admin edits a user's name, mobile, photo, locale, roles and active state through kernel.admin.user.update (step-up); deactivating removes access without deleting history (§6).
- **22.17** Accounting module (2026-10-29): see 2026-10-28-accounting-module-design.md. core.product_categories.income_account (§5.18) is deprecated: the revenue account of a category is an accounting role mapping (revenue, dimension category:<id>) edited from Contabilida
- **22.18** Development environment (2026-10-29): development runs on the local Supabase stack (the CLI's Docker stack on OrbStack, 6 GB / 6 CPUs), never on the owner's laptop against the hosted project: over the internet the integration suites take an hour instead of two
- **22.19** Two-step verification opt-out (2026-10-29): a user may turn off the second step of their own sign-in (kernel.user.mfa.disable, step-up with a fresh code from the factor being removed), unless they hold the system admin role without an exemption; an admin may r
- **22.20** Phase 2A gaps (2026-10-30), from docs/superpowers/plans/2026-10-30-phase-2a-gaps.md (the owner took the plan's recommendations):
- **22.21** UI/UX remediation (2026-10-31), from docs/superpowers/plans/2026-10-31-ui-ux-remediation.md (the owner took the plan's recommendations). The v5 shell of §19a stays; shell v7 (2026-10-31-shell-v7-sidebar.md) is not adopted by this decision.
- **22.22** Invoice readiness on accounting lines (2026-11-02, owner decision). Narrows rule 10 for accounting to the accounts that need it:
- **22.23** Entity types Maestro / Documento (2026-11-02, owner decision), from 2026-11-02-entity-types-design.md. Every table entity is a maestro or a documento with a fixed lifecycle (Borrador, Grabado, Pendiente de Aprobación, No Aprobado, Aprobado; documentos add Cont
- **22.24** Shell v7 adopted (2026-11-02, owner decision), replacing the v5 shell of §19a and the 2026-10-31 note in item 21. A left side menu, collapsible to a narrow rail (owner 2026-11-02), lists module names only (Contabilidad, Administración, Núcleo, …); selecting on
- **22.25** Plantillas de comprobante, second round (2026-11-03, owner request), narrowing §4.10 of the accounting design. (a) A plantilla carries a note and values_editable (default true): when false, the account and the fixed amount of each of its lines are the comproba
- **22.25** Phase 2B decisions (2026-11-04, owner), from docs/superpowers/plans/2026-11-03-phase-2b-sales-stock-chain.md and prototype 2026-11-04-erp-ia-prototype-2b-sales-chain.html. 2B is split: 2B.1 (Tasks 1–27) and 2B.2 (Part G, Tasks 28–30).
- **22.26** Record frame and party form, owner UI request (2026-11-05). (a) The record's action bar (Nuevo, Imprimir, Notificar, Duplicar, a module's own buttons such as Emitir, the state buttons and Cerrar) sits in the record frame's tabs bar, right of the tabs; when it 
- **22.27** Causal chain and document trail (2026-11-06, owner), ratifying the 2B.1 reading and completing it. The causal chain id stays one per user action (quote acceptance, order confirmation, delivery, invoice issue, receipt each start their own; an order confirmation
- **22.28** Phase 2B.1 decisions, second round (2026-11-06, owner), from docs/superpowers/plans/2026-11-05-phase-2b-owner-decisions-pending.md (every item decided; wording there). Kernel: a process may run another registered process through ctx.runProcess (own permission,

Related: [[Design Spec Index]], [[Project Rules]], [[Memory Notes]].
