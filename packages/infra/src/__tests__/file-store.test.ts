import { describe, it, expect } from "vitest";
import { SupabaseFileStore, type FileStore } from "../file-store";

type Call = [string, ...unknown[]];

/** A Storage client that records what the store asks of it. */
function fakeClient(result: { error?: { message: string } | null; signedUrl?: string } = {}) {
  const calls: Call[] = [];
  const bucket = {
    upload: async (...args: unknown[]) => (calls.push(["upload", ...args]), { error: result.error ?? null }),
    createSignedUrl: async (...args: unknown[]) => (
      calls.push(["createSignedUrl", ...args]),
      { data: result.signedUrl ? { signedUrl: result.signedUrl } : null, error: result.error ?? null }
    ),
    remove: async (...args: unknown[]) => (calls.push(["remove", ...args]), { error: result.error ?? null }),
  };
  const client = { storage: { from: (name: string) => (calls.push(["from", name]), bucket) } };
  return { client: client as unknown as ConstructorParameters<typeof SupabaseFileStore>[0], calls };
}

describe("SupabaseFileStore", () => {
  it("stores bytes in the attachments bucket without overwriting, reading a stream whole", async () => {
    const { client, calls } = fakeClient();
    const store: FileStore = new SupabaseFileStore(client);
    await store.put("t/c/core.party/1/a.pdf", Buffer.from("pdf"), "application/pdf");
    await store.put("t/c/core.party/1/b.pdf", new Blob(["stream"]).stream(), "application/pdf");
    expect(calls[0]).toEqual(["from", "attachments"]);
    expect(calls[1]).toEqual(["upload", "t/c/core.party/1/a.pdf", Buffer.from("pdf"), { contentType: "application/pdf", upsert: false }]);
    expect(calls[3]).toEqual(["upload", "t/c/core.party/1/b.pdf", Buffer.from("stream"), { contentType: "application/pdf", upsert: false }]);
  });

  it("mints a signed url with the given ttl and removes objects", async () => {
    const { client, calls } = fakeClient({ signedUrl: "http://storage/signed?token=1" });
    const store = new SupabaseFileStore(client);
    await expect(store.signedUrl("p", 60)).resolves.toBe("http://storage/signed?token=1");
    await store.remove("p");
    expect(calls.filter((c) => c[0] !== "from")).toEqual([["createSignedUrl", "p", 60], ["remove", ["p"]]]);
  });

  it("surfaces storage errors", async () => {
    const { client } = fakeClient({ error: { message: "The resource already exists" } });
    const store = new SupabaseFileStore(client);
    await expect(store.put("p", Buffer.from("x"), "text/plain")).rejects.toThrow("The resource already exists");
    await expect(store.signedUrl("p", 60)).rejects.toThrow("could not sign p");
    await expect(store.remove("p")).rejects.toThrow("could not remove p");
  });

  it("fromEnv needs the project url and the service-role key", () => {
    expect(() => SupabaseFileStore.fromEnv({})).toThrow("SUPABASE_SERVICE_ROLE_KEY");
    expect(SupabaseFileStore.fromEnv({ SUPABASE_URL: "http://127.0.0.1:55321", SUPABASE_SERVICE_ROLE_KEY: "k" })).toBeInstanceOf(SupabaseFileStore);
  });
});
