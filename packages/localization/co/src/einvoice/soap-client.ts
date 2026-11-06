import JSZip from "jszip";
import { XMLParser } from "fast-xml-parser";
import { DIAN_ENDPOINTS, DIAN_SOAP_ACTIONS } from "./constants";
import { buildBody, buildSecuredEnvelope, type DianOperation } from "./ws-security";
import type { SoapCertificate } from "./certificate";

// SOAP client for the DIAN web service (ported from Serena soap-client.ts). Everything here is plain functions; the network is
// reached only through the injected `fetcher`, and only `DianSoapTransport` (transport.ts) calls `postSoap`.

export interface DIANResponse {
  success: boolean;
  statusCode: string;
  statusDescription: string;
  statusMessage: string;
  errorMessages: string[];
  xmlResponse?: string;
  trackId?: string;
}

export type DianEnvironment = "habilitacion" | "produccion";

/** The plain (unsecured) envelope; DIAN rejects it, kept for tests and diagnostics. */
export function buildSoapEnvelope(operation: DianOperation, params: Record<string, string>): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope" xmlns:wcf="http://wcf.dian.colombia">
  <soap:Body>
    ${buildBody(operation, params)}
  </soap:Body>
</soap:Envelope>`;
}

const parser = () => new XMLParser({ ignoreAttributes: true, removeNSPrefix: true, parseTagValue: false });

/** "InvalidSecurity: An error occurred when verifying security for the message." from a SOAP fault body, or null when it is not a fault. */
export function parseSoapFault(responseXml: string): string | null {
  try {
    const fault = parser().parse(responseXml)?.Envelope?.Body?.Fault;
    if (!fault) return null;
    const subcode = fault?.Code?.Subcode?.Value ?? fault?.Code?.Value ?? "";
    const raw = fault?.Reason?.Text;
    const reason = typeof raw === "string" ? raw : (raw?.["#text"] ?? (Array.isArray(raw) ? String(raw[0]) : ""));
    const parts = [String(subcode).replace(/^.*:/, ""), String(reason)].filter(Boolean);
    return parts.length ? parts.join(": ") : null;
  } catch {
    return null;
  }
}

const asList = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : v ? [String(v)] : []);

export function parseSoapResponse(responseXml: string): DIANResponse {
  const parsed = parser().parse(responseXml);
  const body = parsed?.Envelope?.Body;
  if (!body || typeof body !== "object") {
    return { success: false, statusCode: "PARSE_ERROR", statusDescription: "Could not parse SOAP response", statusMessage: "", errorMessages: ["Invalid SOAP response structure"] };
  }
  const resultKey = Object.keys(body).find((k) => k.endsWith("Response"));
  const responseObj = resultKey ? body[resultKey] : body;
  const innerKey = responseObj && typeof responseObj === "object" ? Object.keys(responseObj).find((k) => k.endsWith("Result")) : undefined;
  const result = innerKey ? responseObj[innerKey] : responseObj;

  const statusCode = String(result?.StatusCode ?? "UNKNOWN");
  // SendBillSync reports ErrorMessages, GetStatus / SendTestSetAsync report ErrorMessage; both hold <string> children.
  const errorMessages = [...asList(result?.ErrorMessages?.string), ...asList(result?.ErrorMessage?.string)];
  let xmlResponse: string | undefined;
  if (result?.XmlBase64Bytes) {
    try {
      xmlResponse = Buffer.from(String(result.XmlBase64Bytes), "base64").toString("utf-8");
    } catch {
      // not decodable: keep none
    }
  }
  return {
    success: statusCode === "00",
    statusCode,
    statusDescription: String(result?.StatusDescription ?? ""),
    statusMessage: String(result?.StatusMessage ?? ""),
    errorMessages,
    xmlResponse,
    // SendBillSync / GetStatus report TrackId; SendTestSetAsync reports ZipKey.
    trackId: result?.TrackId ? String(result.TrackId) : result?.ZipKey ? String(result.ZipKey) : undefined,
  };
}

export async function createInvoiceZip(xmlContent: string, fileName: string): Promise<string> {
  const zip = new JSZip();
  zip.file(fileName, xmlContent);
  return (await zip.generateAsync({ type: "nodebuffer" })).toString("base64");
}

/**
 * POST a WS-Security-signed SOAP request. SOAP faults are decoded ("InvalidSecurity: ..."). HTTP and network failures come back
 * with statusCode HTTP_ERROR / NETWORK_ERROR so the transport can treat them as transient.
 */
export async function postSoap(options: {
  operation: DianOperation;
  params: Record<string, string>;
  environment: DianEnvironment;
  cert: SoapCertificate;
  fetcher: typeof fetch;
  /** Abort the request after this long (default 30 s). */
  timeoutMs?: number;
}): Promise<DIANResponse> {
  const { operation, params, environment, cert, fetcher } = options;
  const action = DIAN_SOAP_ACTIONS[operation];
  const endpoint = DIAN_ENDPOINTS[environment];
  const envelope = buildSecuredEnvelope({ operation, params, action, to: endpoint, cert });
  try {
    const response = await fetcher(endpoint, {
      method: "POST",
      // SOAP 1.2 carries the action in the Content-Type, not SOAPAction.
      headers: { "Content-Type": `application/soap+xml;charset=UTF-8;action="${action}"` },
      body: envelope,
      signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
    });
    const responseXml = await response.text();
    if (!response.ok) {
      const fault = parseSoapFault(responseXml);
      return {
        success: false,
        statusCode: "HTTP_ERROR",
        statusDescription: `HTTP ${response.status}`,
        statusMessage: fault ?? responseXml.slice(0, 300),
        errorMessages: [`DIAN endpoint returned HTTP ${response.status}${fault ? `: ${fault}` : ""}`],
      };
    }
    return parseSoapResponse(responseXml);
  } catch (error) {
    return {
      success: false,
      statusCode: "NETWORK_ERROR",
      statusDescription: "Network error",
      statusMessage: error instanceof Error ? error.message : "Unknown error",
      errorMessages: ["Could not connect to DIAN web service"],
    };
  }
}

export async function sendBillSync(args: { signedXml: string; nit: string; invoiceNumber: string; environment: DianEnvironment; cert: SoapCertificate; fetcher: typeof fetch; timeoutMs?: number }): Promise<DIANResponse> {
  const contentFile = await createInvoiceZip(args.signedXml, `${args.nit}${args.invoiceNumber}.xml`);
  return postSoap({ operation: "SendBillSync", params: { fileName: `${args.nit}${args.invoiceNumber}.zip`, contentFile }, ...pick(args) });
}

export async function sendTestSetAsync(args: { signedXml: string; nit: string; invoiceNumber: string; testSetId: string; environment: DianEnvironment; cert: SoapCertificate; fetcher: typeof fetch; timeoutMs?: number }): Promise<DIANResponse> {
  const contentFile = await createInvoiceZip(args.signedXml, `${args.nit}${args.invoiceNumber}.xml`);
  return postSoap({ operation: "SendTestSetAsync", params: { fileName: `${args.nit}${args.invoiceNumber}.zip`, contentFile, testSetId: args.testSetId }, ...pick(args) });
}

export async function getStatus(args: { trackId: string; environment: DianEnvironment; cert: SoapCertificate; fetcher: typeof fetch; timeoutMs?: number }): Promise<DIANResponse> {
  return postSoap({ operation: "GetStatus", params: { trackId: args.trackId }, ...pick(args) });
}

const pick = (a: { environment: DianEnvironment; cert: SoapCertificate; fetcher: typeof fetch; timeoutMs?: number }) => ({ environment: a.environment, cert: a.cert, fetcher: a.fetcher, ...(a.timeoutMs !== undefined ? { timeoutMs: a.timeoutMs } : {}) });
