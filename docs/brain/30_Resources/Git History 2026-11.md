---
tags: [resource, git]
date: 2026-11-07
status: active
---

# Git history 2026-11

38 commits.

- 2026-11-07 `af8b1bf` feat(kernel): recommendation API, consumed by auto-invoice refusals and costing (2B.2 task 38)
- 2026-11-06 `65d0579` feat(core): price list create and item processes, seeded Mayoristas list (2B.2 task 51)
- 2026-11-06 `eb7b362` feat(demo): tercero on NC-18, real 1007 XML in the e2e, seed from zero (2B.2 tasks 46, 47)
- 2026-11-06 `7957b95` docs(2b): expand demo-batch tasks 46, 47, 51 and settle owner items 55, 56; record item 57
- 2026-11-06 `406435d` feat: module needs and shortcuts, small-fixes batch (2B.2 tasks 41, 42, 50)
- 2026-11-06 `7013f87` docs(2b): expand small-batch tasks 40, 41, 42, 48, 50 and record new owner items 42-54
- 2026-11-06 `72d8d42` feat(worker): refuse or warn on a stale module list (2B.2 task 48)
- 2026-11-06 `7be2f41` test(rules): guard unmasked module views (2B.2 task 40)
- 2026-11-06 `5d36bb9` docs(rules): rule 16 dry-run denial exception (owner 2026-11-06, design §22.28)
- 2026-11-06 `dbad54e` docs(2b): owner decisions round two, design §22.28, 2B.2 plan tasks 32-50
- 2026-11-06 `25f56e1` docs(2b): record causal chain ratification and document link table (design §22.27, plan Task 31)
- 2026-11-06 `d87e2fe` docs(2b): record owner confirmation of design §22 item 26
- 2026-11-06 `60afa3a` docs(2b): phase 2B.1 user guides, roadmap, design §22 items, owner decisions pending
- 2026-11-06 `bf53d9d` feat(2b): sales-to-ledger chain, web (module pages, record frame, Terceros UI)
- 2026-11-06 `083164d` feat(2b): sales-to-ledger chain, backend (inventory, costing, crm, sales, invoicing, payments)
- 2026-11-04 `859329b` docs: phase 2B plan, prototype and owner decisions (design §22.25, roadmap)
- 2026-11-04 `b6782d1` feat(shell): picking a module opens its Inicio only when none of its pages is open
- 2026-11-04 `5dedf0f` feat(home): every module has its own Inicio with KPIs and charts; users customize what they see
- 2026-11-04 `145eec9` perf: record pages under 1 s (field modes in one call, comprobante lines checked once)
- 2026-11-04 `d09a05f` perf: account pages under 1 s on the hosted site
- 2026-11-04 `cf2d490` feat(auth): users change their own password, admins reset others'; the second step is mandatory only when an admin requires it
- 2026-11-04 `237b63a` feat(ops): upload-dev script to share the dev environment; batch the manifest sync so a hosted seed finishes
- 2026-11-04 `4d600cf` test(e2e): a posted comprobante's state buttons exclude the new Cerrar
- 2026-11-04 `4e48867` fix(kernel): import logs the database cause of a failed row
- 2026-11-04 `89ede4d` docs(accounting): index the comprobante templates screen in its guide
- 2026-11-03 `72db737` feat(ui): Cerrar button on record pages, link to the reversing comprobante, Revertido in red; i18n and guides for the import, Cerrar and Revertido changes
- 2026-11-03 `f1a8740` fix(accounting): comprobante import previews each comprobante's lines, creates them with origin import and says .xlsx only
- 2026-11-03 `6b3bb71` feat(accounting): comprobante templates with editable-values flag, note, per-user access and a template link on the comprobante; save as template from the action bar
- 2026-11-03 `770f985` feat(ui): icons on the top bar sections and items, and the missing icon names in the nav map
- 2026-11-03 `27ca2e1` docs: add Estatuto Tributario text as asset and roadmap note for the AI knowledge base
- 2026-11-03 `e6b7599` feat(ui): account page chips, friendly section, copy code, código links, new-tab full view, unsaved note beside the title
- 2026-11-03 `6d7278e` fix(accounting): period_figure checks access only at restricted accounts, so the Plan de cuentas Tabla loads
- 2026-11-03 `d226942` ci: run push builds on main only, so a PR runs once
- 2026-11-03 `d0905f4` fix(ci): entry e2e takes the toolbar Nuevo; import logs unexpected row errors
- 2026-11-03 `487468f` fix(ci): pass TEST_MAILPIT_URL through turbo; import test names refused lines
- 2026-11-03 `3536f7c` feat: phase 2A.5 entity types
- 2026-11-02 `248b2ee` fix(ui): dashboard grid and states, tab overflow and titles, grid filters and overflow cues, form footer, import copy
- 2026-11-02 `523d74b` feat(accounting): invoice readiness per account (rule 10, design §22.22)

Index: [[Git History]].
