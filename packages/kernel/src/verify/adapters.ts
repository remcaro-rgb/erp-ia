// Provider adapters of the external verification hooks (design §5.16). Phase 1 ships none: the company
// picks a provider per kind in kernel.verifiers and a module or the app registers its adapter at start-up.

export type VerifyKind = "email" | "phone" | "document";

export interface VerifierAdapter {
  /** Asks the provider about `value` (a normalized e-mail, `+<cc><number>` or identification text). */
  verify(kind: VerifyKind, value: string): Promise<{ ok: boolean; detail?: unknown }>;
}

const adapters = new Map<string, VerifierAdapter>();

/** Registers the adapter of `provider`; throws when the provider already has one. */
export function registerVerifier(provider: string, adapter: VerifierAdapter): void {
  if (adapters.has(provider)) throw new Error(`verifier ${provider} is already registered`);
  adapters.set(provider, adapter);
}

/** Removes the adapter of `provider`; used by tests. */
export function unregisterVerifier(provider: string): void {
  adapters.delete(provider);
}

export const verifierAdapter = (provider: string): VerifierAdapter | undefined => adapters.get(provider);
