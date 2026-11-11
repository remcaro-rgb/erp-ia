# Prompt · Phase 2B.2 · Task 34 · Foreign currency (design session, not code)

Paste this whole file as the first message of a new session in `/Volumes/SATECHI2TB/erp-ia`.

---

You are starting **Task 34 (foreign currency)** of phase 2B.2 of ERP-IA. Task 34 is a **stub in the plan with no design**: the owner decided on 2026-11-06 (owner-decisions item 19) that foreign-currency invoicing and collection are in 2B.2, and that the work "needs its own design section and review before it is scheduled". Your job in this session is the **design**, then the expanded plan task. **You write no production code and no migration.** When the owner approves the design, a later session implements the expanded task.

**Read before starting.** Read `docs/project-rules.md` (all 37 rules; rule 8, 5, 23 and 14 bind this work) and the design sections for this work: main design `docs/superpowers/specs/2026-10-26-erp-ia-design.md` §5 (kernel, processes, outbox), §8 and §8.1 (invoicing, payments, sales), §18a (DIAN code ported from Serena) and §22, especially §22.25 to §22.29; the accounting design `docs/superpowers/specs/2026-10-28-accounting-module-design.md` (posting engine, ledger columns, aging); `CLAUDE.md`. Then read `docs/superpowers/plans/2026-11-05-phase-2b-owner-decisions-pending.md` items 19, 114 and 118 and `docs/superpowers/plans/2026-11-03-phase-2b-sales-stock-chain.md` (Task 34 stub in the "Tasks 31 onwards" list and Global Constraints). Use `superpowers:brainstorming` to run the session.

**Where this sits.** Branch `phase-2b-sales-chain` (PR 2), 2B.2 small batches done. Task 34 unblocks two parked owner decisions and shares an open question with Task 45:
- **Item 114** (accepted): `payments.advance_applications` has `currency` constrained to `'COP'` and no exchange-rate snapshot; Task 34 adds the column forward-only (rule 8).
- **Item 118** (accepted): `invoicing.invoice.reprice` refuses a draft whose currency differs from the company's, because list prices carry no currency. Task 34 defines list-price conversion (convert at the draft's exchange rate, or per-currency price lists) and lifts the refusal.
- **Task 45** waits for the accountant (default accounts and late-freight policy). The exchange-difference accounts of this task go to the same accountant: ask, do not invent.

**What exists today (verify in the code, do not trust this list).** Invoices carry `currency` and an exchange-rate column; the DIAN XML builder refuses a foreign currency with `currency_not_supported` (Task 17); CUFE parity and a resubmit sweep already handle foreign-currency invoices issued earlier (Task 18); receipts and advances accept COP only (Task 21); the ledger (`accounting.entry_lines`, migration 0032) has document and company currency columns; aging is in company currency. Find the exact files with grep before proposing changes.

**Scope to design (from item 19).** For each, say what is decided, what is proposed, and what the owner or the accountant must decide:
1. The DIAN XML with the currency code and the exchange rate (`PaymentExchangeRate` / calculation rate), written only in `packages/localization/co` (rule 5); what stays unconfirmed for habilitación.
2. The rate source (daily TRM from the Superfinanciera or manual), where it is stored, who may override it and with what audit and permission (rule 1, 16), and what a document does when no rate exists for its date.
3. Posting at the document's rate with the company-currency columns filled (rule 8); the posting engine's contract change, if any (kernel §5.2).
4. Exchange differences on collection (realized) and at period close (unrealized): accounts and roles to **confirm with the accountant**, with `accountRoles` mapped in the country pack, never a PUC code in kernel or module source.
5. Receipts and advances in a foreign currency: allocation across invoices, the item 114 column, partial collection, bank deposits in COP against a USD invoice.
6. Aging and the open-items view in both currencies; reports that sum money must say which currency they sum.
7. Quotes and orders in a foreign currency, and the reprice rule of item 118 (list-price conversion).
8. The CUFE and resubmit paths that already handle foreign-currency invoices (no regression), credit and debit notes in a foreign currency, and the demo seed (one USD customer and invoice for the demo company).
9. Field visibility, RLS and the assistant: no new unmasked read of a money column; the assistant's cards show currency; Spanish copy through `packages/i18n` (rule 24, money `$ 1.234.567,00` for COP and a clear format for other currencies).
10. Migrations (forward-only, numbered after the last one in `supabase/migrations`), their integration tests (rule 34), and the user guides that change (rule 35).

**Deliverables, in this order.**
1. A design document `docs/superpowers/specs/2026-11-10-foreign-currency-design.md` (draft; the owner decides what enters main design §22, you never edit §22 or `docs/project-rules.md`). Short sections, one per item above, each with "Proposed", "Rule or decision it rests on" and "Open question" lines. Include the data model changes as a table and the process list (new and changed) with their permissions and effects.
2. An **owner questions list** appended to `docs/superpowers/plans/2026-11-05-phase-2b-owner-decisions-pending.md` as a new section after item 119, items numbered 120 onwards, each with a recommendation and the cost if wrong, and the accountant's questions marked as such.
3. After the owner approves the design in chat: an **expanded Task 34** in `docs/superpowers/plans/2026-11-03-phase-2b-sales-stock-chain.md`, split into sub-tasks each with its own failing test first, interfaces, files, migrations and review focus, in the format of the expanded Tasks 43 and 52 of that plan, plus one ready-to-paste session prompt per sub-task in `docs/superpowers/plans/2026-11-xx-phase-2b-task-34-prompts/` (format: `docs/superpowers/plans/2026-10-30-phase-2a-gaps-prompts/`).
4. A short note in `docs/brain/` (frontmatter with tags, date, status; wikilinks) once the design is written.

**How to work.**
- Ask the owner only what you cannot settle from the rules, the design or the code; give a recommendation with every question. Decide small things yourself and list them as "Calls I made".
- If the design would break a rule or deviate from the main design, stop and say so; the fix is an owner decision recorded in §22 by the owner, never a workaround.
- Do not commit or push unless the owner asks. Do not run dev servers; read-only database checks against the local stack (`127.0.0.1:54322`) are fine. Never `pkill next-server`.
- Do not start implementation, and do not mark Task 34 as scheduled in the plan until the owner approves the design.
