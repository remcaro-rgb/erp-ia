import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { MockEInvoiceTransport, resetMockEInvoiceState, type EInvoiceTransport, type EInvoiceSubmitMeta } from "../einvoice-transport";
import { EnvSecretStore, InMemorySecretStore, type SecretStore } from "../secret-store";

beforeEach(() => resetMockEInvoiceState());

const CUFE = "a".repeat(96);
const meta = (over: Partial<EInvoiceSubmitMeta> = {}): EInvoiceSubmitMeta => ({ cufe: CUFE, documentNumber: "SETP990000001", issuerNit: "900373115", ...over });
const SIGNED = `<Invoice><ds:Signature xmlns:ds="http://www.w3.org/2000/09/xmldsig#"/></Invoice>`;

/** The contract every EInvoiceTransport must honour; Task 17 relies on it, the real DIAN transport is held to the same shape. */
function contract(make: (scenario: "accepted" | "rejected" | "pending") => EInvoiceTransport) {
  it("accepted: a trackId, status accepted, no errors, an application response", async () => {
    const result = await make("accepted").submit(SIGNED, meta());
    expect(result.trackId).toMatch(/\S+/);
    expect(result.status).toBe("accepted");
    expect(result.errors).toEqual([]);
    expect(result.applicationResponse).toBeTruthy();
  });
  it("rejected: status rejected with the DIAN errors", async () => {
    const result = await make("rejected").submit(SIGNED, meta());
    expect(result.status).toBe("rejected");
    expect(result.errors.length).toBeGreaterThan(0);
  });
  it("pending, then accepted on poll", async () => {
    const transport = make("pending");
    const submitted = await transport.submit(SIGNED, meta());
    expect(submitted.status).toBe("pending");
    const polled = await transport.poll(submitted.trackId);
    expect(polled.trackId).toBe(submitted.trackId);
    expect(polled.status).toBe("accepted");
    expect((await transport.poll(submitted.trackId)).status).toBe("accepted");
  });
}

describe("EInvoiceTransport contract on MockEInvoiceTransport", () => {
  contract((scenario) => new MockEInvoiceTransport({ scenario: () => scenario }));
});

describe("MockEInvoiceTransport", () => {
  it("is deterministic per document: the same CUFE always gets the same trackId, across instances", async () => {
    const a = new MockEInvoiceTransport();
    const b = new MockEInvoiceTransport();
    const first = await a.submit(SIGNED, meta());
    const again = await a.submit(SIGNED, meta());
    const other = await b.submit(SIGNED, meta());
    expect(again.trackId).toBe(first.trackId);
    expect(other.trackId).toBe(first.trackId);
    expect((await a.submit(SIGNED, meta({ cufe: "b".repeat(96) }))).trackId).not.toBe(first.trackId);
    expect(first.trackId).toBe(
      (() => {
        const h = createHash("sha256").update(`mock-dian-track:${CUFE}`).digest("hex");
        return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
      })(),
    );
  });

  it("resubmitting a pending document does not restart it; resubmitting an accepted one stays accepted", async () => {
    const t = new MockEInvoiceTransport({ scenario: () => "pending", pendingPolls: 2 });
    const first = await t.submit(SIGNED, meta());
    expect((await t.poll(first.trackId)).status).toBe("pending");
    expect((await t.submit(SIGNED, meta())).status).toBe("pending");
    expect((await t.poll(first.trackId)).status).toBe("accepted");
    expect((await t.submit(SIGNED, meta())).status).toBe("accepted");
  });

  it("pendingPolls keeps the document pending for that many polls", async () => {
    const t = new MockEInvoiceTransport({ scenario: () => "pending", pendingPolls: 3 });
    const { trackId } = await t.submit(SIGNED, meta());
    expect((await t.poll(trackId)).status).toBe("pending");
    expect((await t.poll(trackId)).status).toBe("pending");
    expect((await t.poll(trackId)).status).toBe("accepted");
  });

  it("a rejected document stays rejected with the same errors on poll", async () => {
    const t = new MockEInvoiceTransport({ scenario: () => "rejected" });
    const sent = await t.submit(SIGNED, meta());
    expect(await t.poll(sent.trackId)).toEqual(sent);
  });

  it("rejects an unsigned document; an unknown trackId is not_found (not received), never a rejection", async () => {
    const t = new MockEInvoiceTransport();
    const unsigned = await t.submit("<Invoice/>", meta());
    expect(unsigned.status).toBe("rejected");
    expect(unsigned.errors.join(" ")).toMatch(/firma/i);
    expect(await t.poll("nope")).toEqual({ trackId: "nope", status: "not_found", errors: [] });
    // The trackId a document would get, polled before it was ever sent: not received.
    expect((await t.poll(t.expectedTrackId(meta({ cufe: "f".repeat(96) })))).status).toBe("not_found");
  });

  it("is flagged as simulated in the application response (never a fiscal validity)", async () => {
    const r = await new MockEInvoiceTransport().submit(SIGNED, meta());
    expect(r.applicationResponse).toContain("SIMULADO");
    expect(r.applicationResponse).toContain(r.trackId);
  });
});

describe("MockEInvoiceTransport shared state", () => {
  it("submit on one instance and poll on another see the same document (process-wide store)", async () => {
    const a = new MockEInvoiceTransport({ scenario: () => "pending", pendingPolls: 2 });
    const b = new MockEInvoiceTransport();
    const sent = await a.submit(SIGNED, meta());
    expect(sent.status).toBe("pending");
    expect((await b.poll(sent.trackId)).status).toBe("pending");
    // resubmitting through another instance does not restart the pending document
    expect((await b.submit(SIGNED, meta())).status).toBe("pending");
    expect((await a.poll(sent.trackId)).status).toBe("accepted");
  });
  it("namespaces are isolated and reset clears the store", async () => {
    const a = new MockEInvoiceTransport({ namespace: "x" });
    const { trackId } = await a.submit(SIGNED, meta());
    expect((await new MockEInvoiceTransport({ namespace: "y" }).poll(trackId)).status).toBe("not_found");
    expect((await new MockEInvoiceTransport({ namespace: "x" }).poll(trackId)).status).toBe("accepted");
    resetMockEInvoiceState();
    expect((await a.poll(trackId)).status).toBe("not_found");
  });
  it("escapes XML in the application response", async () => {
    const r = await new MockEInvoiceTransport().submit(SIGNED, meta({ documentNumber: "A<&>1" }));
    expect(r.applicationResponse).toContain("A&lt;&amp;&gt;1");
  });
  it("the store lives on globalThis: a second copy of the module (a workflow step bundle) sees the same documents", async () => {
    const sent = await new MockEInvoiceTransport({ scenario: () => "pending", pendingPolls: 2 }).submit(SIGNED, meta());
    const store = (globalThis as Record<symbol, Map<string, Map<string, unknown>>>)[Symbol.for("erp.infra.mockEInvoiceStore")];
    expect(store?.get("default")?.has(sent.trackId)).toBe(true);
  });
});

describe("MockEInvoiceTransport, Task 17 additions", () => {
  it("expectedTrackId answers the trackId a submission of the document gets, without sending it (a submit whose answer was lost is polled, never sent again)", async () => {
    const t = new MockEInvoiceTransport();
    const expected = t.expectedTrackId(meta());
    expect((await t.submit(SIGNED, meta())).trackId).toBe(expected);
  });
  it("a rejected document sent again with a different content (corrected, same number and CUFE) is validated again; sent again unchanged it stays rejected", async () => {
    let verdict: "rejected" | "accepted" = "rejected";
    const t = new MockEInvoiceTransport({ scenario: () => verdict });
    const first = await t.submit(SIGNED, meta());
    expect(first.status).toBe("rejected");
    verdict = "accepted";
    expect((await t.submit(SIGNED, meta())).status).toBe("rejected");
    // Signed again (another signing time), the same document is the same document.
    const resigned = `<Invoice><ds:Signature xmlns:ds="http://www.w3.org/2000/09/xmldsig#"><xades:SigningTime>2026-11-05T10:00:00Z</xades:SigningTime><ds:X/></ds:Signature></Invoice>`;
    expect((await t.submit(resigned, meta())).status).toBe("rejected");
    const corrected = SIGNED.replace("<Invoice>", "<Invoice><Note>corregida</Note>");
    const again = await t.submit(corrected, meta());
    expect(again).toMatchObject({ trackId: first.trackId, status: "accepted" });
  });
  it("an accepted document is never validated again, whatever is sent", async () => {
    let verdict: "rejected" | "accepted" = "accepted";
    const t = new MockEInvoiceTransport({ scenario: () => verdict });
    await t.submit(SIGNED, meta());
    verdict = "rejected";
    expect((await t.submit(SIGNED.replace("<Invoice>", "<Invoice><X/>"), meta())).status).toBe("accepted");
  });
});

describe("secret stores (the seam the certificate goes through, rule 12)", () => {
  it("InMemorySecretStore: set, get, delete", async () => {
    const s = new InMemorySecretStore();
    expect(await s.get("a")).toBeNull();
    await s.set("a", "1");
    expect(await s.get("a")).toBe("1");
    await s.delete("a");
    expect(await s.get("a")).toBeNull();
  });
  it("EnvSecretStore reads the deployment's secrets by upper-cased name and is read-only", async () => {
    const s: SecretStore = new EnvSecretStore({ DIAN_ABC_CERTIFICATE: "x" });
    expect(await s.get("dian/abc/certificate")).toBe("x");
    expect(await s.get("dian/zzz/certificate")).toBeNull();
    await expect(s.set("a", "b")).rejects.toThrow(/read-only/);
  });
});
