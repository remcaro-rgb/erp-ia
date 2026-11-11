---
tags: [invoicing, dian, security, vault, task-37, decision, web]
date: 2026-11-07
status: in-progress
---

# Endurecimiento de resolución y certificado (2B.2 task 37)

Part of [[Plan phase-2b-sales-stock-chain]]; owner items 24 and 25 of [[Plan phase-2b-owner-decisions-pending]] (decided 2026-11-06), §22.28 in [[Owner Decisions]]. Module: [[Module invoicing]], fiscal side in the [[Localization co]]. Follows the DIAN checklist ([[Lista de verificación DIAN (2B.2 task 35)]]) and the Task 19 settings (the production guard). Rules: [[Project Rules]] (1, 3, 5, 12, 13, 15, 16, 24, 31, 35).

## What changed
- **Admin guard (R37-4, R37-5).** `invoicing.invoice.resubmit_failed` («Reintentar todos») starts with `requireCompanyAdmin`; no step-up, sensitivity stays `normal`. The web action `runInvoicingSettingsAction("resubmit")` stays a passthrough: a member holding the process gets `{ ok: false, code: "forbidden" }` (the form shows «No tienes permiso para hacer esto») and nothing is requeued. The single-document «Reintentar envío» is unchanged (R37-3).
- **Frozen environment (R37-1, R37-2).** The document's `dian_environment` (stamped at «Emitir», migration 0102) is the only source for the XML frame, the transport at send and the PDF's QR; the fallback to the company's current setting is gone (`document_environment_missing`). A Borrador still previews with the company's. No migration.
- **Certificate `unreadable` (R37-6, R37-7).** A failed Vault read answers `certificate_status = unreadable` instead of failing the page; the error text is dropped. The settings form shows the alert (`data-testid="certificate-status"`, new `data-status`) with `certificate_status_unreadable`; `ok` and `unknown` stay silent. Going to producción with an unreadable store is refused with code `certificate_unverified` and the message «No se pudo verificar el certificado guardado: el almacén de secretos no respondió; inténtalo de nuevo» (review I1/I2: never a mismatch claim).

## Tests
- Web: `apps/web/src/lib/invoicing/__tests__/actions.integration.test.ts` (member refused, admin requeues), `settings/certificate-warning.test.tsx` (each status, no key material).
- e2e `apps/web/e2e/invoicing-hardening.spec.ts`: sweep keeps the issue-time environment; the server action replayed from a member's session is refused; mismatch and unreadable alerts, none when healthy.
- Fix round 1: the no-key-material checks now feed real sentinel material (props of the form, secret store of the action test); the member's company has a failed invoice so «nothing requeued» can fail; the e2e restores a renamed `kernel.secret_fingerprint` idempotently in beforeAll, afterAll and finally.
- Evidence limits: the QR is an image, so the e2e pins the frozen `dian_environment` and CUFE; the QR text itself is pinned by the workflow integration test. The Vault secret is overwritten through `kernel.secret_write` (the service wrapper), since a plain connection has no right on `vault.secrets`.

## Guide
`docs/user-guide/es-419/facturacion-electronica.md` (who may «Reintentar todos», the environment kept on resend, the certificate warnings).
