import { EInvoiceTransportError, EnvSecretStore, MockEInvoiceTransport, type EInvoiceResult, type EInvoiceSubmitMeta, type EInvoiceTransport, type Env, type SecretStore } from "@erp/infra";
import { loadCertificate } from "./certificate";
import { getStatus, sendBillSync, sendTestSetAsync, type DianEnvironment, type DIANResponse } from "./soap-client";

// The real DIAN transport behind `EInvoiceTransport` (design §19: direct submission first), and the factory that picks it from
// configuration. It needs the company's certificate from the secrets seam; without one it fails with "credentials not configured"
// BEFORE any network call. Tests and CI run only the mock and a stubbed fetcher.

export interface DianSoapTransportOptions {
  environment: DianEnvironment;
  secrets: SecretStore;
  companyId: string;
  /** Injected for tests; defaults to the global fetch. */
  fetcher?: typeof fetch;
  /** Per-request abort timeout in ms (default 30 000). */
  timeoutMs?: number;
}

/** Statuses of GetStatus that mean "DIAN has it but has not finished": 98 en proceso, 90 TrackId no encontrado (not yet visible), 66 NSU no encontrado. */
const PENDING_CODES = new Set(["98", "66"]);
/** GetStatus code 90, «TrackId no encontrado»: the DIAN never received a document under it (Task 17 fix round 1; UNCONFIRMED against habilitación). */
const NOT_FOUND_CODE = "90";

export class DianSoapTransport implements EInvoiceTransport {
  readonly name: string;

  constructor(private readonly options: DianSoapTransportOptions) {
    this.name = `dian-${options.environment}`;
  }

  private get timeout(): { timeoutMs?: number } {
    return this.options.timeoutMs !== undefined ? { timeoutMs: this.options.timeoutMs } : {};
  }

  private get fetcher(): typeof fetch {
    return this.options.fetcher ?? fetch;
  }

  /**
   * SendBillSync answers under the document's CUFE (the trackId GetStatus takes for it); the habilitación test set (SendTestSetAsync) is
   * tracked by the ZipKey DIAN answers, unknown before the answer. UNCONFIRMED against a live habilitación (no credentials yet).
   */
  expectedTrackId(meta: EInvoiceSubmitMeta): string | null {
    return meta.testSetId ? null : meta.cufe;
  }

  async submit(signedXml: string, meta: EInvoiceSubmitMeta): Promise<EInvoiceResult> {
    const cert = await loadCertificate(this.options.secrets, this.options.companyId);
    const base = { signedXml, nit: meta.issuerNit, invoiceNumber: meta.documentNumber, environment: this.options.environment, cert, fetcher: this.fetcher, ...this.timeout };
    if (meta.testSetId) {
      // The habilitación test set is asynchronous: DIAN answers a ZipKey and the verdict comes from GetStatus.
      const response = this.checked(await sendTestSetAsync({ ...base, testSetId: meta.testSetId }));
      return { trackId: response.trackId ?? meta.cufe, status: "pending", errors: [] };
    }
    const response = this.checked(await sendBillSync(base));
    return this.toResult(response, response.trackId ?? meta.cufe);
  }

  async poll(trackId: string): Promise<EInvoiceResult> {
    const cert = await loadCertificate(this.options.secrets, this.options.companyId);
    const response = this.checked(await getStatus({ trackId, environment: this.options.environment, cert, fetcher: this.fetcher, ...this.timeout }));
    if (response.statusCode === NOT_FOUND_CODE) return { trackId, status: "not_found", errors: [] };
    return this.toResult(response, trackId);
  }

  /** HTTP and network failures are not verdicts: throw so the caller retries. */
  private checked(response: DIANResponse): DIANResponse {
    if (response.statusCode === "HTTP_ERROR" || response.statusCode === "NETWORK_ERROR") {
      throw new EInvoiceTransportError(`${response.errorMessages.join(" ")}${response.statusMessage ? ` (${response.statusMessage})` : ""}`);
    }
    return response;
  }

  private toResult(response: DIANResponse, trackId: string): EInvoiceResult {
    if (response.success) return { trackId, status: "accepted", errors: [], ...(response.xmlResponse ? { applicationResponse: response.xmlResponse } : {}) };
    if (PENDING_CODES.has(response.statusCode)) return { trackId, status: "pending", errors: [] };
    const errors = response.errorMessages.length ? response.errorMessages : [response.statusDescription || response.statusMessage || `DIAN status ${response.statusCode}`];
    return { trackId, status: "rejected", errors, ...(response.xmlResponse ? { applicationResponse: response.xmlResponse } : {}) };
  }
}

export type EInvoiceTransportKind = "mock" | "dian-habilitacion" | "dian-produccion";

/** A refusal of a transport that does not serve the company's DIAN environment (the production guard, plan 2B Task 19). */
export class EInvoiceEnvironmentMismatchError extends Error {
  constructor(transport: string, environment: "habilitacion" | "produccion") {
    super(
      environment === "produccion"
        ? `einvoice_environment_mismatch: la empresa factura en producción y el transporte configurado es «${transport}»: solo EINVOICE_TRANSPORT=dian-produccion envía documentos con validez fiscal (el simulador y habilitación no)`
        : `einvoice_environment_mismatch: la empresa está en habilitación y el transporte configurado es «${transport}»: un documento de prueba nunca va a producción`,
    );
    this.name = "EInvoiceEnvironmentMismatchError";
  }
}

/**
 * The production guard (Tasks 17/18 carry, Task 19): a company in producción is served only by the DIAN's production transport (never the
 * mock, never habilitación: a mock verdict has no fiscal value); a company in habilitación never by the production one. The transport is
 * known by its name (`mock`, `dian-habilitacion`, `dian-produccion`; a test's scripted transport names itself `*-mock`).
 */
export function assertTransportEnvironment(transport: Pick<EInvoiceTransport, "name">, environment: "habilitacion" | "produccion"): void {
  const production = transport.name === "dian-produccion";
  if (environment === "produccion" ? !production : production) throw new EInvoiceEnvironmentMismatchError(transport.name, environment);
}

/**
 * `EINVOICE_TRANSPORT=mock|dian-habilitacion|dian-produccion`; unset means the mock, so the Docker stack and CI never reach DIAN.
 * The hosted demo sets `dian-habilitacion`. With `environment` (the company's dian_environment) the transport must serve it
 * (assertTransportEnvironment): the mock is refused for a company in producción.
 */
export function createEInvoiceTransport(
  env: Env,
  deps: { secrets?: SecretStore; companyId: string; environment?: "habilitacion" | "produccion"; fetcher?: typeof fetch; timeoutMs?: number },
): EInvoiceTransport {
  const kind = env.EINVOICE_TRANSPORT?.trim() || "mock";
  const { environment, ...rest } = deps;
  if (environment) assertTransportEnvironment({ name: kind }, environment);
  if (kind === "mock") return new MockEInvoiceTransport();
  if (kind === "dian-habilitacion" || kind === "dian-produccion") {
    // Ruling (task 5 review): certificates live in Supabase Vault (Task 19's VaultSecretStore, installed by the app runtime). The real
    // transports need a SecretStore injected explicitly: there is no implicit fallback, and the environment-backed store (EnvSecretStore)
    // is refused.
    const { secrets, ...others } = rest;
    if (!secrets) throw new Error(`EINVOICE_TRANSPORT=${kind} needs a SecretStore injected explicitly (the app installs the Vault-backed store); there is no environment fallback`);
    if (secrets instanceof EnvSecretStore) throw new Error(`EINVOICE_TRANSPORT=${kind} does not accept EnvSecretStore: certificates live in Supabase Vault (rule 12)`);
    return new DianSoapTransport({ environment: kind === "dian-produccion" ? "produccion" : "habilitacion", secrets, ...others });
  }
  throw new Error(`EINVOICE_TRANSPORT must be one of mock, dian-habilitacion, dian-produccion (got "${kind}")`);
}
