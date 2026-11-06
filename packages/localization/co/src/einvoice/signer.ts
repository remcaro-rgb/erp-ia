import forge from "node-forge";
import { createHash } from "node:crypto";
import { DIAN_SIGNATURE_POLICY } from "./constants";
import { extractP12, type SoapCertificate } from "./certificate";

// XAdES-EPES signature of a UBL document (ported from Serena signer.ts). The document carries
// `<!-- SIGNATURE_PLACEHOLDER -->` inside the second UBLExtension (xml-builder); the signature takes its place.
// Digests and the signature are computed over the exact strings emitted, as Serena does.

export { parseCertificate } from "./certificate";
export type { CertificateInfo } from "./certificate";

const PLACEHOLDER = "<!-- SIGNATURE_PLACEHOLDER -->";
const sha256b64 = (data: string | Buffer) => createHash("sha256").update(data).digest("base64");
const esc = (v: string) => v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function signInvoice(xml: string, cert: SoapCertificate): string {
  if (!xml.includes(PLACEHOLDER)) throw new Error("The document has no SIGNATURE_PLACEHOLDER to sign into");
  const { privateKey, certificate } = extractP12(cert.buffer, cert.password);

  const certDer = forge.asn1.toDer(forge.pki.certificateToAsn1(certificate)).getBytes();
  const certBase64 = forge.util.encode64(certDer);
  const certDigest = sha256b64(Buffer.from(certDer, "binary"));
  const issuerName = esc(certificate.issuer.attributes.map((a) => `${a.shortName || a.name}=${a.value}`).join(","));
  // The serial is a hex string of up to 20 bytes: far beyond Number precision, so BigInt.
  const serialDecimal = BigInt(`0x${certificate.serialNumber || "0"}`).toString();
  const signingTime = new Date().toISOString();
  const policyHash = sha256b64(DIAN_SIGNATURE_POLICY.identifier);

  const stamp = Date.now();
  const signedPropertiesId = `xmldsig-${stamp}-signedprops`;
  const signatureId = `xmldsig-${stamp}`;
  const keyInfoId = `xmldsig-${stamp}-keyinfo`;

  const signedProperties = `<xades:SignedProperties Id="${signedPropertiesId}">
  <xades:SignedSignatureProperties>
    <xades:SigningTime>${signingTime}</xades:SigningTime>
    <xades:SigningCertificate>
      <xades:Cert>
        <xades:CertDigest>
          <ds:DigestMethod Algorithm="http://www.w3.org/2001/04/xmlenc#sha256"/>
          <ds:DigestValue>${certDigest}</ds:DigestValue>
        </xades:CertDigest>
        <xades:IssuerSerial>
          <ds:X509IssuerName>${issuerName}</ds:X509IssuerName>
          <ds:X509SerialNumber>${serialDecimal}</ds:X509SerialNumber>
        </xades:IssuerSerial>
      </xades:Cert>
    </xades:SigningCertificate>
    <xades:SignaturePolicyIdentifier>
      <xades:SignaturePolicy>
        <xades:SignaturePolicyId>
          <xades:SigPolicyId>
            <xades:Identifier>${DIAN_SIGNATURE_POLICY.identifier}</xades:Identifier>
            <xades:Description>${DIAN_SIGNATURE_POLICY.description}</xades:Description>
          </xades:SigPolicyId>
          <xades:SigPolicyHash>
            <ds:DigestMethod Algorithm="http://www.w3.org/2001/04/xmlenc#sha256"/>
            <ds:DigestValue>${policyHash}</ds:DigestValue>
          </xades:SigPolicyHash>
        </xades:SignaturePolicyId>
      </xades:SignaturePolicy>
    </xades:SignaturePolicyIdentifier>
  </xades:SignedSignatureProperties>
  <xades:SignedDataObjectProperties>
    <xades:DataObjectFormat ObjectReference="#xmldsig-ref0">
      <xades:MimeType>text/xml</xades:MimeType>
    </xades:DataObjectFormat>
  </xades:SignedDataObjectProperties>
</xades:SignedProperties>`;

  const keyInfo = `<ds:KeyInfo Id="${keyInfoId}">
  <ds:X509Data>
    <ds:X509Certificate>${certBase64}</ds:X509Certificate>
  </ds:X509Data>
</ds:KeyInfo>`;

  const signedInfo = `<ds:SignedInfo>
  <ds:CanonicalizationMethod Algorithm="http://www.w3.org/TR/2001/REC-xml-c14n-20010315"/>
  <ds:SignatureMethod Algorithm="http://www.w3.org/2001/04/xmldsig-more#rsa-sha256"/>
  <ds:Reference Id="xmldsig-ref0" URI="">
    <ds:Transforms>
      <ds:Transform Algorithm="http://www.w3.org/2000/09/xmldsig#enveloped-signature"/>
    </ds:Transforms>
    <ds:DigestMethod Algorithm="http://www.w3.org/2001/04/xmlenc#sha256"/>
    <ds:DigestValue>${sha256b64(xml)}</ds:DigestValue>
  </ds:Reference>
  <ds:Reference URI="#${keyInfoId}">
    <ds:DigestMethod Algorithm="http://www.w3.org/2001/04/xmlenc#sha256"/>
    <ds:DigestValue>${sha256b64(keyInfo)}</ds:DigestValue>
  </ds:Reference>
  <ds:Reference Type="http://uri.etsi.org/01903#SignedProperties" URI="#${signedPropertiesId}">
    <ds:DigestMethod Algorithm="http://www.w3.org/2001/04/xmlenc#sha256"/>
    <ds:DigestValue>${sha256b64(signedProperties)}</ds:DigestValue>
  </ds:Reference>
</ds:SignedInfo>`;

  const md = forge.md.sha256.create();
  md.update(signedInfo, "utf8");
  const signatureValue = forge.util.encode64(privateKey.sign(md));

  const signature = `<ds:Signature xmlns:ds="http://www.w3.org/2000/09/xmldsig#" Id="${signatureId}">
${signedInfo}
  <ds:SignatureValue>${signatureValue}</ds:SignatureValue>
  ${keyInfo}
  <ds:Object>
    <xades:QualifyingProperties xmlns:xades="http://uri.etsi.org/01903/v1.3.2#" Target="#${signatureId}">
      ${signedProperties}
    </xades:QualifyingProperties>
  </ds:Object>
</ds:Signature>`;

  // A replacer function: the signature text must never be read as a replacement pattern ($&, $1, ...).
  return xml.replace(PLACEHOLDER, () => signature);
}

export interface VerifyResult {
  valid: boolean;
  errors: string[];
}

/**
 * Checks what `signInvoice` produced: the three reference digests (document with the signature put back to the placeholder,
 * KeyInfo, SignedProperties), then the RSA-SHA256 signature value over SignedInfo with the embedded certificate, and, when
 * `certificatePem` is given, that the embedded certificate is that one.
 *
 * This is a LOCAL SELF-CHECK of our own output (did we sign what we meant to, with the key we meant to). It is NOT a trust gate:
 * it does not validate the certificate chain, revocation or validity period, and must never decide whether a third-party document
 * is trusted. DIAN validates its own way.
 */
export function verifySignedInvoice(signedXml: string, expected: { certificatePem?: string } = {}): VerifyResult {
  const errors: string[] = [];
  const signature = signedXml.match(/<ds:Signature[ >][\s\S]*?<\/ds:Signature>/)?.[0];
  if (!signature) return { valid: false, errors: ["No ds:Signature in the document"] };
  const part = (re: RegExp) => signature.match(re)?.[0];
  const signedInfo = part(/<ds:SignedInfo>[\s\S]*?<\/ds:SignedInfo>/);
  const keyInfo = part(/<ds:KeyInfo [\s\S]*?<\/ds:KeyInfo>/);
  const signedProperties = part(/<xades:SignedProperties [\s\S]*?<\/xades:SignedProperties>/);
  const value = signature.match(/<ds:SignatureValue>([^<]+)<\/ds:SignatureValue>/)?.[1];
  const certB64 = signature.match(/<ds:X509Certificate>([^<]+)<\/ds:X509Certificate>/)?.[1];
  if (!signedInfo || !keyInfo || !signedProperties || !value || !certB64) return { valid: false, errors: ["Incomplete ds:Signature"] };

  const digestOf = (uriMatch: RegExp) => signedInfo.match(uriMatch)?.[1];
  const checks: [string, string | undefined, string][] = [
    ["document digest", digestOf(/URI=""[\s\S]*?<ds:DigestValue>([^<]+)</), sha256b64(signedXml.replace(signature, () => PLACEHOLDER))],
    ["KeyInfo digest", digestOf(/URI="#[^"]*-keyinfo">\s*<ds:DigestMethod[^>]*>\s*<ds:DigestValue>([^<]+)</), sha256b64(keyInfo)],
    ["SignedProperties digest", digestOf(/SignedProperties" URI="[^"]*">\s*<ds:DigestMethod[^>]*>\s*<ds:DigestValue>([^<]+)</), sha256b64(signedProperties)],
  ];
  for (const [label, stated, actual] of checks) if (stated !== actual) errors.push(`${label} does not match`);

  try {
    const certificate = forge.pki.certificateFromAsn1(forge.asn1.fromDer(forge.util.decode64(certB64)));
    const md = forge.md.sha256.create();
    md.update(signedInfo, "utf8");
    if (!(certificate.publicKey as forge.pki.rsa.PublicKey).verify(md.digest().bytes(), forge.util.decode64(value))) errors.push("Signature value does not verify against the embedded certificate");
    if (expected.certificatePem) {
      const wanted = forge.util.encode64(forge.asn1.toDer(forge.pki.certificateToAsn1(forge.pki.certificateFromPem(expected.certificatePem))).getBytes());
      if (wanted !== certB64) errors.push("The embedded certificate is not the expected certificate");
    }
  } catch (error) {
    errors.push(`Signature could not be checked: ${error instanceof Error ? error.message : String(error)}`);
  }
  return { valid: errors.length === 0, errors };
}
