---
tags: [core, task-34, foreign-currency, exchange-rates, trm, scheduler]
date: 2026-11-09
status: implemented-uncommitted
---

# Tasas de cambio y TRM (2B.2 task 34.1)

Part of [[Plan phase-2b-sales-stock-chain]] (Task 34, foreign currency; FX design `2026-11-10-foreign-currency-design.md` §2, §10–§12); owner items 121–123 in [[Owner Decisions]]. First of eight sub-tasks; 34.3 builds the document rate defaults on it. Runs beside sub-task 34.2 (money text), in its own worktree.

- Migration `0147_core_exchange_rates.sql`: `core.exchange_rates` (one rate per company, currency, day; `source` trm | manual; `official_rate` keeps the published TRM on a manual day; RLS, row audit, seq, writes only from `core.exchange_rate.*`), masked view `core.v_exchange_rates` (the only cross-module read, R34-2), the import log `core.exchange_rate_imports` (sistema; the subject of the failure recommendation), EUR seeded.
- Processes (`packages/modules/core/src/processes/exchange-rate.ts`): `set` (manual; `official_rate_exists` on a TRM day), `override_official` (step-up, note required, before/after in the audit), `import_official` (origins scheduler + ui; one TRM row per day of the validity; never over a manual row, which is listed in `skipped`), `for_date` (the day's row or the latest within 3 days, else null).
- Feed: `RateFeed` port in `packages/infra/src/rate-feed.ts` (`httpRateFeed`, `fixtureRateFeed`, `rateFeedFromEnv`: `RATE_FEED=http` to fetch, fixture by default); kernel seam `setRateFeed` / `rateFeed()`; the pack's `exchangeRates.officialRate` (co: dataset `32sa-8pi3`, USD only) in `packages/localization/co/src/exchange-rates.ts`; fixtures in `co/src/__fixtures__/trm/`.
- Decision (owner item 131): the failure recommendation needs a real subject (Task 38 API: entity + uuid, one open per subject and reason) and an audience process (0123), so the import writes a log row per company, currency and day; the row is the subject, the audience is the admin role plus the holders of the import. Same pattern as `costing.cost_missing`.
- Scheduler: `runTrmImport` in `apps/web/src/lib/server/scheduled-checks.ts`, run by the outbox tick after the posting age check; due once per company and tenant day from 07:00 in the company's time zone, only for companies in scope (`officialRateCompanies`, R34-3).
- Screen: Núcleo › Parámetros › Tasas de cambio (`/exchange-rates`): grid, «Registrar tasa» (with «Reemplazar TRM» and the second factor on a TRM day), «Traer TRM». Guide `docs/user-guide/es-419/tasas-de-cambio.md`. Eval «¿Cuál es la TRM de hoy?».
- Deploy note: production must set `RATE_FEED=http` to import the real TRM.
