// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { LiveStatus } from "../LiveStatus";
import { useLivePoll } from "../use-live-poll";
import { CellFormatProvider } from "../../grid/cell-format";
import { importProgress, type ImportHistoryItem } from "../../import/import-model";
import { renderEs } from "../../shell/__tests__/intl";

// UI density audit quick win 10 (M1): a polling surface says whether it is live, paused or offline and when it last
// read, pauses while the browser tab is hidden, survives a failed read with "Reanudar", and shows progress per import.

afterEach(cleanup);

type Item = { id: string; running: boolean };
const pending = (items: Item[]) => items.some((i) => i.running);

function Probe({ read, initial }: { read: () => Promise<Item[]>; initial: Item[] }) {
  const poll = useLivePoll({ initial, read, pending, intervalMs: 3000 });
  return (
    <CellFormatProvider timeZone="America/Bogota">
      <LiveStatus state={poll.state} at={poll.at} onResume={poll.resume} />
      <span data-testid="count">{poll.value.length}</span>
      <button type="button" onClick={() => void poll.refresh()}>
        leer
      </button>
    </CellFormatProvider>
  );
}

let visibility: DocumentVisibilityState = "visible";
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-28T15:04:05Z"));
  visibility = "visible";
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
});
afterEach(() => vi.useRealTimers());
const setVisible = async (v: DocumentVisibilityState) => {
  visibility = v;
  await act(async () => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
};
const tick = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });

describe("useLivePoll and LiveStatus", () => {
  it("reads every 3 s while something is pending and says En vivo with the time of the last read", async () => {
    const read = vi.fn(async () => [{ id: "1", running: true }]);
    renderEs(<Probe read={read} initial={[{ id: "1", running: true }]} />);
    expect(screen.getByRole("status").textContent).toContain("En vivo");
    await tick(3000);
    expect(read).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("status").textContent).toBe("En vivo · 10:04:08");
    await tick(3000);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("stops when nothing is pending, and then only says when it last read", async () => {
    const read = vi.fn(async () => [{ id: "1", running: false }]);
    renderEs(<Probe read={read} initial={[{ id: "1", running: true }]} />);
    await tick(3000);
    expect(screen.getByText("Actualizado 10:04:08")).toBeTruthy();
    await tick(9000);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("pauses while the browser tab is hidden and reads at once when it shows again", async () => {
    const read = vi.fn(async () => [{ id: "1", running: true }]);
    renderEs(<Probe read={read} initial={[{ id: "1", running: true }]} />);
    await setVisible("hidden");
    expect(screen.getByRole("status").textContent).toContain("En pausa");
    await tick(9000);
    expect(read).not.toHaveBeenCalled();
    await setVisible("visible");
    await tick(0);
    expect(read).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("status").textContent).toContain("En vivo");
  });

  it("survives a failed read: says Sin conexión, waits, and Reanudar reads again", async () => {
    const read = vi.fn<() => Promise<Item[]>>().mockRejectedValueOnce(new Error("offline")).mockResolvedValue([{ id: "1", running: false }]);
    renderEs(<Probe read={read} initial={[{ id: "1", running: true }]} />);
    await tick(3000);
    expect(screen.getByRole("status").textContent).toContain("Sin conexión");
    await tick(9000);
    expect(read).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Reanudar" }));
    await tick(0);
    expect(read).toHaveBeenCalledTimes(2);
    expect(screen.getByText("Actualizado 10:04:17")).toBeTruthy();
  });
});

describe("useLivePoll: a read on demand", () => {
  it("a failed read on demand says Sin conexión even when nothing is pending", async () => {
    const read = vi.fn<() => Promise<Item[]>>().mockResolvedValueOnce([]).mockRejectedValueOnce(new Error("offline")).mockResolvedValue([]);
    renderEs(<Probe read={read} initial={[]} />);
    fireEvent.click(screen.getByRole("button", { name: "leer" }));
    await tick(0);
    expect(screen.getByText("Actualizado 10:04:05")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "leer" }));
    await tick(0);
    expect(screen.getByRole("status").textContent).toContain("Sin conexión");
    fireEvent.click(screen.getByRole("button", { name: "Reanudar" }));
    await tick(0);
    expect(screen.queryByRole("status")).toBeNull();
    expect(read).toHaveBeenCalledTimes(3);
  });
});

describe("useLivePoll: overlapping reads", () => {
  it("only the latest read counts: a slow earlier answer never hides a later failure", async () => {
    let answer!: (items: Item[]) => void;
    const read = vi
      .fn<() => Promise<Item[]>>()
      .mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)))
      .mockRejectedValueOnce(new Error("offline"));
    renderEs(<Probe read={read} initial={[]} />);
    fireEvent.click(screen.getByRole("button", { name: "leer" }));
    fireEvent.click(screen.getByRole("button", { name: "leer" }));
    await tick(0);
    expect(screen.getByRole("status").textContent).toContain("Sin conexión");
    await act(async () => answer([{ id: "x", running: false }]));
    expect(screen.getByRole("status").textContent).toContain("Sin conexión");
    expect(screen.getByTestId("count").textContent).toBe("0");
  });
});

describe("import progress", () => {
  const item = (patch: Partial<ImportHistoryItem>): ImportHistoryItem => ({ id: "i", entity: "core.party", status: "running", rowsTotal: 2400, rowsOk: 1352, rowsFailed: 28, fileName: "a.csv", errorsAttachmentId: null, startedByName: null, error: null, createdAt: "", finishedAt: null, ...patch });
  it("counts the rows done of a running import, nothing otherwise", () => {
    expect(importProgress(item({}))).toEqual({ done: 1380, total: 2400, ratio: 0.575 });
    expect(importProgress(item({ status: "done" }))).toBeNull();
    expect(importProgress(item({ rowsTotal: 0 }))).toBeNull();
    expect(importProgress(item({ rowsTotal: 10, rowsOk: 20, rowsFailed: null }))).toEqual({ done: 10, total: 10, ratio: 1 });
  });
});
