import { beforeAll, describe, expect, it } from "vitest";
import forge from "node-forge";
import { parseCertificate, signInvoice, verifySignedInvoice } from "../einvoice/signer";
import { generateTestCertP12 } from "./helpers/test-cert";

const TEST_XML = `<?xml version="1.0" encoding="UTF-8"?>
<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"
  xmlns:ext="urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2">
  <ext:UBLExtensions>
    <ext:UBLExtension>
      <ext:ExtensionContent>
        <sts:DianExtensions xmlns:sts="dian:gov:co:facturaelectronica:Structures-2-1">
          <sts:InvoiceControl/>
        </sts:DianExtensions>
      </ext:ExtensionContent>
    </ext:UBLExtension>
    <ext:UBLExtension>
      <ext:ExtensionContent>
        <!-- SIGNATURE_PLACEHOLDER -->
      </ext:ExtensionContent>
    </ext:UBLExtension>
  </ext:UBLExtensions>
  <cbc:ID xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2">TEST001</cbc:ID>
</Invoice>`;

let cert: { buffer: Buffer; password: string };
beforeAll(() => {
  cert = generateTestCertP12({ serial: "0a1b2c3d4e5f60718293" });
}, 60_000);

describe("signInvoice", () => {
  it("inserts ds:Signature in place of the placeholder", () => {
    const signed = signInvoice(TEST_XML, cert);
    expect(signed).toContain("<ds:Signature");
    expect(signed).toContain("</ds:Signature>");
    expect(signed).not.toContain("SIGNATURE_PLACEHOLDER");
  });

  it("includes XAdES signed properties and the certificate in KeyInfo", () => {
    const signed = signInvoice(TEST_XML, cert);
    for (const part of ["xades:SignedProperties", "xades:SigningTime", "xades:SigningCertificate", "<ds:X509Certificate>"]) expect(signed).toContain(part);
  });

  it("writes the full certificate serial (beyond 2^53) as a decimal in IssuerSerial", () => {
    const signed = signInvoice(TEST_XML, cert);
    const expected = BigInt("0x0a1b2c3d4e5f60718293").toString();
    expect(signed).toContain(`<ds:X509SerialNumber>${expected}</ds:X509SerialNumber>`);
  });

  it("throws on a wrong password and on a document without the placeholder", () => {
    expect(() => signInvoice(TEST_XML, { buffer: cert.buffer, password: "wrongpassword" })).toThrow();
    expect(() => signInvoice("<Invoice/>", cert)).toThrow(/SIGNATURE_PLACEHOLDER/);
  });
});

describe("verifySignedInvoice: the signed output verifies against the cert", () => {
  it("verifies the signature value with the embedded certificate, and all three reference digests", () => {
    const signed = signInvoice(TEST_XML, cert);
    const result = verifySignedInvoice(signed);
    expect(result).toEqual({ valid: true, errors: [] });
  });

  it("verifies against the expected certificate and rejects a different one", () => {
    const signed = signInvoice(TEST_XML, cert);
    const info = parseCertificate(cert.buffer, cert.password);
    expect(verifySignedInvoice(signed, { certificatePem: info.pem }).valid).toBe(true);
    const other = parseCertificate(generateTestCertP12({ cn: "Other" }).buffer, "testpass123");
    const mismatch = verifySignedInvoice(signed, { certificatePem: other.pem });
    expect(mismatch.valid).toBe(false);
    expect(mismatch.errors.join(" ")).toMatch(/certificate/i);
  });

  it("fails when the document is tampered after signing", () => {
    const signed = signInvoice(TEST_XML, cert).replace("TEST001", "TEST002");
    const result = verifySignedInvoice(signed);
    expect(result.valid).toBe(false);
    expect(result.errors.join(" ")).toMatch(/document digest/i);
  });

  it("fails when the SignedInfo or signature value is tampered", () => {
    const signed = signInvoice(TEST_XML, cert);
    expect(verifySignedInvoice(signed.replace("<ds:SignatureValue>", "<ds:SignatureValue>AAAA")).valid).toBe(false);
    expect(verifySignedInvoice(signed.replace("rsa-sha256", "rsa-sha512")).valid).toBe(false);
  });

  it("fails on an unsigned document", () => {
    expect(verifySignedInvoice(TEST_XML).valid).toBe(false);
  });
});

describe("parseCertificate", () => {
  it("returns certificate info", () => {
    const info = parseCertificate(cert.buffer, cert.password);
    expect(info.isValid).toBe(true);
    expect(info.subjectName).toContain("Test DIAN Cert");
    expect(info.subjectNit).toBe("900123456");
    expect(info.expiresInDays).toBeGreaterThan(300);
    expect(info.pem).toContain("BEGIN CERTIFICATE");
    expect(forge.pki.certificateFromPem(info.pem).subject.getField("CN").value).toBe("Test DIAN Cert");
  });

  it("flags an expired certificate", () => {
    const expired = generateTestCertP12({ days: -1 });
    const info = parseCertificate(expired.buffer, expired.password);
    expect(info.isValid).toBe(false);
  });
});
