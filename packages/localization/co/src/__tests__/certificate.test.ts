import { beforeAll, describe, expect, it } from "vitest";
import forge from "node-forge";
import { InMemorySecretStore } from "@erp/infra";
import { createHash } from "node:crypto";
import { buildP12, CertificateNotConfiguredError, deleteCertificate, inspectCertificate, loadCertificate, parseCertificate, saveCertificate } from "../einvoice/certificate";
import { generateKeyAndCert, generateTestCertP12 } from "./helpers/test-cert";

function openP12(bytes: Uint8Array, password: string) {
  const p12 = forge.pkcs12.pkcs12FromAsn1(forge.asn1.fromDer(forge.util.createBuffer(Buffer.from(bytes).toString("binary"))), password);
  let key: unknown = null;
  let certificate: forge.pki.Certificate | null = null;
  for (const sc of p12.safeContents) for (const bag of sc.safeBags) {
    if (bag.type === forge.pki.oids.pkcs8ShroudedKeyBag && bag.key) key = bag.key;
    else if (bag.type === forge.pki.oids.certBag && bag.cert) certificate = bag.cert;
  }
  return { key, certificate };
}

describe("buildP12 (.crt conversion, ported from Serena cert-convert)", () => {
  let cert: forge.pki.Certificate;
  let keyPem: string;
  let certPem: string;
  beforeAll(() => {
    const k = generateKeyAndCert();
    cert = k.cert;
    certPem = forge.pki.certificateToPem(cert);
    keyPem = forge.pki.privateKeyToPem(k.keys.privateKey);
  }, 60_000);

  it("builds a .p12 from PEM cert + key", () => {
    const { key, certificate } = openP12(buildP12(certPem, keyPem, "secret1"), "secret1");
    expect(key).not.toBeNull();
    expect(certificate?.subject.getField("CN")?.value).toBe("convert-test");
  });
  it("accepts DER (.crt) certificates", () => {
    const der = forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes();
    expect(openP12(buildP12(der, keyPem, "secret2"), "secret2").certificate).not.toBeNull();
  });
  it("finds the key when concatenated in the same PEM file", () => {
    expect(openP12(buildP12(certPem + "\n" + keyPem, null, "secret3"), "secret3").key).not.toBeNull();
  });
  it("rejects a certificate without a key", () => {
    expect(() => buildP12(certPem, null, "x")).toThrow(/llave privada/);
  });
  it("rejects a mismatched key", () => {
    const other = forge.pki.rsa.generateKeyPair(2048);
    expect(() => buildP12(certPem, forge.pki.privateKeyToPem(other.privateKey), "x")).toThrow(/no corresponde/);
  });
});

describe("certificate storage through the secrets seam (rule 12)", () => {
  let p12: { buffer: Buffer; password: string };
  beforeAll(() => {
    p12 = generateTestCertP12();
  }, 60_000);

  it("saves the .p12 and its password as ONE secret (one write: never a new file with an old password) and loads them back", async () => {
    const secrets = new InMemorySecretStore();
    await secrets.set("dian/co-1/certificate-password", "una-clave-vieja");
    const info = await saveCertificate(secrets, "co-1", p12.buffer, p12.password);
    expect(info.subjectName).toContain("Test DIAN Cert");
    const stored = (await secrets.get("dian/co-1/certificate"))!;
    // The fingerprint is the SHA-256 of the stored value: what the Parámetros keep to tell it from another (Task 19 fix round 2).
    expect(info.fingerprint).toBe(createHash("sha256").update(stored, "utf8").digest("hex"));
    expect(await secrets.get("dian/co-1/certificate-password")).toBeNull();
    const loaded = await loadCertificate(secrets, "co-1");
    expect(loaded.password).toBe(p12.password);
    expect(Buffer.compare(loaded.buffer, p12.buffer)).toBe(0);
  });

  it("refuses to store a certificate that does not open with the password, or is expired", async () => {
    const secrets = new InMemorySecretStore();
    await expect(saveCertificate(secrets, "co-1", p12.buffer, "bad")).rejects.toThrow();
    expect(await secrets.get("dian/co-1/certificate")).toBeNull();
    const expired = generateTestCertP12({ days: -1 });
    await expect(saveCertificate(secrets, "co-1", expired.buffer, expired.password)).rejects.toThrow(/vencido|expired/i);
  });

  it("keeps companies apart and reports 'credentials not configured' when there is none", async () => {
    const secrets = new InMemorySecretStore();
    await saveCertificate(secrets, "co-1", p12.buffer, p12.password);
    await expect(loadCertificate(secrets, "co-2")).rejects.toBeInstanceOf(CertificateNotConfiguredError);
    await expect(loadCertificate(secrets, "co-2")).rejects.toThrow(/credentials not configured/i);
  });

  it("a certificate stored as two secrets (before fix round 2) still loads", async () => {
    const secrets = new InMemorySecretStore();
    await secrets.set("dian/co-1/certificate", p12.buffer.toString("base64"));
    await secrets.set("dian/co-1/certificate-password", p12.password);
    const loaded = await loadCertificate(secrets, "co-1");
    expect(loaded.password).toBe(p12.password);
    expect(Buffer.compare(loaded.buffer, p12.buffer)).toBe(0);
  });

  it("a PKCS#12 that asks for more key-derivation iterations than any signing certificate is refused before it is opened", () => {
    const asn1 = forge.asn1.fromDer(forge.util.createBuffer(p12.buffer.toString("binary")));
    const macData = (asn1.value as forge.asn1.Asn1[])[2]!;
    (macData.value as forge.asn1.Asn1[])[2]!.value = forge.asn1.integerToDer(50_000_000).getBytes();
    const tampered = Buffer.from(forge.asn1.toDer(asn1).getBytes(), "binary");
    const started = Date.now();
    expect(() => inspectCertificate(tampered, p12.password)).toThrow(/iteraciones/);
    expect(() => parseCertificate(tampered, p12.password)).toThrow(/iteraciones/);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("loadCertificate reports an expired stored certificate clearly", async () => {
    const secrets = new InMemorySecretStore();
    const expired = generateTestCertP12({ days: -1 });
    await secrets.set("dian/co-1/certificate", expired.buffer.toString("base64"));
    await secrets.set("dian/co-1/certificate-password", expired.password);
    await expect(loadCertificate(secrets, "co-1")).rejects.toThrow(/expired/i);
  });

  it("deleteCertificate removes both secrets", async () => {
    const secrets = new InMemorySecretStore();
    await saveCertificate(secrets, "co-1", p12.buffer, p12.password);
    await deleteCertificate(secrets, "co-1");
    await expect(loadCertificate(secrets, "co-1")).rejects.toBeInstanceOf(CertificateNotConfiguredError);
  });

  it("parseCertificate is re-exported for validation at upload", () => {
    expect(parseCertificate(p12.buffer, p12.password).isValid).toBe(true);
  });
});
