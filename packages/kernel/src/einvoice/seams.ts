import type { EInvoiceTransport, SecretStore } from "@erp/infra";

// The seams the electronic-invoice workflow reads its secrets and its transport through (plan 2B Task 17; rules 6 and 12). Kept on
// globalThis, like the file store: the workflow step bundle loads this module a second time and must see what the app (or a test)
// installed.
//  - The secret store holds each company's signing certificate, its password and the software PIN. Production installs the Vault-backed
//    store (Task 19); until then none is installed and signing fails with "credentials not configured", never with a secret from the
//    environment.
//  - The transport override replaces the one the country pack builds from configuration (the mock unless EINVOICE_TRANSPORT says
//    otherwise): tests install a scripted mock; production never installs one.

const SECRETS_KEY = Symbol.for("erp.kernel.secretStore");
const TRANSPORT_KEY = Symbol.for("erp.kernel.einvoiceTransport");
const globals = globalThis as { [SECRETS_KEY]?: SecretStore; [TRANSPORT_KEY]?: EInvoiceTransport };

/** Installs the secret store kernel and module code read secrets through; `undefined` removes it. */
export function setSecretStore(store: SecretStore | undefined): void {
  globals[SECRETS_KEY] = store;
}

/** The installed secret store, or undefined when the deployment has none yet (Task 19 installs the Vault-backed one). */
export function secretStore(): SecretStore | undefined {
  return globals[SECRETS_KEY];
}

/** Replaces the electronic-invoice transport the country pack would build (tests); `undefined` goes back to the pack's. */
export function setEInvoiceTransport(transport: EInvoiceTransport | undefined): void {
  globals[TRANSPORT_KEY] = transport;
}

/** The installed transport override, if any. */
export function installedEInvoiceTransport(): EInvoiceTransport | undefined {
  return globals[TRANSPORT_KEY];
}
