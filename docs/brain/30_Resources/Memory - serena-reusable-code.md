---
tags: [resource, memory]
date: 2026-11-07
status: active
---

# Memory: serena-reusable-code

_Copied from Claude auto-memory._

ERP-IA's billing provider is **Bold** (decided 2026-10-27) because the Serena project already integrates it. Serena (`/Volumes/SATECHI2TB/Serena/serena-app`, Next.js 16 + Supabase + next-intl + shadcn) has reusable code at:
- Bold: `src/lib/payments/bold.ts`, `bold-api.ts`, `bold-settle.ts`, `src/lib/bold-api-client.ts`, `src/app/api/payments/bold-api/`, `src/types/bold-checkout.d.ts`
- DIAN e-invoicing: `src/lib/dian/` (xml-builder, signer, cufe, soap-client, ws-security, certificate-manager, nit, amounts, tests) and spec `docs/superpowers/specs/2026-04-05-dian-invoicing-design.md`
- Siigo integration: `src/lib/siigo/`; exports: `src/lib/export.ts`; audit: `src/lib/audit.ts`

**Why:** avoids re-implementing Colombian payment and fiscal plumbing already proven in production.
**How to apply:** when a plan task touches billing, DIAN or imports, read the Serena file first and port it behind ERP-IA's adapter interfaces instead of writing from scratch. See [[Memory - erp-ia-design-decisions]].

Index: [[Memory Notes]].
