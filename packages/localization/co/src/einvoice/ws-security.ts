// WS-Security for the DIAN SOAP 1.2 web service (ported from Serena ws-security.ts). DIAN (a WCF service) rejects any request
// without a signed WS-Security header ("InvalidSecurity"). Required per the Anexo Técnico: WS-Addressing headers (wsa:Action,
// wsa:To) and a wsse:Security header with a wsu:Timestamp, the X.509 certificate as BinarySecurityToken and an exclusive-c14n
// RSA-SHA256 signature whose single Reference covers the wsa:To element. Digest and signature are computed over the exact strings
// emitted (self-contained namespace declarations in prefix order, explicit end tags, no inter-element whitespace), so no separate
// canonicalization pass is needed.

import forge from "node-forge";
import { createHash, randomBytes } from "node:crypto";
import { extractP12, type SoapCertificate } from "./certificate";

export type { SoapCertificate } from "./certificate";

const NS = {
  wsse: "http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd",
  wsu: "http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd",
  wsa: "http://www.w3.org/2005/08/addressing",
  ds: "http://www.w3.org/2000/09/xmldsig#",
  soap: "http://www.w3.org/2003/05/soap-envelope",
  wcf: "http://wcf.dian.colombia",
};
const X509_TOKEN = "http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-x509-token-profile-1.0#X509v3";
const BASE64_ENCODING = "http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-soap-message-security-1.0#Base64Binary";
const EXC_C14N = "http://www.w3.org/2001/10/xml-exc-c14n#";
const RSA_SHA256 = "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256";
const SHA256 = "http://www.w3.org/2001/04/xmlenc#sha256";

export type DianOperation = "SendBillSync" | "GetStatus" | "SendTestSetAsync";

const esc = (v: string) => v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** The operation payload inside soap:Body (the wcf namespace is declared on the Envelope). Values are XML-escaped (base64 is unaffected). */
export function buildBody(operation: DianOperation, params: Record<string, string>): string {
  const p = (key: string) => esc(params[key] ?? "");
  if (operation === "SendBillSync") return `<wcf:SendBillSync><wcf:fileName>${p("fileName")}</wcf:fileName><wcf:contentFile>${p("contentFile")}</wcf:contentFile></wcf:SendBillSync>`;
  if (operation === "GetStatus") return `<wcf:GetStatus><wcf:trackId>${p("trackId")}</wcf:trackId></wcf:GetStatus>`;
  return `<wcf:SendTestSetAsync><wcf:fileName>${p("fileName")}</wcf:fileName><wcf:contentFile>${p("contentFile")}</wcf:contentFile><wcf:testSetId>${p("testSetId")}</wcf:testSetId></wcf:SendTestSetAsync>`;
}

/** A WS-Security-signed SOAP 1.2 envelope for a DIAN operation. `action` is the full SOAP action URI, `to` the endpoint URL. */
export function buildSecuredEnvelope(options: { operation: DianOperation; params: Record<string, string>; action: string; to: string; cert: SoapCertificate }): string {
  const { operation, params, action, to, cert } = options;
  const { privateKey, certificate } = extractP12(cert.buffer, cert.password);
  const certBase64 = forge.util.encode64(forge.asn1.toDer(forge.pki.certificateToAsn1(certificate)).getBytes());

  const uid = randomBytes(8).toString("hex");
  const toId = `ID-${uid}`;
  const toElement = `<wsa:To xmlns:wsa="${NS.wsa}" xmlns:wsu="${NS.wsu}" wsu:Id="${toId}">${esc(to)}</wsa:To>`;
  const toDigest = createHash("sha256").update(toElement, "utf8").digest("base64");

  const signedInfo =
    `<ds:SignedInfo xmlns:ds="${NS.ds}">` +
    `<ds:CanonicalizationMethod Algorithm="${EXC_C14N}"></ds:CanonicalizationMethod>` +
    `<ds:SignatureMethod Algorithm="${RSA_SHA256}"></ds:SignatureMethod>` +
    `<ds:Reference URI="#${toId}">` +
    `<ds:Transforms><ds:Transform Algorithm="${EXC_C14N}"></ds:Transform></ds:Transforms>` +
    `<ds:DigestMethod Algorithm="${SHA256}"></ds:DigestMethod>` +
    `<ds:DigestValue>${toDigest}</ds:DigestValue>` +
    `</ds:Reference>` +
    `</ds:SignedInfo>`;

  const md = forge.md.sha256.create();
  md.update(signedInfo, "utf8");
  const signatureValue = forge.util.encode64(privateKey.sign(md));

  const now = new Date();
  const expires = new Date(now.getTime() + 5 * 60 * 1000);

  const security =
    `<wsse:Security xmlns:wsse="${NS.wsse}" xmlns:wsu="${NS.wsu}" soap:mustUnderstand="1">` +
    `<wsu:Timestamp wsu:Id="TS-${uid}"><wsu:Created>${now.toISOString()}</wsu:Created><wsu:Expires>${expires.toISOString()}</wsu:Expires></wsu:Timestamp>` +
    `<wsse:BinarySecurityToken EncodingType="${BASE64_ENCODING}" ValueType="${X509_TOKEN}" wsu:Id="X509-${uid}">${certBase64}</wsse:BinarySecurityToken>` +
    `<ds:Signature xmlns:ds="${NS.ds}" Id="SIG-${uid}">` +
    signedInfo +
    `<ds:SignatureValue>${signatureValue}</ds:SignatureValue>` +
    `<ds:KeyInfo Id="KI-${uid}"><wsse:SecurityTokenReference wsu:Id="STR-${uid}"><wsse:Reference URI="#X509-${uid}" ValueType="${X509_TOKEN}"></wsse:Reference></wsse:SecurityTokenReference></ds:KeyInfo>` +
    `</ds:Signature>` +
    `</wsse:Security>`;

  return (
    `<soap:Envelope xmlns:soap="${NS.soap}" xmlns:wsa="${NS.wsa}" xmlns:wcf="${NS.wcf}">` +
    `<soap:Header>${security}<wsa:Action>${esc(action)}</wsa:Action>${toElement}</soap:Header>` +
    `<soap:Body>${buildBody(operation, params)}</soap:Body>` +
    `</soap:Envelope>`
  );
}
