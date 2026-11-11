import { describe, expect, it } from "vitest";
import JSZip from "jszip";
import { buildSoapEnvelope, createInvoiceZip, parseSoapResponse } from "../einvoice/soap-client";

describe("buildSoapEnvelope", () => {
  it("wraps content in a SOAP envelope for SendBillSync", () => {
    const envelope = buildSoapEnvelope("SendBillSync", { fileName: "900123456FE001.zip", contentFile: "base64content==" });
    for (const part of ["<soap:Envelope", "SendBillSync", "900123456FE001.zip", "base64content=="]) expect(envelope).toContain(part);
  });
  it("builds GetStatus and SendTestSetAsync envelopes", () => {
    expect(buildSoapEnvelope("GetStatus", { trackId: "track-uuid-123" })).toContain("track-uuid-123");
    const t = buildSoapEnvelope("SendTestSetAsync", { fileName: "test.zip", contentFile: "base64==", testSetId: "testset-uuid" });
    expect(t).toContain("SendTestSetAsync");
    expect(t).toContain("testset-uuid");
  });
});

describe("parseSoapResponse", () => {
  const wrap = (inner: string) => `<?xml version="1.0"?><s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope"><s:Body>${inner}</s:Body></s:Envelope>`;
  it("parses an accepted response", () => {
    const r = parseSoapResponse(wrap(`<SendBillSyncResponse xmlns="http://wcf.dian.colombia"><SendBillSyncResult><StatusCode>00</StatusCode><StatusDescription>Procesado Correctamente</StatusDescription><StatusMessage>Accepted</StatusMessage><XmlBase64Bytes>PHhtbD48L3htbD4=</XmlBase64Bytes></SendBillSyncResult></SendBillSyncResponse>`));
    expect(r.success).toBe(true);
    expect(r.statusCode).toBe("00");
    expect(r.statusDescription).toBe("Procesado Correctamente");
    expect(r.xmlResponse).toBe("<xml></xml>");
  });
  it("parses a rejected response with its errors", () => {
    const r = parseSoapResponse(wrap(`<SendBillSyncResponse xmlns="http://wcf.dian.colombia"><SendBillSyncResult><StatusCode>99</StatusCode><StatusDescription>Validación fallida</StatusDescription><StatusMessage>Rejected</StatusMessage><ErrorMessages><string>CUFE inválido</string><string>NIT no encontrado</string></ErrorMessages></SendBillSyncResult></SendBillSyncResponse>`));
    expect(r.success).toBe(false);
    expect(r.statusCode).toBe("99");
    expect(r.errorMessages).toEqual(["CUFE inválido", "NIT no encontrado"]);
  });
  it("reads the ErrorMessage list DIAN's GetStatus uses and the track id", () => {
    const r = parseSoapResponse(wrap(`<GetStatusResponse><GetStatusResult><StatusCode>99</StatusCode><ErrorMessage><string>Regla FAD06</string></ErrorMessage><TrackId>t-1</TrackId></GetStatusResult></GetStatusResponse>`));
    expect(r.errorMessages).toEqual(["Regla FAD06"]);
    expect(r.trackId).toBe("t-1");
  });
  it("reports a structure error for a non-SOAP body", () => {
    expect(parseSoapResponse("<x/>").statusCode).toBe("PARSE_ERROR");
  });
});

describe("createInvoiceZip", () => {
  it("returns a base64 zip holding the XML under the given name", async () => {
    const base64 = await createInvoiceZip("<xml>test</xml>", "900123456FE001.xml");
    const zip = await JSZip.loadAsync(Buffer.from(base64, "base64"));
    expect(await zip.file("900123456FE001.xml")!.async("string")).toBe("<xml>test</xml>");
  });
});
