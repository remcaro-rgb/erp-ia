-- 0099_kernel_vault_secrets
-- Forward-only migration (rule 34). Covered by packages/kernel/src/__tests__/vault-secrets.integration.test.ts.
-- The Vault-backed secret store (plan 2B Task 19; rule 12: DIAN certificates and provider keys live in Supabase Vault; Task 5 ruling). The
-- `vault` schema is not exposed over PostgREST and the authenticated role has no access to it; the server reads and writes the secrets
-- through these three wrappers, on its own service connection (infra VaultSecretStore):
--   * kernel.secret_read(name)          the decrypted value, or null;
--   * kernel.secret_write(name, value)  creates the secret, or rotates it in place (vault.update_secret: same id, new value);
--   * kernel.secret_remove(name)        deletes it (a no-op when absent).
-- Names are `dian/<companyId>/<certificate | certificate-password | software-pin>` of an existing company: nothing else is stored here.
-- The wrappers are security definer, executable by the service role only (never authenticated, anon or public), and refuse a session that
-- carries a user's claims (a request running as a user never reaches a secret, even through the owner). No value is ever raised in an error,
-- written to a table other than vault.secrets (encrypted) or returned by a view.

create or replace function kernel.secret_name_ok(p_name text) returns boolean
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_company uuid;
begin
  if p_name is null or p_name !~ '^dian/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/(certificate|certificate-password|software-pin)$' then
    return false;
  end if;
  v_company := split_part(p_name, '/', 2)::uuid;
  return exists (select 1 from kernel.companies where id = v_company);
end;
$$;

create or replace function kernel.secret_guard(p_name text) returns void
language plpgsql stable security definer
set search_path = ''
as $$
begin
  if kernel.current_user_id() is not null then
    raise exception 'the secret wrappers run on the service connection only, never in a user''s session' using errcode = 'insufficient_privilege';
  end if;
  if not kernel.secret_name_ok(p_name) then
    raise exception 'invalid secret name: expected dian/<company id>/<certificate | certificate-password | software-pin> of an existing company' using errcode = 'invalid_parameter_value';
  end if;
end;
$$;

create or replace function kernel.secret_read(p_name text) returns text
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_value text;
begin
  perform kernel.secret_guard(p_name);
  select decrypted_secret into v_value from vault.decrypted_secrets where name = p_name;
  return v_value;
end;
$$;

create or replace function kernel.secret_write(p_name text, p_value text) returns void
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  perform kernel.secret_guard(p_name);
  if p_value is null or p_value = '' then
    raise exception 'a secret needs a value' using errcode = 'invalid_parameter_value';
  end if;
  -- One secret per name: the name is locked (advisory: the owner may read and delete vault.secrets, not update it), then rotated in place
  -- (vault.update_secret) or created.
  perform pg_advisory_xact_lock(hashtext('kernel.secret:' || p_name));
  select id into v_id from vault.secrets where name = p_name;
  if v_id is null then
    perform vault.create_secret(p_value, p_name, 'ERP-IA: secreto de facturación electrónica (plan 2B Task 19)');
  else
    perform vault.update_secret(v_id, p_value);
  end if;
end;
$$;

create or replace function kernel.secret_remove(p_name text) returns void
language plpgsql volatile security definer
set search_path = ''
as $$
begin
  perform kernel.secret_guard(p_name);
  delete from vault.secrets where name = p_name;
end;
$$;

revoke all on function kernel.secret_name_ok(text) from public, anon, authenticated;
revoke all on function kernel.secret_guard(text) from public, anon, authenticated;
revoke all on function kernel.secret_read(text) from public, anon, authenticated;
revoke all on function kernel.secret_write(text, text) from public, anon, authenticated;
revoke all on function kernel.secret_remove(text) from public, anon, authenticated;
grant execute on function kernel.secret_read(text), kernel.secret_write(text, text), kernel.secret_remove(text) to service_role;
