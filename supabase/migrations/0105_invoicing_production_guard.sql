-- 0105_invoicing_production_guard
-- Forward-only migration (rule 34). Covered by packages/modules/invoicing/src/__tests__/parametros.integration.test.ts (fix round 2).
-- Plan 2B Task 19 fix round 2 (security review): the database holds the whole producción guard of invoicing.settings.update, not only
-- the confirmation of the DIAN defaults (0101): a company is in producción only with the software registered, a certificate uploaded and
-- the software PIN stored. (The certificate's validity and its match with the stored one are checked by the process: they depend on the
-- clock and on the secret store.)

alter table invoicing.settings
  add constraint settings_production_ready check (
    dian_environment <> 'produccion'
    or (software_id is not null and certificate_uploaded_at is not null and software_pin_set_at is not null)
  );
