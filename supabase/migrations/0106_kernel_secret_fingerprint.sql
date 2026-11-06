-- 0106_kernel_secret_fingerprint
-- Forward-only migration (rule 34). Covered by packages/kernel/src/__tests__/vault-secrets.integration.test.ts and
-- packages/modules/invoicing/src/__tests__/parametros.integration.test.ts.
-- Plan 2B Task 19 fix round 2 (security review): invoicing.settings.consult tells whether the certificate stored is the one the Parámetros
-- describe (certificate_status) by its SHA-256, computed HERE: the encrypted value is decrypted inside the database and only its hash
-- leaves it (the consult no longer reads the whole certificate back on every call). Same guard as 0099's wrappers: the service
-- connection only, a name `dian/<company id>/...` of an existing company; executable by the service role only.

create or replace function kernel.secret_fingerprint(p_name text) returns text
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_hash text;
begin
  perform kernel.secret_guard(p_name);
  select encode(sha256(convert_to(decrypted_secret, 'UTF8')), 'hex') into v_hash from vault.decrypted_secrets where name = p_name;
  return v_hash;
end;
$$;

revoke all on function kernel.secret_fingerprint(text) from public, anon, authenticated;
grant execute on function kernel.secret_fingerprint(text) to service_role;
