import { createHash } from "node:crypto";
import forge from "node-forge";
import type { SecretStore } from "@erp/infra";

// Certificates: parsing a PKCS#12, converting a PEM/DER .crt + key into one (ported from Serena cert-convert.ts and signer.ts),
// and storage through the secrets seam (`SecretStore`, backed by Supabase Vault in production; rule 12). The certificate and
// its password are ONE secret per company (Task 19 fix round 2: one write, so a new file never meets an old password), never table
// columns or files; a store of before (two secrets) still loads.

export interface SoapCertificate {
  buffer: Buffer;
  password: string;
}

export interface CertificateInfo {
  isValid: boolean;
  subjectNit: string;
  subjectName: string;
  issuer: string;
  validFrom: Date;
  validTo: Date;
  serialNumber: string;
  expiresInDays: number;
  /** The certificate as PEM (public part only). */
  pem: string;
}

export class CertificateNotConfiguredError extends Error {
  constructor(readonly companyId: string) {
    super(`DIAN credentials not configured: no signing certificate is stored for company ${companyId}`);
    this.name = "CertificateNotConfiguredError";
  }
}

/**
 * The most key-derivation iterations a PKCS#12 may ask for (its MAC, its encrypted bags, PBES2's PBKDF2). Signing certificates use a few
 * thousand (OpenSSL and Windows: 2048 or 2000); a file asking for millions would hold the server for minutes before its password is even
 * checked (node-forge is pure JavaScript). Task 19 fix round 2.
 */
export const MAX_P12_ITERATIONS = 100_000;
const TOO_MANY_ITERATIONS = "El certificado .p12 pide demasiadas iteraciones para abrirse: expórtalo de nuevo con los valores habituales";

/** The INTEGER of a node, or Infinity when it is wider than 4 bytes (always more than MAX_P12_ITERATIONS). */
function intOf(node: forge.asn1.Asn1 | undefined): number | null {
  if (!node || node.tagClass !== forge.asn1.Class.UNIVERSAL || node.type !== forge.asn1.Type.INTEGER || typeof node.value !== "string") return null;
  return node.value.length > 4 ? Number.POSITIVE_INFINITY : forge.asn1.derToInteger(node.value);
}
const children = (node: forge.asn1.Asn1 | undefined): forge.asn1.Asn1[] => (node && Array.isArray(node.value) ? node.value : []);
const oidOf = (node: forge.asn1.Asn1 | undefined) => (node && node.type === forge.asn1.Type.OID && typeof node.value === "string" ? forge.asn1.derToOid(node.value) : "");
const octets = (node: forge.asn1.Asn1 | undefined): string | null => {
  if (!node) return null;
  if (typeof node.value === "string") return node.value;
  // A constructed OCTET STRING: its parts in order.
  return children(node).map((c) => (typeof c.value === "string" ? c.value : "")).join("");
};

/** The iterations an AlgorithmIdentifier of PKCS#12 PBE or PBES2 (PBKDF2) asks for. */
function algorithmIterations(algorithm: forge.asn1.Asn1 | undefined): number | null {
  const [oid, params] = children(algorithm);
  if (oidOf(oid) === forge.pki.oids.pkcs5PBES2) {
    const [kdf] = children(params);
    return intOf(children(children(kdf)[1])[1]);
  }
  return intOf(children(params)[1]);
}

/** Refuses a PKCS#12 whose MAC or encrypted bags ask for more than MAX_P12_ITERATIONS, before anything derives a key. */
function assertIterations(pfx: forge.asn1.Asn1): void {
  const counts: (number | null)[] = [];
  const [, authSafe, macData] = children(pfx);
  if (macData) counts.push(intOf(children(macData)[2]));
  try {
    const content = octets(children(children(authSafe)[1])[0]);
    const infos = content ? children(forge.asn1.fromDer(forge.util.createBuffer(content))) : [];
    for (const info of infos) {
      const [type, wrapped] = children(info);
      const oid = oidOf(type);
      if (oid === forge.pki.oids.encryptedData) {
        counts.push(algorithmIterations(children(children(children(wrapped)[0])[1])[1]));
      } else if (oid === forge.pki.oids.data) {
        const data = octets(children(wrapped)[0]);
        for (const bag of data ? children(forge.asn1.fromDer(forge.util.createBuffer(data))) : []) {
          const [bagType, bagValue] = children(bag);
          if (oidOf(bagType) === forge.pki.oids.pkcs8ShroudedKeyBag) counts.push(algorithmIterations(children(children(bagValue)[0])[0]));
        }
      }
    }
  } catch {
    // An unexpected layout: node-forge refuses it below.
  }
  if (counts.some((n) => n !== null && n > MAX_P12_ITERATIONS)) throw new Error(TOO_MANY_ITERATIONS);
}

export function extractP12(buffer: Buffer, password: string): { privateKey: forge.pki.rsa.PrivateKey; certificate: forge.pki.Certificate } {
  const asn1 = forge.asn1.fromDer(forge.util.createBuffer(buffer.toString("binary")));
  assertIterations(asn1);
  const p12 = forge.pkcs12.pkcs12FromAsn1(asn1, password);
  let privateKey: forge.pki.rsa.PrivateKey | null = null;
  let certificate: forge.pki.Certificate | null = null;
  for (const safeContent of p12.safeContents) {
    for (const bag of safeContent.safeBags) {
      if (bag.type === forge.pki.oids.pkcs8ShroudedKeyBag && bag.key) privateKey = bag.key as forge.pki.rsa.PrivateKey;
      else if (bag.type === forge.pki.oids.certBag && bag.cert) certificate = bag.cert;
    }
  }
  if (!privateKey || !certificate) throw new Error("Certificate or private key not found in .p12 file");
  return { privateKey, certificate };
}

/** What the Parámetros page shows of an uploaded certificate (plan 2B Task 19): who it names and until when; never the key or the file. */
export interface CertificateMeta {
  subjectName: string;
  /** The tax id the subject names (Colombian signing certificates: its serialNumber attribute). */
  subjectTaxId: string;
  issuer: string;
  serialNumber: string;
  validFrom: Date;
  validTo: Date;
  isValid: boolean;
}

/**
 * Reads a PKCS#12 without storing it, for the upload of Parámetros: a file that is not a PKCS#12, or a password that does not open it, is a
 * user-facing refusal (Spanish copy, the process returns it as is).
 */
export function inspectCertificate(buffer: Uint8Array, password: string): CertificateMeta {
  const bytes = Buffer.from(buffer);
  try {
    forge.asn1.fromDer(forge.util.createBuffer(bytes.toString("binary")));
  } catch {
    throw new Error("El archivo no es un certificado de firma .p12 (PKCS#12)");
  }
  let info: CertificateInfo;
  try {
    info = parseCertificate(bytes, password);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/not found in \.p12/.test(message)) throw new Error("El archivo .p12 no trae el certificado y su llave privada");
    if (message === TOO_MANY_ITERATIONS) throw error;
    throw new Error("La contraseña no abre el certificado .p12 (o el archivo está dañado)");
  }
  return { subjectName: info.subjectName, subjectTaxId: info.subjectNit, issuer: info.issuer, serialNumber: info.serialNumber, validFrom: info.validFrom, validTo: info.validTo, isValid: info.isValid };
}

export function parseCertificate(buffer: Buffer, password: string): CertificateInfo {
  const { certificate } = extractP12(buffer, password);
  const now = new Date();
  const validTo = certificate.validity.notAfter;
  const validFrom = certificate.validity.notBefore;
  return {
    isValid: now >= validFrom && now <= validTo,
    subjectNit: (certificate.subject.getField("serialNumber") ?? certificate.subject.getField({ type: "2.5.4.5" }))?.value || "",
    subjectName: certificate.subject.getField("CN")?.value || "",
    issuer: certificate.issuer.getField("O")?.value || certificate.issuer.getField("CN")?.value || "",
    validFrom,
    validTo,
    serialNumber: certificate.serialNumber,
    expiresInDays: Math.floor((validTo.getTime() - now.getTime()) / 86_400_000),
    pem: forge.pki.certificateToPem(certificate),
  };
}

function parseX509(bytes: string): forge.pki.Certificate {
  if (bytes.includes("-----BEGIN CERTIFICATE-----")) return forge.pki.certificateFromPem(bytes);
  return forge.pki.certificateFromAsn1(forge.asn1.fromDer(forge.util.createBuffer(bytes)));
}

/** An RSA private key from PEM, decrypted with the password when encrypted; a file with certificate + key concatenated also works. */
function parsePrivateKey(pem: string, password: string): forge.pki.rsa.PrivateKey | null {
  const match = pem.match(/-----BEGIN (?:RSA |EC |ENCRYPTED )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |ENCRYPTED )?PRIVATE KEY-----/);
  if (!match) return null;
  const block = match[0];
  if (block.includes("ENCRYPTED PRIVATE KEY") || /Proc-Type: 4,ENCRYPTED/.test(block)) {
    return (forge.pki.decryptRsaPrivateKey(block, password) as forge.pki.rsa.PrivateKey) || null;
  }
  return forge.pki.privateKeyFromPem(block) as forge.pki.rsa.PrivateKey;
}

/** A password-protected PKCS#12 from a PEM/DER certificate and its key. Messages are user-facing (Spanish). */
export function buildP12(certBytes: string, keyPem: string | null, password: string): Uint8Array {
  const certificate = parseX509(certBytes);
  const key = (keyPem ? parsePrivateKey(keyPem, password) : null) ?? parsePrivateKey(certBytes, password);
  if (!key) throw new Error("El archivo .crt no incluye la llave privada. Selecciona también el archivo de llave (.key / .pem).");
  if (key.n.toString(16) !== (certificate.publicKey as forge.pki.rsa.PublicKey).n.toString(16)) {
    throw new Error("La llave privada no corresponde al certificado seleccionado.");
  }
  const der = forge.asn1.toDer(forge.pkcs12.toPkcs12Asn1(key, [certificate], password, { algorithm: "3des" })).getBytes();
  const out = new Uint8Array(der.length);
  for (let i = 0; i < der.length; i++) out[i] = der.charCodeAt(i);
  return out;
}

const certName = (companyId: string) => `dian/${companyId}/certificate`;
const passwordName = (companyId: string) => `dian/${companyId}/certificate-password`;

/** The SHA-256 (hex) of a stored secret value: tells the stored certificate from another without reading it back (Task 19 fix round 2). */
export function secretFingerprint(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/**
 * Validates (opens with the password, not expired) and stores the .p12 and its password as ONE secret (`dian/<company>/certificate`,
 * JSON); the password secret of before is removed. Answers the certificate and the fingerprint of the value stored.
 */
export async function saveCertificate(secrets: SecretStore, companyId: string, p12: Buffer, password: string): Promise<CertificateInfo & { fingerprint: string }> {
  const info = parseCertificate(p12, password);
  if (!info.isValid) throw new Error(`El certificado está vencido o aún no es válido (válido hasta ${info.validTo.toISOString().slice(0, 10)}): certificate expired or not yet valid`);
  const value = JSON.stringify({ p12: p12.toString("base64"), password });
  await secrets.set(certName(companyId), value);
  await Promise.resolve(secrets.delete(passwordName(companyId))).catch(() => undefined);
  return { ...info, fingerprint: secretFingerprint(value) };
}

/** The .p12 and its password as stored: one JSON secret, or (before fix round 2) the file and the password as two. */
async function storedCertificate(secrets: SecretStore, companyId: string): Promise<SoapCertificate | null> {
  const body = await secrets.get(certName(companyId));
  if (!body) return null;
  if (body.startsWith("{")) {
    const parsed = JSON.parse(body) as { p12?: unknown; password?: unknown };
    return typeof parsed.p12 === "string" && typeof parsed.password === "string" ? { buffer: Buffer.from(parsed.p12, "base64"), password: parsed.password } : null;
  }
  const password = await secrets.get(passwordName(companyId));
  return password === null ? null : { buffer: Buffer.from(body, "base64"), password };
}

export async function loadCertificate(secrets: SecretStore, companyId: string): Promise<SoapCertificate> {
  const stored = await storedCertificate(secrets, companyId);
  if (!stored) throw new CertificateNotConfiguredError(companyId);
  const { buffer, password } = stored;
  const info = parseCertificate(buffer, password);
  if (!info.isValid) throw new Error(`The stored DIAN certificate is expired or not yet valid (valid ${info.validFrom.toISOString().slice(0, 10)} to ${info.validTo.toISOString().slice(0, 10)}): upload a new one`);
  return { buffer, password };
}

export async function deleteCertificate(secrets: SecretStore, companyId: string): Promise<void> {
  await secrets.delete(certName(companyId));
  await secrets.delete(passwordName(companyId));
}
