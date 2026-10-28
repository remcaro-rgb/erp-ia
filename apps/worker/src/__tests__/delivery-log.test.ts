import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { logDeliveries } from "../delivery-log";

// Which process consumed a job (Task 21 review): the Postgres World delivers every queued workflow and step invocation
// with an HTTP POST to the web app's flow route from the process whose graphile runner took the job. The worker logs
// each delivery it made with its name, so the smoke can show jobs ran in the worker container.

let server: http.Server | undefined;
let uninstall: (() => void) | undefined;
afterEach(async () => {
  uninstall?.();
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
});

function flowServer(status: number): Promise<number> {
  server = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.statusCode = status;
      res.end("{}");
    });
  });
  return new Promise((resolve) => server!.listen(0, "127.0.0.1", () => resolve((server!.address() as { port: number }).port)));
}

function post(port: number, path: string, body: string, headers: Record<string, string> = {}): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = http.request(`http://127.0.0.1:${port}${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers } });
    req.on("response", (res) => {
      res.resume();
      res.on("end", () => resolve());
    });
    req.on("error", reject);
    req.end(body);
  });
}

describe("logDeliveries", () => {
  it("logs each delivery to the flow route with this worker's name, the queue, the run id and the status", async () => {
    const port = await flowServer(200);
    const lines: string[] = [];
    uninstall = logDeliveries("worker-a1", (line) => lines.push(line));
    await post(port, "/.well-known/workflow/v1/flow", JSON.stringify({ runId: "wrun_01ABC", stepName: "x" }), { "x-vqs-queue-name": "__wkf_step_x" });
    await new Promise((resolve) => setImmediate(resolve));
    expect(lines).toEqual(["[worker worker-a1] delivered __wkf_step_x run=wrun_01ABC status=200"]);
  });

  it("ignores every other request, and stops logging once uninstalled", async () => {
    const port = await flowServer(200);
    const lines: string[] = [];
    uninstall = logDeliveries("worker-a1", (line) => lines.push(line));
    await post(port, "/api/internal/outbox/tick", "{}");
    uninstall();
    uninstall = undefined;
    await post(port, "/.well-known/workflow/v1/flow", JSON.stringify({ runId: "wrun_01ABC" }));
    await new Promise((resolve) => setImmediate(resolve));
    expect(lines).toEqual([]);
  });
});
