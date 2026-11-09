# TRM fixtures (plan 2B.2 Task 34.1)

Answers of the datos.gov.co dataset `32sa-8pi3` for the fixture rate feed (`RATE_FEED=fixture`, the default; tests and CI never call the
internet). Each file is named `<sha1(url)>.json`, where `url` is `trmUrl(date)` of `../../exchange-rates.ts`.

| Query date | Answer |
|---|---|
| 2026-11-07, 2026-11-08, 2026-11-09 | the TRM certified on Friday 2026-11-06: 4.123,45, valid 2026-11-07 to 2026-11-09 |

Any other date has no file: the feed fails as an unreachable source does.
