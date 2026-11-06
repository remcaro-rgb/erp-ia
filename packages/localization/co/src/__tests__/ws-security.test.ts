import { createHash } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import forge from "node-forge";
import { buildSecuredEnvelope } from "../einvoice/ws-security";
import { parseSoapFault } from "../einvoice/soap-client";
import { generateTestCertP12 } from "./helpers/test-cert";

describe("buildSecuredEnvelope", () => {
  let envelope = "";
  beforeAll(() => {
    envelope = buildSecuredEnvelope({
      operation: "GetStatus",
      params: { trackId: "track-1" },
      action: "http://wcf.dian.colombia/IWcfDianCustomerServices/GetStatus",
      to: "https://vpfe-hab.dian.gov.co/WcfDianCustomerServices.svc",
      cert: generateTestCertP12({ password: "test123" }),
    });
  }, 60_000);

  it("carries the WS-Security header parts DIAN requires", () => {
    expect(envelope).toContain("<wsse:Security");
    expect(envelope).toContain('soap:mustUnderstand="1"');
    expect(envelope).toContain("<wsu:Timestamp");
    expect(envelope).toContain("<wsse:BinarySecurityToken");
    expect(envelope).toContain("<ds:Signature");
    expect(envelope).toContain("<wsse:SecurityTokenReference");
    expect(envelope).toContain("<wsa:Action>http://wcf.dian.colombia/IWcfDianCustomerServices/GetStatus</wsa:Action>");
    expect(envelope).toContain("<wcf:GetStatus><wcf:trackId>track-1</wcf:trackId></wcf:GetStatus>");
  });

  it("digests the wsa:To element exactly as emitted", () => {
    const toMatch = envelope.match(/<wsa:To xmlns:wsa="[^"]+" xmlns:wsu="[^"]+" wsu:Id="[^"]+">[^<]+<\/wsa:To>/);
    expect(toMatch).not.toBeNull();
    const expectedDigest = createHash("sha256").update(toMatch![0], "utf8").digest("base64");
    expect(envelope.match(/<ds:DigestValue>([^<]+)<\/ds:DigestValue>/)![1]).toBe(expectedDigest);
  });

  it("signs the SignedInfo exactly as emitted, verifiable with the cert's public key", () => {
    const signedInfo = envelope.match(/<ds:SignedInfo[\s\S]*?<\/ds:SignedInfo>/);
    const value = envelope.match(/<ds:SignatureValue>([^<]+)<\/ds:SignatureValue>/);
    const certMatch = envelope.match(/<wsse:BinarySecurityToken[^>]*>([^<]+)</);
    expect(signedInfo && value && certMatch).toBeTruthy();
    const certificate = forge.pki.certificateFromAsn1(forge.asn1.fromDer(forge.util.decode64(certMatch![1]!)));
    const md = forge.md.sha256.create();
    md.update(signedInfo![0], "utf8");
    expect((certificate.publicKey as forge.pki.rsa.PublicKey).verify(md.digest().bytes(), forge.util.decode64(value![1]!))).toBe(true);
  });

  it("escapes XML in parameters", () => {
    const env = buildSecuredEnvelope({
      operation: "GetStatus",
      params: { trackId: "a<b&c" },
      action: "x",
      to: "https://e",
      cert: generateTestCertP12(),
    });
    expect(env).toContain("<wcf:trackId>a&lt;b&amp;c</wcf:trackId>");
  });
});

describe("parseSoapFault", () => {
  it("extracts subcode and reason from a DIAN security fault", () => {
    const fault = `<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope" xmlns:a="http://www.w3.org/2005/08/addressing"><s:Header><a:Action s:mustUnderstand="1">http://www.w3.org/2005/08/addressing/soap/fault</a:Action></s:Header><s:Body><s:Fault><s:Code><s:Value>s:Sender</s:Value><s:Subcode><s:Value xmlns:a="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd">a:InvalidSecurity</s:Value></s:Subcode></s:Code><s:Reason><s:Text xml:lang="en-US">An error occurred when verifying security for the message.</s:Text></s:Reason></s:Fault></s:Body></s:Envelope>`;
    expect(parseSoapFault(fault)).toBe("InvalidSecurity: An error occurred when verifying security for the message.");
  });
  it("returns null for a non-fault response", () => {
    expect(parseSoapFault(`<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope"><s:Body><SendBillSyncResponse/></s:Body></s:Envelope>`)).toBeNull();
  });
});
