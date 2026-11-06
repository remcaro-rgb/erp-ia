import { beforeAll, describe, expect, it } from "vitest";
import { EInvoiceTransportError, EnvSecretStore, InMemorySecretStore, MockEInvoiceTransport, resetMockEInvoiceState } from "@erp/infra";
import { CertificateNotConfiguredError, saveCertificate } from "../einvoice/certificate";
import { createEInvoiceTransport, DianSoapTransport } from "../einvoice/transport";
import { generateTestCertP12 } from "./helpers/test-cert";

const META = { cufe: "c".repeat(96), documentNumber: "SETP990000001", issuerNit: "900373115" };
const SIGNED = `<Invoice><ds:Signature xmlns:ds="x"/></Invoice>`;

/** A fetcher that fails the test if anything tries the network. */
const forbiddenFetch: typeof fetch = () => {
  throw new Error("network call attempted");
};

const soap = (inner: string) => `<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope"><s:Body>${inner}</s:Body></s:Envelope>`;
const reply = (body: string, status = 200): typeof fetch => (async () => new Response(body, { status })) as typeof fetch;

let cert: { buffer: Buffer; password: string };
beforeAll(() => {
  cert = generateTestCertP12();
}, 60_000);

describe("createEInvoiceTransport: selected by configuration", () => {
  it("defaults to the mock (Docker stack, CI, tests)", () => {
    expect(createEInvoiceTransport({}, { secrets: new InMemorySecretStore(), companyId: "co-1" })).toBeInstanceOf(MockEInvoiceTransport);
    expect(createEInvoiceTransport({ EINVOICE_TRANSPORT: "mock" }, { secrets: new InMemorySecretStore(), companyId: "co-1" })).toBeInstanceOf(MockEInvoiceTransport);
  });
  it("selects the DIAN habilitación or producción client", () => {
    const deps = { secrets: new InMemorySecretStore(), companyId: "co-1", fetcher: forbiddenFetch };
    const hab = createEInvoiceTransport({ EINVOICE_TRANSPORT: "dian-habilitacion" }, deps);
    expect(hab).toBeInstanceOf(DianSoapTransport);
    expect(hab.name).toBe("dian-habilitacion");
    expect(createEInvoiceTransport({ EINVOICE_TRANSPORT: "dian-produccion" }, deps).name).toBe("dian-produccion");
  });
  it("two factory calls share mock state: submit on one, poll on the other", async () => {
    resetMockEInvoiceState();
    const deps = { secrets: new InMemorySecretStore(), companyId: "co-1" };
    const a = createEInvoiceTransport({}, deps);
    const b = createEInvoiceTransport({}, deps);
    const sent = await a.submit(SIGNED, META);
    expect((await b.poll(sent.trackId)).status).toBe("accepted");
  });
  it("refuses the real transports without an explicitly injected SecretStore, and never takes the environment as the store", () => {
    const env = { EINVOICE_TRANSPORT: "dian-habilitacion" };
    expect(() => createEInvoiceTransport(env, { companyId: "co-1" } as never)).toThrow(/SecretStore/);
    expect(() => createEInvoiceTransport(env, { secrets: new EnvSecretStore({}), companyId: "co-1" })).toThrow(/EnvSecretStore/);
    expect(() => createEInvoiceTransport({ EINVOICE_TRANSPORT: "dian-produccion" }, { companyId: "co-1" } as never)).toThrow(/SecretStore/);
  });
  it("rejects an unknown value", () => {
    expect(() => createEInvoiceTransport({ EINVOICE_TRANSPORT: "carrier-pigeon" }, { secrets: new InMemorySecretStore(), companyId: "co-1" })).toThrow(/EINVOICE_TRANSPORT/);
  });
});

describe("DianSoapTransport without credentials", () => {
  it("fails with 'credentials not configured' on submit and poll, and never touches the network", async () => {
    const t = createEInvoiceTransport({ EINVOICE_TRANSPORT: "dian-habilitacion" }, { secrets: new InMemorySecretStore(), companyId: "co-1", fetcher: forbiddenFetch });
    await expect(t.submit(SIGNED, META)).rejects.toBeInstanceOf(CertificateNotConfiguredError);
    await expect(t.submit(SIGNED, META)).rejects.toThrow(/credentials not configured/i);
    await expect(t.poll("t-1")).rejects.toThrow(/credentials not configured/i);
  });
  it("expectedTrackId (Task 17): a synchronous submission is tracked by its CUFE; the asynchronous test set only by DIAN's ZipKey (unknown before the answer)", () => {
    const t = createEInvoiceTransport({ EINVOICE_TRANSPORT: "dian-habilitacion" }, { secrets: new InMemorySecretStore(), companyId: "co-1", fetcher: forbiddenFetch });
    expect(t.expectedTrackId?.(META)).toBe(META.cufe);
    expect(t.expectedTrackId?.({ ...META, testSetId: "set-1" })).toBeNull();
  });
});

describe("DianSoapTransport with a certificate and a stubbed fetch", () => {
  async function make(fetcher: typeof fetch, environment: "habilitacion" | "produccion" = "habilitacion") {
    const secrets = new InMemorySecretStore();
    await saveCertificate(secrets, "co-1", cert.buffer, cert.password);
    return new DianSoapTransport({ environment, secrets, companyId: "co-1", fetcher });
  }

  it("SendBillSync accepted (status 00) with the application response", async () => {
    const t = await make(reply(soap(`<SendBillSyncResponse><SendBillSyncResult><StatusCode>00</StatusCode><TrackId>trk-1</TrackId><XmlBase64Bytes>${Buffer.from("<ApplicationResponse/>").toString("base64")}</XmlBase64Bytes></SendBillSyncResult></SendBillSyncResponse>`)));
    expect(await t.submit(SIGNED, META)).toEqual({ trackId: "trk-1", status: "accepted", errors: [], applicationResponse: "<ApplicationResponse/>" });
  });

  it("rejected carries the DIAN errors; the trackId falls back to the CUFE when DIAN gives none", async () => {
    const t = await make(reply(soap(`<SendBillSyncResponse><SendBillSyncResult><StatusCode>99</StatusCode><ErrorMessages><string>FAD06</string></ErrorMessages></SendBillSyncResult></SendBillSyncResponse>`)));
    const r = await t.submit(SIGNED, META);
    expect(r.status).toBe("rejected");
    expect(r.errors).toEqual(["FAD06"]);
    expect(r.trackId).toBe(META.cufe);
  });

  it("with a test set uses SendTestSetAsync and is pending; poll maps 98 to pending and 00 to accepted", async () => {
    const calls: string[] = [];
    const fetcher = (async (_url: string, init: RequestInit) => {
      const body = String(init.body);
      calls.push(body.includes("SendTestSetAsync") ? "test-set" : body.includes("GetStatus") ? "status" : "other");
      if (body.includes("SendTestSetAsync")) return new Response(soap(`<SendTestSetAsyncResponse><SendTestSetAsyncResult><ZipKey>zip-1</ZipKey></SendTestSetAsyncResult></SendTestSetAsyncResponse>`));
      const code = calls.filter((c) => c === "status").length === 1 ? "98" : "00";
      return new Response(soap(`<GetStatusResponse><GetStatusResult><StatusCode>${code}</StatusCode></GetStatusResult></GetStatusResponse>`));
    }) as unknown as typeof fetch;
    const t = await make(fetcher);
    const sent = await t.submit(SIGNED, { ...META, testSetId: "ts-1" });
    expect(sent).toMatchObject({ trackId: "zip-1", status: "pending" });
    expect((await t.poll("zip-1")).status).toBe("pending");
    expect((await t.poll("zip-1")).status).toBe("accepted");
    expect(calls).toEqual(["test-set", "status", "status"]);
  });

  it("posts the secured SOAP 1.2 envelope to the environment's endpoint", async () => {
    let seen: { url: string; type: string; body: string } | undefined;
    const fetcher = (async (url: string, init: RequestInit) => {
      seen = { url, type: (init.headers as Record<string, string>)["Content-Type"] ?? "", body: String(init.body) };
      return new Response(soap(`<GetStatusResponse><GetStatusResult><StatusCode>00</StatusCode></GetStatusResult></GetStatusResponse>`));
    }) as unknown as typeof fetch;
    await (await make(fetcher, "produccion")).poll("t");
    expect(seen!.url).toBe("https://vpfe.dian.gov.co/WcfDianCustomerServices.svc");
    expect(seen!.type).toContain("application/soap+xml");
    expect(seen!.body).toContain("<wsse:Security");
  });

  it("poll maps 90 (TrackId no encontrado) to not_found, 66 to pending, and a rejected poll carries its ErrorMessage errors", async () => {
    const notFound = await make(reply(soap(`<GetStatusResponse><GetStatusResult><StatusCode>90</StatusCode></GetStatusResult></GetStatusResponse>`)));
    expect(await notFound.poll("t")).toEqual({ trackId: "t", status: "not_found", errors: [] });
    for (const code of ["66", "98"]) {
      const t = await make(reply(soap(`<GetStatusResponse><GetStatusResult><StatusCode>${code}</StatusCode></GetStatusResult></GetStatusResponse>`)));
      expect((await t.poll("t")).status).toBe("pending");
    }
    const t = await make(reply(soap(`<GetStatusResponse><GetStatusResult><StatusCode>99</StatusCode><ErrorMessage><string>Regla FAD06</string><string>Regla ZB01</string></ErrorMessage></GetStatusResult></GetStatusResponse>`)));
    expect(await t.poll("t")).toMatchObject({ status: "rejected", errors: ["Regla FAD06", "Regla ZB01"] });
  });

  it("passes an abort signal (default 30 s, injectable) to fetch", async () => {
    const seen: (AbortSignal | null | undefined)[] = [];
    const fetcher = (async (_u: string, init: RequestInit) => {
      seen.push(init.signal);
      return new Response(soap(`<GetStatusResponse><GetStatusResult><StatusCode>00</StatusCode></GetStatusResult></GetStatusResponse>`));
    }) as unknown as typeof fetch;
    const secrets = new InMemorySecretStore();
    await saveCertificate(secrets, "co-1", cert.buffer, cert.password);
    await new DianSoapTransport({ environment: "habilitacion", secrets, companyId: "co-1", fetcher }).poll("t");
    await new DianSoapTransport({ environment: "habilitacion", secrets, companyId: "co-1", fetcher, timeoutMs: 5 }).poll("t");
    expect(seen[0]).toBeInstanceOf(AbortSignal);
    expect(seen[1]).toBeInstanceOf(AbortSignal);
  });

  it("truncates a raw error body to 300 characters", async () => {
    const t = await make(reply("x".repeat(5000), 502));
    const error = await t.poll("t").catch((e: Error) => e);
    expect((error as Error).message.length).toBeLessThan(500);
  });

  it("an HTTP error or a network failure is a transient EInvoiceTransportError, never a rejection", async () => {
    const fault = `<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope"><s:Body><s:Fault><s:Code><s:Value>s:Sender</s:Value><s:Subcode><s:Value>a:InvalidSecurity</s:Value></s:Subcode></s:Code><s:Reason><s:Text>bad security</s:Text></s:Reason></s:Fault></s:Body></s:Envelope>`;
    await expect((await make(reply(fault, 500))).submit(SIGNED, META)).rejects.toThrow(/InvalidSecurity: bad security/);
    await expect((await make(reply(fault, 500))).submit(SIGNED, META)).rejects.toBeInstanceOf(EInvoiceTransportError);
    const down = (async () => {
      throw new Error("ECONNRESET");
    }) as unknown as typeof fetch;
    await expect((await make(down)).poll("t")).rejects.toBeInstanceOf(EInvoiceTransportError);
  });
});
