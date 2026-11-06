import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { InMemorySecretStore, VaultSecretStore } from "@erp/infra";
import { setExportsStore, setSecretStore, type Caller, type Tx } from "@erp/kernel";
import { MemoryFileStore } from "@erp/kernel/testing";
import { pdfText } from "../../../../kernel/src/templates/__tests__/pdf-text";
import { loadCertificate } from "@erp/loc-co/einvoice";
import { generateTestCertP12 } from "../../../../localization/co/src/__tests__/helpers/test-cert";
import { invoicingHarness, type Harness, type InvoiceOut } from "./helpers";

// The Parámetros of electronic invoicing (plan 2B Task 19; rule 12; Tasks 5/17/18 carry-overs), through their processes:
//   - core.document_sequence.register (STEP-UP, core owns the numbering: rule 3): the DIAN resolution of invoices (prefix, range, validity,
//     technical key) in the shape Task 3 validates; the numbering rows of credit and debit notes (no resolution, Task 18); never rewinds;
//   - invoicing.settings.update (STEP-UP): the creation mode, the DIAN environment and the explicit confirmation of the DIAN defaults that
//     gates the switch to producción (CreditNoteTypeCode 91, CustomizationID 10 for exports, no InvoiceControl on notes: Task 18), and the
//     production guard (the mock or habilitación never serve a company in producción);
//   - invoicing.certificate.upload and invoicing.software_pin.set (STEP-UP, screen only): the PKCS#12 validated (format, password, expiry,
//     the NIT it names vs the company's) and kept ONLY in the secret store (Supabase Vault in production), its metadata on the settings; the
//     PIN likewise; neither is ever returned, audited or logged;
//   - the bulk «Reintentar todos» (invoicing.invoice.resubmit_failed) also sweeps the invoices that waited for the software (not_configured).

let h: Harness;
let secrets: InMemorySecretStore;
const NIT = "900373115";
let cert: { buffer: Buffer; password: string };

const settings = async () => (await h.sql<Record<string, unknown>[]>`select * from invoicing.settings where company_id = ${h.companyId}`)[0]!;

beforeAll(async () => {
  h = await invoicingHarness();
  await h.sql`update kernel.companies set tax_id = ${NIT} where id = ${h.companyId}`;
  secrets = new InMemorySecretStore();
  setSecretStore(secrets);
  cert = generateTestCertP12({ subjectNit: NIT, serial: "5a7e", cn: "CAFE DEL NORTE S.A.S." });
}, 300_000);

afterAll(async () => {
  setSecretStore(undefined);
  delete process.env.EINVOICE_TRANSPORT;
  await h.sql`delete from vault.secrets where name like ${`dian/${h.companyId}/%`}`;
  await h.cleanup();
});

describe("core.document_sequence.register: the DIAN resolution and the notes' numbering", () => {
  const resolution = (overrides: Record<string, unknown> = {}) => ({ number: "18760000002", from: 990000000, to: 990009999, validFrom: `${h.year}-01-01`, validTo: `${h.year + 1}-12-31`, technicalKey: "tk-renovada-0001", ...overrides });

  it("is step-up; renews the invoice resolution of a prefix (Task 3's shape) without rewinding its counter, and the next invoice draws from it", async () => {
    expect(await h.refusal(h.run(h.admin, "core.document_sequence.register", { documentType: "invoice", prefix: "SETP", resolution: resolution() }))).toMatchObject({ code: "step_up_required" });
    const before = (await h.sql<{ next_number: string }[]>`select next_number::text from core.document_sequences where company_id = ${h.companyId} and document_type = 'invoice' and prefix = 'SETP'`)[0]!;
    const out = await h.runStepUp<Record<string, unknown>>("core.document_sequence.register", { documentType: "invoice", prefix: "SETP", resolution: resolution() });
    // The technical key is never answered back (only its last characters).
    expect(out).toMatchObject({ documentType: "invoice", prefix: "SETP", nextNumber: Number(before.next_number), resolution: { number: "18760000002", prefix: "SETP", from: 990000000, to: 990009999 }, technicalKeyEnding: "0001" });
    expect(JSON.stringify(out)).not.toContain("tk-renovada");
    const [row] = await h.sql<{ resolution: Record<string, unknown>; next_number: string }[]>`select resolution, next_number::text from core.document_sequences where company_id = ${h.companyId} and document_type = 'invoice' and prefix = 'SETP'`;
    // The key is kept apart (migration 0104): the row carries its last characters.
    const { technicalKey, ...data } = resolution();
    expect(row!.resolution).toEqual({ ...data, prefix: "SETP", technicalKeyEnding: "0001" });
    const [kept] = await h.sql<{ technical_key: string }[]>`select technical_key from core.document_resolution_keys where company_id = ${h.companyId} and prefix = 'SETP' and resolution_number = '18760000002'`;
    expect(kept!.technical_key).toBe(technicalKey);
    expect(row!.next_number).toBe(before.next_number);
    const draft = await h.run<InvoiceOut>(h.admin, "invoicing.invoice.create", { partyId: h.partyId, lines: [{ productId: h.servicio, qty: 1 }] });
    const issued = await h.run<InvoiceOut>(h.admin, "invoicing.invoice.issue", { id: draft.id });
    expect(issued.number).toBe(`SETP${before.next_number}`);
    const [frozen] = await h.sql<{ resolution: { number: string } }[]>`select resolution from invoicing.invoices where id = ${draft.id}`;
    expect(frozen!.resolution.number).toBe("18760000002");
    expect(await h.drain()).toEqual([]);
    // A lower next number never rewinds the counter (that number is printed on the invoice just issued).
    expect(await h.refusal(h.runStepUp("core.document_sequence.register", { documentType: "invoice", prefix: "SETP", nextNumber: Number(before.next_number), resolution: resolution() }))).toMatchObject({ code: "invalid_input", message: expect.stringMatching(/retroceder/) });
    const [after] = await h.sql<{ next_number: string }[]>`select next_number::text from core.document_sequences where company_id = ${h.companyId} and document_type = 'invoice' and prefix = 'SETP'`;
    expect(Number(after!.next_number)).toBe(Number(before.next_number) + 1);
  });

  it("an invoice needs its resolution; a range or a validity that does not add up is refused; a note's row needs none", async () => {
    expect(await h.refusal(h.runStepUp("core.document_sequence.register", { documentType: "invoice", prefix: "FV" }))).toMatchObject({ code: "invalid_input" });
    expect(await h.refusal(h.runStepUp("core.document_sequence.register", { documentType: "invoice", prefix: "FV", resolution: resolution({ from: 10, to: 5 }) }))).toMatchObject({ code: "invalid_input" });
    expect(await h.refusal(h.runStepUp("core.document_sequence.register", { documentType: "invoice", prefix: "FV", resolution: resolution({ validFrom: "2026-02-30" }) }))).toMatchObject({ code: "invalid_input" });
    expect(await h.refusal(h.runStepUp("core.document_sequence.register", { documentType: "invoice", prefix: "FV", resolution: resolution({ validTo: `${h.year - 1}-01-01` }) }))).toMatchObject({ code: "invalid_input" });
    const credit = await h.runStepUp<Record<string, unknown>>("core.document_sequence.register", { documentType: "credit_note", prefix: "NC", nextNumber: 1 });
    expect(credit).toMatchObject({ documentType: "credit_note", prefix: "NC", nextNumber: 1, resolution: null });
    await h.runStepUp("core.document_sequence.register", { documentType: "debit_note", prefix: "ND" });
    const rows = await h.sql<{ document_type: string; prefix: string; resolution: unknown }[]>`
      select document_type, prefix, resolution from core.document_sequences where company_id = ${h.companyId} and document_type in ('credit_note', 'debit_note') order by document_type`;
    expect(rows).toEqual([{ document_type: "credit_note", prefix: "NC", resolution: null }, { document_type: "debit_note", prefix: "ND", resolution: null }]);
  });

  it("only its process writes core.document_sequences: a direct write, or the register function outside the process, is refused to a user", async () => {
    const asUser = (statement: (tx: Tx) => Promise<unknown>) => h.sql.begin(async (tx) => {
      await tx`select set_config('request.jwt.claims', ${JSON.stringify(h.admin.claims)}, true), set_config('role', 'authenticated', true)`;
      await statement(tx);
    });
    await expect(asUser((tx) => tx`update core.document_sequences set next_number = 1 where company_id = ${h.companyId}`)).rejects.toThrow(/permission denied/);
    await expect(asUser((tx) => tx`insert into core.document_sequences (company_id, document_type, prefix) values (${h.companyId}, 'credit_note', 'X')`)).rejects.toThrow(/permission denied/);
    await expect(asUser((tx) => tx`select core.register_document_sequence(${h.companyId}, 'credit_note', 'X', 1, null)`)).rejects.toThrow(/only inside the process/);
  });
});

describe("the certificate and the software PIN live only in the secret store (rule 12)", () => {
  const upload = (file: Buffer, password: string, caller?: Caller) => h.runStepUp<Record<string, unknown>>("invoicing.certificate.upload", { file: file.toString("base64"), password }, caller);

  it("refuses what is not a .p12, a wrong password, an expired certificate and one of another NIT; stores nothing", async () => {
    expect(await h.refusal(upload(Buffer.from("no es un certificado"), "x"))).toMatchObject({ code: "invalid_input", message: expect.stringMatching(/\.p12/) });
    expect(await h.refusal(upload(cert.buffer, "otra-clave"))).toMatchObject({ code: "invalid_input", message: expect.stringMatching(/contraseña/) });
    const expired = generateTestCertP12({ subjectNit: NIT, days: -2 });
    expect(await h.refusal(upload(expired.buffer, expired.password))).toMatchObject({ code: "invalid_input", message: expect.stringMatching(/vencido/) });
    const other = generateTestCertP12({ subjectNit: "900123456" });
    expect(await h.refusal(upload(other.buffer, other.password))).toMatchObject({ code: "invalid_input", message: expect.stringMatching(/certificate_nit_mismatch/) });
    expect(await secrets.get(`dian/${h.companyId}/certificate`)).toBeNull();
  }, 120_000);

  it("is step-up and runs only from the screen (no assistant tool: the file would reach the model)", async () => {
    expect(await h.refusal(h.run(h.admin, "invoicing.certificate.upload", { file: cert.buffer.toString("base64"), password: cert.password }))).toMatchObject({ code: "step_up_required" });
    expect(await h.refusal(h.runStepUp("invoicing.certificate.upload", { file: cert.buffer.toString("base64"), password: cert.password }, { ...h.admin, origin: "agent" }))).toMatchObject({ code: "forbidden" });
  });

  it("without a secret store installed the upload is refused (nothing falls back to a table or the environment)", async () => {
    setSecretStore(undefined);
    try {
      expect(await h.refusal(upload(cert.buffer, cert.password))).toMatchObject({ code: "invalid_state", message: expect.stringMatching(/secret_store_not_configured/) });
    } finally {
      setSecretStore(secrets);
    }
  });

  it("a valid certificate of the company's NIT is stored in the secret store only; the settings keep its metadata, never its content", async () => {
    const out = await upload(cert.buffer, cert.password);
    expect(out).toMatchObject({ subjectName: "CAFE DEL NORTE S.A.S.", subjectTaxId: NIT, serialNumber: "5a7e", issuer: "Test Org" });
    expect(JSON.stringify(out)).not.toContain(cert.password);
    expect(JSON.stringify(out)).not.toContain(cert.buffer.toString("base64").slice(0, 40));
    const loaded = await loadCertificate(secrets, h.companyId);
    expect(loaded.password).toBe(cert.password);
    expect(loaded.buffer.equals(cert.buffer)).toBe(true);
    const row = await settings();
    expect(row).toMatchObject({ certificate_subject: "CAFE DEL NORTE S.A.S.", certificate_tax_id: NIT, certificate_serial: "5a7e" });
    expect(row.certificate_valid_to).toBeInstanceOf(Date);
    const consult = await h.run<Record<string, unknown>>(h.admin, "invoicing.settings.consult", {});
    expect(consult).toMatchObject({ certificate_subject: "CAFE DEL NORTE S.A.S.", certificate_serial: "5a7e" });
    // Neither the file nor the password reach a table: the audit of the upload records what was uploaded, not the secret.
    const audits = await h.sql<{ input: unknown; diff: unknown }[]>`select input, diff from kernel.audit_log where company_id = ${h.companyId} and process_id = 'invoicing.certificate.upload'`;
    expect(audits.length).toBeGreaterThan(0);
    for (const a of audits) {
      expect(JSON.stringify(a)).not.toContain(cert.password);
      expect(JSON.stringify(a)).not.toContain(cert.buffer.toString("base64").slice(0, 40));
    }
    const leak = await h.sql<{ n: number }[]>`select count(*)::int as n from kernel.outbox where company_id = ${h.companyId} and payload::text like ${`%${cert.password}%`}`;
    expect(leak[0]!.n).toBe(0);
  }, 120_000);

  it("the software PIN is stored in the secret store only (dian/<company>/software-pin); the settings say when, never what", async () => {
    expect(await h.refusal(h.run(h.admin, "invoicing.software_pin.set", { pin: "75315" }))).toMatchObject({ code: "step_up_required" });
    expect(await h.refusal(h.runStepUp("invoicing.software_pin.set", { pin: "" }))).toMatchObject({ code: "invalid_input" });
    const out = await h.runStepUp<Record<string, unknown>>("invoicing.software_pin.set", { pin: "75315" });
    expect(JSON.stringify(out)).not.toContain("75315");
    expect(await secrets.get(`dian/${h.companyId}/software-pin`)).toBe("75315");
    expect((await settings()).software_pin_set_at).toBeInstanceOf(Date);
    const audits = await h.sql<{ input: unknown }[]>`select input from kernel.audit_log where company_id = ${h.companyId} and process_id = 'invoicing.software_pin.set'`;
    for (const a of audits) expect(JSON.stringify(a)).not.toContain("75315");
  });

  it("with the Vault-backed store the certificate goes to Supabase Vault (encrypted), read back only by the service role", async () => {
    const vault = new VaultSecretStore(h.sql);
    setSecretStore(vault);
    try {
      await upload(cert.buffer, cert.password);
      const loaded = await loadCertificate(vault, h.companyId);
      expect(loaded.buffer.equals(cert.buffer)).toBe(true);
      // One secret holds the file and its password (fix round 2), encrypted; the consult hashes it in the database.
      const rows = await h.sql<{ name: string; secret: string }[]>`select name, secret from vault.secrets where name like ${`dian/${h.companyId}/certificate%`}`;
      expect(rows.map((r) => r.name)).toEqual([`dian/${h.companyId}/certificate`]);
      expect(rows[0]!.secret).not.toContain(cert.password);
      expect(await h.run<Record<string, unknown>>(h.admin, "invoicing.settings.consult", {})).toMatchObject({ certificate_status: "ok" });
    } finally {
      setSecretStore(secrets);
    }
  }, 120_000);
});

describe("DIAN environment: the switch to producción is gated (Tasks 17/18 carry)", () => {
  it("is refused while the DIAN defaults are unconfirmed (CreditNoteTypeCode 91, CustomizationID 10, no InvoiceControl on notes)", async () => {
    expect(await h.refusal(h.runStepUp("invoicing.settings.update", { dianEnvironment: "produccion" }))).toMatchObject({ code: "invalid_state", message: expect.stringMatching(/dian_defaults_unconfirmed/) });
    expect((await settings()).dian_environment).toBe("habilitacion");
    // The flag is only the step-up settings update's, and it is false by default.
    expect((await settings()).dian_defaults_confirmed).toBe(false);
    expect(await h.refusal(h.run(h.admin, "invoicing.settings.update", { dianDefaultsConfirmed: true }))).toMatchObject({ code: "step_up_required" });
  });

  it("confirmed, the mock (EINVOICE_TRANSPORT unset) or habilitación still cannot serve producción", async () => {
    await h.runStepUp("invoicing.settings.update", { dianDefaultsConfirmed: true });
    expect((await settings()).dian_defaults_confirmed).toBe(true);
    delete process.env.EINVOICE_TRANSPORT;
    expect(await h.refusal(h.runStepUp("invoicing.settings.update", { dianEnvironment: "produccion" }))).toMatchObject({ code: "invalid_state", message: expect.stringMatching(/einvoice_environment_mismatch/) });
    process.env.EINVOICE_TRANSPORT = "dian-habilitacion";
    expect(await h.refusal(h.runStepUp("invoicing.settings.update", { dianEnvironment: "produccion" }))).toMatchObject({ code: "invalid_state", message: expect.stringMatching(/einvoice_environment_mismatch/) });
    delete process.env.EINVOICE_TRANSPORT;
    expect((await settings()).dian_environment).toBe("habilitacion");
  });

  it("with the defaults confirmed, the production transport configured, the software, the certificate and the PIN: producción; unconfirming it then is refused", async () => {
    await h.runStepUp("invoicing.settings.update", { softwareId: "56f2ae4e-9812-4fad-9255-08fcfcd5ccb0", softwareProviderTaxId: NIT });
    process.env.EINVOICE_TRANSPORT = "dian-produccion";
    try {
      const out = await h.runStepUp<{ dianEnvironment: string; dianDefaultsConfirmed: boolean }>("invoicing.settings.update", { dianEnvironment: "produccion" });
      expect(out).toMatchObject({ dianEnvironment: "produccion", dianDefaultsConfirmed: true });
      expect(await h.refusal(h.runStepUp("invoicing.settings.update", { dianDefaultsConfirmed: false }))).toMatchObject({ code: "invalid_state", message: expect.stringMatching(/dian_defaults_unconfirmed/) });
      // The database holds the rule too.
      await expect(h.sql`update invoicing.settings set dian_defaults_confirmed = false where company_id = ${h.companyId}`).rejects.toThrow(/dian_defaults/);
    } finally {
      delete process.env.EINVOICE_TRANSPORT;
    }
    // Back to habilitación is always allowed.
    await h.runStepUp("invoicing.settings.update", { dianEnvironment: "habilitacion" });
    expect((await settings()).dian_environment).toBe("habilitacion");
  });

  it("the creation mode changes only behind the step-up", async () => {
    expect(await h.refusal(h.run(h.admin, "invoicing.settings.update", { invoiceCreation: "on_delivery" }))).toMatchObject({ code: "step_up_required" });
    await h.runStepUp("invoicing.settings.update", { invoiceCreation: "on_delivery" });
    expect((await settings()).invoice_creation).toBe("on_delivery");
    await h.runStepUp("invoicing.settings.update", { invoiceCreation: "manual" });
  });
});

describe("«Reintentar todos»: the bulk sweep covers the invoices that waited for the software (not_configured)", () => {
  it("an invoice issued before the software was registered is queued again by invoicing.invoice.resubmit_failed once it is", async () => {
    await h.runStepUp("invoicing.settings.update", { softwareId: null });
    const draft = await h.run<InvoiceOut>(h.admin, "invoicing.invoice.create", { partyId: h.partyId, lines: [{ productId: h.servicio, qty: 1 }] });
    await h.run(h.admin, "invoicing.invoice.issue", { id: draft.id });
    expect(await h.drain()).toEqual([]);
    const [waiting] = await h.sql<{ id: string; status: string }[]>`select id, status from invoicing.einvoice_submissions where invoice_id = ${draft.id}`;
    expect(waiting!.status).toBe("not_configured");
    expect(await h.refusal(h.run(h.admin, "invoicing.invoice.resubmit_failed", {}))).toMatchObject({ code: "invalid_state", message: expect.stringMatching(/einvoice_not_configured/) });
    await h.runStepUp("invoicing.settings.update", { softwareId: "56f2ae4e-9812-4fad-9255-08fcfcd5ccb0" });
    const swept = await h.run<{ requeued: { invoiceId: string; submissionId: string }[] }>(h.admin, "invoicing.invoice.resubmit_failed", { only: "not_configured" });
    expect(swept.requeued).toContainEqual(expect.objectContaining({ invoiceId: draft.id, submissionId: waiting!.id }));
    const [queued] = await h.sql<{ status: string }[]>`select status from invoicing.einvoice_submissions where id = ${waiting!.id}`;
    expect(queued!.status).toBe("queued");
    // Swept once: a second sweep finds nothing of it.
    const again = await h.run<{ requeued: { invoiceId: string }[] }>(h.admin, "invoicing.invoice.resubmit_failed", {});
    expect(again.requeued.map((r) => r.invoiceId)).not.toContain(draft.id);
  });
});

describe("fix round 1: the DIAN environment frozen at «Emitir»; the technical key out of core.v_document_sequences", () => {
  it("an invoice keeps the environment it was issued in: its PDF prints habilitación's notice after the company moved to producción", async () => {
    await h.runStepUp("invoicing.settings.update", { softwareId: null });
    const draft = await h.run<InvoiceOut>(h.admin, "invoicing.invoice.create", { partyId: h.partyId, lines: [{ productId: h.servicio, qty: 1 }] });
    await h.run(h.admin, "invoicing.invoice.issue", { id: draft.id });
    const [row] = await h.sql<{ dian_environment: string }[]>`select dian_environment from invoicing.invoices where id = ${draft.id}`;
    expect(row!.dian_environment).toBe("habilitacion");
    await expect(h.sql`update invoicing.invoices set dian_environment = 'produccion' where id = ${draft.id}`).rejects.toThrow(/emitida no cambia/);
    const exportsStore = new MemoryFileStore();
    setExportsStore(exportsStore);
    await h.sql`update invoicing.settings set software_id = coalesce(software_id, '56f2ae4e-9812-4fad-9255-08fcfcd5ccb0'), certificate_uploaded_at = coalesce(certificate_uploaded_at, now()), software_pin_set_at = coalesce(software_pin_set_at, now()), dian_defaults_confirmed = true, dian_environment = 'produccion' where company_id = ${h.companyId}`;
    try {
      const { fileId } = await h.run<{ fileId: string }>(h.admin, "kernel.doc_template.print", { entity: "invoicing.invoice", recordId: draft.id });
      const text = pdfText(Buffer.from(await exportsStore.get(`${h.companyId}/${fileId}.pdf`)));
      // The test registers no catalogue: the notice prints as its key (habilitación's, not producción's pending one).
      expect(text).toContain("invoicing.print.test_notice");
      expect(text).not.toContain("invoicing.print.pending_notice");
    } finally {
      await h.sql`update invoicing.settings set dian_environment = 'habilitacion', software_id = null where company_id = ${h.companyId}`;
      setExportsStore(undefined);
    }
  });

  it("a user reads the resolution through core.v_document_sequences without its technical key (its last 4 characters only); the key itself only inside a process run", async () => {
    const asUser = <T>(statement: (tx: Tx) => Promise<T>) => h.sql.begin(async (tx) => {
      await tx`select set_config('request.jwt.claims', ${JSON.stringify(h.admin.claims)}, true), set_config('role', 'authenticated', true)`;
      return statement(tx);
    });
    const rows = await asUser((tx) => tx<{ resolution: Record<string, unknown> }[]>`select resolution from core.v_document_sequences where document_type = 'invoice'`);
    expect(rows.length).toBeGreaterThan(0);
    const [stored] = await h.sql<{ key: string }[]>`select resolution->>'technicalKey' as key from core.document_sequences where company_id = ${h.companyId} and document_type = 'invoice' limit 1`;
    for (const r of rows) {
      expect(r.resolution).not.toHaveProperty("technicalKey");
      expect(r.resolution.technicalKeyEnding).toHaveLength(4);
    }
    expect(JSON.stringify(rows)).not.toContain(stored!.key);
    await expect(asUser((tx) => tx`select core.document_technical_key(${h.companyId}, 'invoice', 'SETP', '18760000002')`)).rejects.toThrow(/inside a process run/);
  });
});

describe("fix round 1: the certificate's secret is written before its metadata, and the consult reconciles them", () => {
  const upload = (file: Buffer, password: string) => h.runStepUp<Record<string, unknown>>("invoicing.certificate.upload", { file: file.toString("base64"), password });
  const status = async () => (await h.run<Record<string, unknown>>(h.admin, "invoicing.settings.consult", {})).certificate_status;
  const sha256 = (b: Buffer) => createHash("sha256").update(b).digest("hex");

  it("the settings keep the SHA-256 of the stored certificate; the consult answers certificate_status ok", async () => {
    await upload(cert.buffer, cert.password);
    // The fingerprint of the value stored (fix round 2: the file and its password as one secret).
    expect((await settings()).certificate_fingerprint).toBe(sha256(Buffer.from((await secrets.get(`dian/${h.companyId}/certificate`))!, "utf8")));
    expect(await status()).toBe("ok");
  }, 120_000);

  it("a secret store that fails leaves the metadata as it was (the secret goes first: nothing after it ran)", async () => {
    const before = await settings();
    const failing = { get: secrets.get.bind(secrets), delete: secrets.delete.bind(secrets), set: async () => { throw new Error("vault caído"); } };
    setSecretStore(failing);
    const other = generateTestCertP12({ subjectNit: NIT, serial: "77aa", cn: "CAFE DEL NORTE S.A.S." });
    try {
      await expect(upload(other.buffer, other.password)).rejects.toThrow();
    } finally {
      setSecretStore(secrets);
    }
    const after = await settings();
    expect(after.certificate_serial).toBe(before.certificate_serial);
    expect(after.certificate_fingerprint).toBe(before.certificate_fingerprint);
    expect(await status()).toBe("ok");
  }, 120_000);

  it("a stored certificate that is not the one the metadata describes (a run that failed after the secret write) is flagged mismatch; none stored, missing", async () => {
    const other = generateTestCertP12({ subjectNit: NIT, serial: "88bb", cn: "CAFE DEL NORTE S.A.S." });
    await secrets.set(`dian/${h.companyId}/certificate`, other.buffer.toString("base64"));
    expect(await status()).toBe("mismatch");
    // The consult answers the status, never the certificate.
    const consult = await h.run<Record<string, unknown>>(h.admin, "invoicing.settings.consult", {});
    expect(JSON.stringify(consult)).not.toContain(other.buffer.toString("base64").slice(0, 40));
    await secrets.delete(`dian/${h.companyId}/certificate`);
    expect(await status()).toBe("missing");
    await upload(cert.buffer, cert.password);
    expect(await status()).toBe("ok");
  }, 120_000);
});

describe("fix round 2: the technical key reaches no reader; the Parámetros are the company admin's only", () => {
  const KEY = "tk-ronda2-secreta-9f3c";
  const asUser = <T>(caller: Caller, statement: (tx: Tx) => Promise<T>) => h.sql.begin(async (tx) => {
    await tx`select set_config('request.jwt.claims', ${JSON.stringify(caller.claims)}, true), set_config('role', 'authenticated', true)`;
    return statement(tx);
  });

  it("after a register, the key is in no audit row, no base table and no view a user reads; the process is screen-only", async () => {
    const resolution = { number: "18760000077", from: 980000000, to: 980009999, validFrom: `${h.year}-01-01`, validTo: `${h.year + 1}-12-31`, technicalKey: KEY };
    expect(await h.refusal(h.runStepUp("core.document_sequence.register", { documentType: "invoice", prefix: "RND2", resolution }, { ...h.admin, origin: "agent" }))).toMatchObject({ code: "forbidden" });
    const out = await h.runStepUp<Record<string, unknown>>("core.document_sequence.register", { documentType: "invoice", prefix: "RND2", resolution });
    expect(out).toMatchObject({ technicalKeyEnding: "9f3c" });
    // Nowhere in the database a user reads (the service connection sees every audit row, process and row-change alike).
    const audits = await h.sql<{ input: unknown; diff: unknown }[]>`select input, diff from kernel.audit_log where company_id = ${h.companyId}`;
    expect(audits.length).toBeGreaterThan(0);
    expect(JSON.stringify(audits)).not.toContain(KEY);
    const read = await asUser(h.admin, async (tx) => ({
      audit: await tx`select * from kernel.audit_log`,
      view: await tx`select * from kernel.v_audit_log`,
      table: await tx`select * from core.document_sequences`,
      sequences: await tx`select * from core.v_document_sequences`,
    }));
    expect(read.audit.length).toBeGreaterThan(0);
    expect(JSON.stringify(read)).not.toContain(KEY);
    await expect(asUser(h.admin, (tx) => tx`select * from core.document_resolution_keys`)).rejects.toThrow(/permission denied/);
    // An audit row written before this round (the key in its diff) is no longer readable by a user.
    await h.sql`insert into kernel.audit_log (company_id, origin, process_id, entity, row_id, action, chain_id, diff)
      values (${h.companyId}, 'ui', 'core.document_sequence.register', 'core.document_sequence', ${out.id as string}, 'update', ${"00000000-0000-7000-8000-0000000000aa"}, ${h.sql.json({ resolution: { technicalKey: KEY } })})`;
    expect(JSON.stringify(await asUser(h.admin, (tx) => tx`select * from kernel.audit_log`))).not.toContain(KEY);
  });

  it("a member whose role holds every Parámetros process is refused by each (not only by the page)", async () => {
    const ids = ["invoicing.settings.update", "core.document_sequence.register", "invoicing.certificate.upload", "invoicing.software_pin.set"];
    for (const id of ids) await h.sql`insert into kernel.process_permissions(company_id, role_id, process_id) values (${h.companyId}, ${h.memberRoleId}, ${id}) on conflict do nothing`;
    const inputs: Record<string, unknown> = {
      "invoicing.settings.update": { invoiceCreation: "manual" },
      "core.document_sequence.register": { documentType: "credit_note", prefix: "NCX" },
      "invoicing.certificate.upload": { file: cert.buffer.toString("base64"), password: cert.password },
      "invoicing.software_pin.set": { pin: "11111" },
    };
    for (const id of ids) {
      expect(await h.refusal(h.runStepUp(id, inputs[id], h.member)), id).toMatchObject({ code: "forbidden" });
    }
  }, 120_000);

  it("producción also needs a current certificate that is the one stored; the database holds the whole guard", async () => {
    await h.runStepUp("invoicing.settings.update", { softwareId: "56f2ae4e-9812-4fad-9255-08fcfcd5ccb0", softwareProviderTaxId: NIT, dianDefaultsConfirmed: true });
    await h.runStepUp("invoicing.software_pin.set", { pin: "75315" });
    await h.runStepUp("invoicing.certificate.upload", { file: cert.buffer.toString("base64"), password: cert.password });
    process.env.EINVOICE_TRANSPORT = "dian-produccion";
    try {
      // Another certificate stored than the one described (status mismatch): refused.
      const other = generateTestCertP12({ subjectNit: NIT, serial: "99cc" });
      const body = await secrets.get(`dian/${h.companyId}/certificate`);
      await secrets.set(`dian/${h.companyId}/certificate`, other.buffer.toString("base64"));
      expect(await h.refusal(h.runStepUp("invoicing.settings.update", { dianEnvironment: "produccion" }))).toMatchObject({ code: "invalid_state", message: expect.stringMatching(/certificate_mismatch/) });
      await secrets.set(`dian/${h.companyId}/certificate`, body!);
      // A certificate past its validity: refused.
      const valid_to = (await h.sql<{ valid_to: Date }[]>`select certificate_valid_to as valid_to from invoicing.settings where company_id = ${h.companyId}`)[0]!.valid_to;
      await h.sql`update invoicing.settings set certificate_valid_to = now() - interval '1 day' where company_id = ${h.companyId}`;
      expect(await h.refusal(h.runStepUp("invoicing.settings.update", { dianEnvironment: "produccion" }))).toMatchObject({ code: "invalid_state", message: expect.stringMatching(/certificate_expired/) });
      await h.sql`update invoicing.settings set certificate_valid_to = ${valid_to} where company_id = ${h.companyId}`;
      expect(await h.runStepUp("invoicing.settings.update", { dianEnvironment: "produccion" })).toMatchObject({ dianEnvironment: "produccion" });
      await h.runStepUp("invoicing.settings.update", { dianEnvironment: "habilitacion" });
    } finally {
      delete process.env.EINVOICE_TRANSPORT;
    }
    // The database: producción without the software, the certificate or the PIN is refused, whoever writes it.
    for (const column of ["software_id", "certificate_uploaded_at", "software_pin_set_at"]) {
      await expect(h.sql.begin(async (tx) => {
        await tx`update invoicing.settings set ${tx(column)} = null where company_id = ${h.companyId}`;
        await tx`update invoicing.settings set dian_environment = 'produccion' where company_id = ${h.companyId}`;
      }), column).rejects.toThrow(/settings_production_ready/);
    }
  }, 120_000);
});