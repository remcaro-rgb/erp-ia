import { createHash } from "node:crypto";
import { defineProcess, ProcessError, secretStore, type ProcessContext } from "@erp/kernel";
import { z } from "zod";
import { softwarePinSecret } from "../einvoice-secrets";
import { FEATURE_SETTINGS, packOf, refuseState, requireCompanyAdmin } from "./common";

// The secrets of electronic invoicing (plan 2B Task 19; rule 12; Task 5 ruling): the company's signing certificate (.p12 and its password)
// and the PIN of the software registered with the DIAN. They live ONLY in the secret store (Supabase Vault in production: infra
// VaultSecretStore over migration 0099's wrappers; the app installs it when the service role is configured): never a column, an audit
// input, an outbox payload, a log line or an answer. The settings keep what the certificate says of itself (subject, NIT, issuer, serial,
// validity) and when each secret was stored. Both processes are STEP-UP and run from the Parámetros screen only (origins: the file and the
// PIN never pass through the assistant, which gets no tool for them).
// Every check runs before anything is stored: a refusal stores nothing. The certificate then goes to the secret store FIRST (its own
// connection, outside the process transaction) and its metadata after, with the SHA-256 of the value stored (Task 19 fix rounds 1 and 2, ruling on
// deviation 3). The window: a run that fails after the secret write (the metadata update, the audit, the commit) leaves the new
// certificate stored under the previous metadata; invoicing.settings.consult compares the fingerprint with the stored certificate and
// answers certificate_status 'mismatch', and the page asks to upload it again. A secret write that fails stores no metadata.

export const ADMIN_ONLY = "Solo el administrador de la empresa cambia los parámetros de facturación";
const SECRET_STORE_MISSING = "El servidor no tiene configurado el almacén de secretos (Supabase Vault): el certificado y el PIN no se pueden guardar";
/** A PKCS#12 bigger than this is not a signing certificate. */
const MAX_P12_BYTES = 64 * 1024;

function store(): NonNullable<ReturnType<typeof secretStore>> {
  const secrets = secretStore();
  if (!secrets) refuseState("secret_store_not_configured", [SECRET_STORE_MISSING]);
  return secrets;
}

function invalid(message: string, path: string): never {
  throw new ProcessError("invalid_input", message, { details: [{ path: [path], message }] });
}

async function companyTaxId(ctx: ProcessContext): Promise<string> {
  const [company] = await ctx.tx<{ tax_id: string | null }[]>`select tax_id from kernel.companies where id = ${ctx.companyId}`;
  if (!company?.tax_id) refuseState("issuer_tax_id_missing", ["La empresa no tiene su NIT registrado: regístralo antes de subir el certificado"]);
  return company.tax_id;
}

/** The SHA-256 (hex) of a stored secret value (the store's own `fingerprint` when it has one): what the settings' metadata describes. */
export function secretValueFingerprint(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export const CERTIFICATE_STATUSES = ["ok", "mismatch", "missing", "unverified", "unknown", "unreadable"] as const;
export type CertificateStatus = (typeof CERTIFICATE_STATUSES)[number];

/**
 * Whether the certificate in the secret store is the one the settings describe: 'ok'; 'mismatch' (another certificate is stored: a run
 * failed after its secret write, or the store was changed outside the app); 'missing' (none stored); 'unverified' (uploaded before the
 * fingerprint existed, migration 0103); 'unknown' (no secret store installed); 'unreadable' (the store failed to answer: the error text is dropped, a store's error can carry a connection string, and nothing is logged with it). Vault hashes the secret in the database (fix round 2: the
 * consult never reads the certificate back); another store's value is hashed here. Never answers the value.
 */
export async function certificateStatus(ctx: ProcessContext, fingerprint: string | null): Promise<CertificateStatus> {
  const secrets = secretStore();
  if (!secrets) return "unknown";
  const name = `dian/${ctx.companyId}/certificate`;
  let stored: string | null;
  try {
    if (secrets.fingerprint) stored = await secrets.fingerprint(name);
    else {
      const body = await secrets.get(name);
      stored = body === null ? null : secretValueFingerprint(body);
    }
  } catch {
    // Task 37 (R37-6): a failed read is not a mismatch and not a 500; the error is dropped on purpose (rule 12).
    return "unreadable";
  }
  if (!stored) return "missing";
  if (!fingerprint) return "unverified";
  return stored === fingerprint ? "ok" : "mismatch";
}

const certificateOutput = z.object({
  subjectName: z.string(),
  subjectTaxId: z.string(),
  issuer: z.string(),
  serialNumber: z.string(),
  validFrom: z.string(),
  validTo: z.string(),
  uploadedAt: z.string().nullable(),
});

export const certificateUpload = defineProcess({
  id: "invoicing.certificate.upload",
  module: "invoicing",
  kind: "update",
  recordAccess: "none",
  feature: FEATURE_SETTINGS,
  sensitivity: "step-up",
  origins: ["ui"],
  description:
    "Sube el certificado de firma digital (.p12) de la empresa y su contraseña: se valida (formato, contraseña, vigencia y que sea del NIT de la empresa) y se guarda solo en el almacén de secretos; la pantalla muestra su titular, serial y vencimiento, nunca su contenido",
  input: z.object({
    /** The .p12 file, base64. */
    file: z.string().min(1).max(Math.ceil((MAX_P12_BYTES * 4) / 3) + 4),
    password: z.string().min(1).max(200),
  }).strict(),
  // What was uploaded, never the file or its password (rule 12).
  auditInput: (input) => ({ file: `[.p12, ${Math.floor((input.file.length * 3) / 4)} bytes]`, password: "[secreto]" }),
  output: certificateOutput,
  handler: async (ctx, input) => {
    await requireCompanyAdmin(ctx, ADMIN_ONLY);
    const secrets = store();
    const file = Buffer.from(input.file, "base64");
    if (file.length === 0 || file.length > MAX_P12_BYTES) invalid("El archivo no es un certificado de firma .p12 (PKCS#12)", "file");
    const { einvoice } = await packOf(ctx);
    let meta: ReturnType<typeof einvoice.inspectCertificate>;
    try {
      meta = einvoice.inspectCertificate(file, input.password);
    } catch (error) {
      return invalid(error instanceof Error ? error.message : "El archivo no es un certificado de firma .p12 (PKCS#12)", "file");
    }
    const day = (d: Date) => d.toISOString().slice(0, 10);
    if (!meta.isValid) {
      invalid(meta.validTo.getTime() < Date.now()
        ? `El certificado está vencido (venció el ${day(meta.validTo)}): sube el certificado vigente`
        : `El certificado aún no está vigente (lo estará desde el ${day(meta.validFrom)})`, "file");
    }
    const taxId = await companyTaxId(ctx);
    if (!einvoice.certificateHolds(meta.subjectTaxId, taxId)) {
      invalid(`certificate_nit_mismatch: El certificado es del NIT ${meta.subjectTaxId || "(sin NIT)"}, no del NIT de la empresa (${taxId})`, "file");
    }
    // First the secret store (a dry run stores nothing), then the metadata that describes it, with the fingerprint of what was stored.
    const stored = ctx.dryRun ? null : await einvoice.storeCertificate(secrets, ctx.companyId, file, input.password);
    const [row] = await ctx.tx<{ certificate_uploaded_at: Date }[]>`
      insert into invoicing.settings ${ctx.tx({
        company_id: ctx.companyId, certificate_subject: meta.subjectName, certificate_tax_id: meta.subjectTaxId, certificate_issuer: meta.issuer,
        certificate_serial: meta.serialNumber, certificate_valid_from: meta.validFrom, certificate_valid_to: meta.validTo, certificate_uploaded_at: new Date(),
        certificate_fingerprint: stored?.fingerprint ?? null,
      } as never)}
      on conflict (company_id) do update set certificate_subject = excluded.certificate_subject, certificate_tax_id = excluded.certificate_tax_id,
        certificate_issuer = excluded.certificate_issuer, certificate_serial = excluded.certificate_serial,
        certificate_valid_from = excluded.certificate_valid_from, certificate_valid_to = excluded.certificate_valid_to,
        certificate_uploaded_at = excluded.certificate_uploaded_at, certificate_fingerprint = excluded.certificate_fingerprint
      returning certificate_uploaded_at`;
    return {
      subjectName: meta.subjectName, subjectTaxId: meta.subjectTaxId, issuer: meta.issuer, serialNumber: meta.serialNumber,
      validFrom: meta.validFrom.toISOString(), validTo: meta.validTo.toISOString(), uploadedAt: row?.certificate_uploaded_at ? new Date(row.certificate_uploaded_at).toISOString() : null,
    };
  },
});

export const softwarePinSet = defineProcess({
  id: "invoicing.software_pin.set",
  module: "invoicing",
  kind: "update",
  recordAccess: "none",
  feature: FEATURE_SETTINGS,
  sensitivity: "step-up",
  origins: ["ui"],
  description:
    "Guarda el PIN del software de facturación electrónica registrado ante la DIAN: solo en el almacén de secretos; la pantalla dice cuándo se guardó, nunca cuál es",
  input: z.object({ pin: z.string().trim().min(1, "Escribe el PIN del software").max(100) }).strict(),
  auditInput: () => ({ pin: "[secreto]" }),
  output: z.object({ pinSetAt: z.string() }),
  handler: async (ctx, input) => {
    await requireCompanyAdmin(ctx, ADMIN_ONLY);
    const secrets = store();
    const [row] = await ctx.tx<{ software_pin_set_at: Date }[]>`
      insert into invoicing.settings ${ctx.tx({ company_id: ctx.companyId, software_pin_set_at: new Date() } as never)}
      on conflict (company_id) do update set software_pin_set_at = excluded.software_pin_set_at
      returning software_pin_set_at`;
    if (!ctx.dryRun) await secrets.set(softwarePinSecret(ctx.companyId), input.pin);
    return { pinSetAt: new Date(row!.software_pin_set_at).toISOString() };
  },
});

export const PARAMETROS_PROCESSES = [certificateUpload, softwarePinSet];
