import type { Env } from "./target";

// The secrets seam (rule 6 and 12): certificates and provider keys are read through this interface, never from tables or
// code. The production implementation is Supabase Vault (`VaultSecretStore`, plan 2B Task 19): its `vault` schema is not exposed over
// PostgREST, so it goes through the service-role SQL wrappers of migration 0099 (kernel.secret_read / secret_write / secret_remove) on the
// server's own database connection. Also: the deployment's environment (read-only) and an in-memory store for tests.

export interface SecretStore {
  /** The secret's value, or null when it does not exist. */
  get(name: string): Promise<string | null>;
  set(name: string, value: string): Promise<void>;
  delete(name: string): Promise<void>;
  /**
   * The SHA-256 (hex) of the secret's value, or null when it does not exist, computed where the secret lives when the store can (Supabase
   * Vault: the value never leaves the database). Optional: without it a caller hashes `get`'s answer (Task 19 fix round 2).
   */
  fingerprint?(name: string): Promise<string | null>;
}

export class InMemorySecretStore implements SecretStore {
  private readonly values = new Map<string, string>();
  async get(name: string): Promise<string | null> {
    return this.values.get(name) ?? null;
  }
  async set(name: string, value: string): Promise<void> {
    this.values.set(name, value);
  }
  async delete(name: string): Promise<void> {
    this.values.delete(name);
  }
}

/** Read-only view of the deployment's environment: `dian/<company>/certificate` is `DIAN_<COMPANY>_CERTIFICATE`. */
export class EnvSecretStore implements SecretStore {
  constructor(private readonly env: Env = process.env) {}
  async get(name: string): Promise<string | null> {
    const key = name.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
    return this.env[key]?.trim() || null;
  }
  async set(): Promise<void> {
    throw new Error("EnvSecretStore is read-only: set the secret in the deployment's environment");
  }
  async delete(): Promise<void> {
    throw new Error("EnvSecretStore is read-only: remove the secret from the deployment's environment");
  }
}

/** A postgres.js-style tagged template (the server's service connection). Kept structural: infra has no database dependency. */
export type SecretSql = (strings: TemplateStringsArray, ...values: string[]) => PromiseLike<readonly Record<string, unknown>[]>;

/**
 * Supabase Vault through migration 0099's wrappers (rule 12). The connection must be the server's service connection (the wrappers are
 * granted to the service role only and refuse a session that carries a user's claims); names are `dian/<companyId>/<certificate |
 * certificate-password | software-pin>` of an existing company, refused otherwise by the database. Values are never logged here.
 * Trust boundary (Task 19 fix round 2): the wrappers check the name's shape and that its company exists, not WHICH company is asking:
 * they run on the server's service connection only (a session with a user's claims is refused), and the server builds every name from
 * the process's own company (ctx.companyId: `dian/${companyId}/...`), never from a client's input.
 */
export class VaultSecretStore implements SecretStore {
  constructor(private readonly sql: SecretSql) {}
  async get(name: string): Promise<string | null> {
    const rows = await this.sql`select kernel.secret_read(${name}) as value`;
    const value = rows[0]?.value;
    return typeof value === "string" ? value : null;
  }
  async set(name: string, value: string): Promise<void> {
    await this.sql`select kernel.secret_write(${name}, ${value})`;
  }
  async delete(name: string): Promise<void> {
    await this.sql`select kernel.secret_remove(${name})`;
  }
  async fingerprint(name: string): Promise<string | null> {
    const rows = await this.sql`select kernel.secret_fingerprint(${name}) as value`;
    const value = rows[0]?.value;
    return typeof value === "string" ? value : null;
  }
}
