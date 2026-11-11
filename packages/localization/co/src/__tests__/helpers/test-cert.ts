import forge from "node-forge";

// A self-signed certificate generated in memory for tests. Never written to disk, never a real DIAN certificate.
// `subjectNit`: the tax id the subject names (its serialNumber attribute, as Colombian signing certificates carry it); `days` below zero gives
// an expired certificate (Task 19: the upload refuses it).
export function generateTestCertP12(options: { password?: string; serial?: string; cn?: string; days?: number; subjectNit?: string } = {}): { buffer: Buffer; password: string } {
  const password = options.password ?? "testpass123";
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = options.serial ?? "01";
  const days = options.days ?? 365;
  cert.validity.notBefore = new Date(Date.now() - (days < 0 ? (1 - days) * 86400_000 : 3600_000));
  cert.validity.notAfter = new Date(Date.now() + days * 86400_000);
  const attrs = [
    { name: "commonName", value: options.cn ?? "Test DIAN Cert" },
    { name: "organizationName", value: "Test Org" },
    { name: "serialNumber", value: options.subjectNit ?? "900123456" },
  ];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  const p12 = forge.pkcs12.toPkcs12Asn1(keys.privateKey, [cert], password, { algorithm: "3des" });
  return { buffer: Buffer.from(forge.asn1.toDer(p12).getBytes(), "binary"), password };
}

export function generateKeyAndCert(cn = "convert-test") {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = "02";
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date(Date.now() + 86400_000);
  const attrs = [{ name: "commonName", value: cn }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  return { cert, keys };
}
