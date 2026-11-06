import { beforeAll, describe, expect, it } from "vitest";
import { InMemorySecretStore, MockEInvoiceTransport } from "@erp/infra";
import { createEInvoiceTransport, einvoicePack, loadCertificate } from "../einvoice";
import { certificateHolds, dianQrPayload, resolutionLegend } from "../einvoice/representation";
import { generateTestCertP12 } from "./helpers/test-cert";

// The graphic representation of an electronic document (plan 2B Task 19): the QR the DIAN prescribes and the numbering legend, the
// certificate inspection of the upload in Parámetros, and the transport guard against the company's DIAN environment.

const CUFE = "8bb918b19ba22a694f1da11c643b5e9de39adf60311cf179179e9b33381030bcd4c3c3f156c506ed5908f9276f5bd9b4";

describe("QR payload (Anexo Técnico 1.9: the DIAN's query of the document by its CUFE / CUDE)", () => {
  it("is the URL of the DIAN query with documentkey = the CUFE, on the environment's host", () => {
    // Pinned (Serena src/lib/dian/mock.ts dianQrUrl, the URL the DIAN's catalogue answers): production and habilitación hosts.
    expect(dianQrPayload(CUFE, "produccion")).toBe(`https://catalogo-vpfe.dian.gov.co/document/searchqr?documentkey=${CUFE}`);
    expect(dianQrPayload(CUFE, "habilitacion")).toBe(`https://catalogo-vpfe-hab.dian.gov.co/document/searchqr?documentkey=${CUFE}`);
    expect(einvoicePack.representation.qrPayload(CUFE, "produccion")).toBe(dianQrPayload(CUFE, "produccion"));
  });
  it("refuses what is not a CUFE / CUDE (96 hex digits): a QR never points at another document", () => {
    expect(() => dianQrPayload("abc", "produccion")).toThrow(/CUFE/);
    expect(() => dianQrPayload(`${CUFE}&x=1`, "produccion")).toThrow(/CUFE/);
  });
});

describe("resolution legend", () => {
  const resolution = { number: "18760000001", prefix: "SETP", from: 990000000, to: 990000999, validFrom: "2026-01-01", validTo: "2026-12-31" };
  it("prints the resolution's number, prefix, range and validity (es-419)", () => {
    const legend = resolutionLegend(resolution, "es-419");
    expect(legend).toBe("Resolución DIAN de numeración N.º 18760000001: prefijo SETP, del 990000000 al 990000999, vigente del 2026/01/01 al 2026/12/31");
    expect(einvoicePack.representation.resolutionLegend(resolution, "es-419")).toBe(legend);
  });
  it("in English with the same data", () => {
    expect(resolutionLegend(resolution, "en")).toBe("DIAN numbering resolution No. 18760000001: prefix SETP, from 990000000 to 990000999, valid from 2026/01/01 to 2026/12/31");
  });
  it("a range without prefix says so", () => {
    expect(resolutionLegend({ ...resolution, prefix: "" }, "es-419")).toContain("sin prefijo");
  });
});

describe("certificate inspection (the upload of Parámetros)", () => {
  let p12: { buffer: Buffer; password: string };
  beforeAll(() => {
    p12 = generateTestCertP12({ subjectNit: "900373115", serial: "0a1b2c", cn: "Café del Norte S.A.S." });
  }, 60_000);

  it("answers the holder, its tax id, the issuer, the serial and the validity; never the key", () => {
    const meta = einvoicePack.inspectCertificate(p12.buffer, p12.password);
    expect(meta).toMatchObject({ subjectName: "Café del Norte S.A.S.", subjectTaxId: "900373115", issuer: "Test Org", serialNumber: "0a1b2c", isValid: true });
    expect(meta.validTo > meta.validFrom).toBe(true);
    expect(JSON.stringify(meta)).not.toMatch(/PRIVATE KEY|BEGIN CERTIFICATE/);
  });
  it("a wrong password is a user-facing refusal", () => {
    expect(() => einvoicePack.inspectCertificate(p12.buffer, "otra")).toThrow(/contraseña/);
  });
  it("what is not a PKCS#12 is refused", () => {
    expect(() => einvoicePack.inspectCertificate(Buffer.from("no soy un certificado"), "x")).toThrow(/\.p12/);
  });
  it("the certificate's tax id must be the company's NIT (with or without its check digit)", () => {
    expect(certificateHolds("900373115", "900373115")).toBe(true);
    expect(certificateHolds("900373115-3", "900373115")).toBe(true);
    expect(certificateHolds("9003731153", "900373115")).toBe(true);
    expect(certificateHolds("NIT 900.373.115-3", "900373115")).toBe(true);
    expect(certificateHolds("900123456", "900373115")).toBe(false);
    expect(certificateHolds("", "900373115")).toBe(false);
    // A check digit that is not the NIT's is another NIT.
    expect(certificateHolds("9003731159", "900373115")).toBe(false);
  });
  it("stores the certificate and its password through the secrets seam (rule 12)", async () => {
    const secrets = new InMemorySecretStore();
    await einvoicePack.storeCertificate(secrets, "c1", p12.buffer, p12.password);
    const loaded = await loadCertificate(secrets, "c1");
    expect(loaded.password).toBe(p12.password);
    expect(loaded.buffer.equals(p12.buffer)).toBe(true);
  });
});

describe("transport vs the company's DIAN environment (production guard, Tasks 17/18 carry)", () => {
  const secrets = new InMemorySecretStore();
  it("the mock serves habilitación only: a company in producción is refused the mock", () => {
    expect(createEInvoiceTransport({}, { companyId: "c1", environment: "habilitacion" })).toBeInstanceOf(MockEInvoiceTransport);
    expect(() => createEInvoiceTransport({}, { companyId: "c1", environment: "produccion" })).toThrow(/einvoice_environment_mismatch/);
    expect(() => createEInvoiceTransport({ EINVOICE_TRANSPORT: "mock" }, { companyId: "c1", environment: "produccion" })).toThrow(/einvoice_environment_mismatch/);
  });
  it("EINVOICE_TRANSPORT must name the company's environment", () => {
    expect(() => createEInvoiceTransport({ EINVOICE_TRANSPORT: "dian-habilitacion" }, { secrets, companyId: "c1", environment: "produccion" })).toThrow(/einvoice_environment_mismatch/);
    expect(() => createEInvoiceTransport({ EINVOICE_TRANSPORT: "dian-produccion" }, { secrets, companyId: "c1", environment: "habilitacion" })).toThrow(/einvoice_environment_mismatch/);
    expect(createEInvoiceTransport({ EINVOICE_TRANSPORT: "dian-produccion" }, { secrets, companyId: "c1", environment: "produccion" }).name).toBe("dian-produccion");
    expect(createEInvoiceTransport({ EINVOICE_TRANSPORT: "dian-habilitacion" }, { secrets, companyId: "c1", environment: "habilitacion" }).name).toBe("dian-habilitacion");
  });
  it("an installed transport is checked the same way (assertTransportEnvironment)", () => {
    const mock = new MockEInvoiceTransport();
    expect(() => einvoicePack.assertTransportEnvironment(mock, "produccion")).toThrow(/einvoice_environment_mismatch/);
    expect(() => einvoicePack.assertTransportEnvironment(mock, "habilitacion")).not.toThrow();
    expect(() => einvoicePack.assertTransportEnvironment({ ...mock, name: "dian-produccion" }, "habilitacion")).toThrow(/einvoice_environment_mismatch/);
    expect(() => einvoicePack.assertTransportEnvironment({ ...mock, name: "dian-produccion" }, "produccion")).not.toThrow();
  });
});
