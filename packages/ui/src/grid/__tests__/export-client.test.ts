import { describe, expect, it, vi } from "vitest";
import { ExportRequestError, fileNameOf, requestExport } from "../export-client";

// The browser side of an export (design §9): ask the server, get the file at once or wait for the job, and hand the
// result to the download.

const state = { filters: [], sort: [], page: 1, pageSize: 25, columns: ["seq"] };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("requestExport", () => {
  it("posts the state and returns the file of an inline answer under the server's name", async () => {
    const fetcher = vi.fn(async () => new Response("a;b", { status: 200, headers: { "content-disposition": 'attachment; filename="terceros-2026-10-28.csv"' } }));
    const result = await requestExport({ entity: "core.party", format: "csv", state, title: "Terceros" }, { fetcher });
    expect(fetcher).toHaveBeenCalledWith("/api/export", expect.objectContaining({ method: "POST", headers: { "content-type": "application/json" } }));
    expect(JSON.parse((fetcher.mock.calls[0] as unknown as [string, RequestInit])[1].body as string)).toEqual({ entity: "core.party", format: "csv", state, title: "Terceros" });
    expect(result.kind).toBe("file");
    if (result.kind === "file") {
      expect(result.fileName).toBe("terceros-2026-10-28.csv");
      expect(await result.blob.text()).toBe("a;b");
    }
  });

  it("waits for a job: tells when it started, polls until done and returns the link", async () => {
    const answers = [json({ mode: "job", jobId: "j1" }, 202), json({ status: "queued" }), json({ status: "running" }), json({ status: "done", url: "https://files/x", fileName: "terceros.xlsx", rowCount: 12000 })];
    const fetcher = vi.fn(async () => answers.shift()!);
    const onJob = vi.fn();
    const result = await requestExport({ entity: "core.party", format: "xlsx", state }, { fetcher, pollMs: 0, onJob });
    expect(onJob).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls.map((c) => (c as unknown as [string])[0])).toEqual(["/api/export", "/api/export/j1", "/api/export/j1", "/api/export/j1"]);
    expect(result).toEqual({ kind: "link", url: "https://files/x", fileName: "terceros.xlsx" });
  });

  it("fails with the server's code, and when the job fails", async () => {
    await expect(requestExport({ entity: "core.party", format: "csv", state }, { fetcher: async () => json({ code: "forbidden", details: null }, 403) })).rejects.toMatchObject({ code: "forbidden", status: 403 });
    const answers = [json({ mode: "job", jobId: "j1" }, 202), json({ status: "failed", error: "No se pudo generar la exportación" })];
    const failed = requestExport({ entity: "core.party", format: "csv", state }, { fetcher: async () => answers.shift()!, pollMs: 0 });
    await expect(failed).rejects.toBeInstanceOf(ExportRequestError);
    await expect(requestExport({ entity: "core.party", format: "csv", state }, { fetcher: async () => { throw new TypeError("offline"); } })).rejects.toMatchObject({ code: "network" });
  });

  it("gives up on a job that takes longer than its budget, with its own code", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => (String(input) === "/api/export" ? json({ mode: "job", jobId: "j1" }, 202) : json({ status: "running" })));
    await expect(requestExport({ entity: "core.party", format: "csv", state }, { fetcher, pollMs: 5, maxWaitMs: 30 })).rejects.toMatchObject({ code: "export_timeout" });
    expect(fetcher.mock.calls.length).toBeGreaterThan(2);
    expect(fetcher.mock.calls.length).toBeLessThan(12);
  });

  it("stops polling when aborted", async () => {
    const controller = new AbortController();
    let polls = 0;
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/export") return json({ mode: "job", jobId: "j1" }, 202);
      polls += 1;
      if (polls === 2) controller.abort();
      return json({ status: "running" });
    });
    await expect(requestExport({ entity: "core.party", format: "csv", state }, { fetcher, pollMs: 0, signal: controller.signal })).rejects.toMatchObject({ code: "aborted" });
    expect(polls).toBe(2);
  });
});

describe("fileNameOf", () => {
  it("reads the name from Content-Disposition, with a fallback", () => {
    expect(fileNameOf('attachment; filename="a b.csv"', "x.csv")).toBe("a b.csv");
    expect(fileNameOf("attachment; filename=plain.pdf", "x.pdf")).toBe("plain.pdf");
    expect(fileNameOf(null, "x.pdf")).toBe("x.pdf");
  });
});
