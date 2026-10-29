// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { Toaster, toast } from "@erp/ui/components/ui/sonner";
import { DataGrid } from "../DataGrid";
import { ExportJobsProvider } from "../export-jobs";
import type { GridColumn, GridFetcher, GridRow } from "../types";
import { renderEs, stubLayoutApis } from "../../shell/__tests__/intl";

// UI density audit quick win 11 (H7): an export runs in the shell, not in the grid. Changing tab (the grid unmounts)
// no longer aborts it: the file still downloads, a toast says so, and a grid shown again sees the export still running.

beforeAll(() => {
  stubLayoutApis();
  window.matchMedia ??= ((query: string) => ({ matches: false, media: query, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false })) as unknown as typeof window.matchMedia;
});
afterEach(() => {
  // Toasts live in sonner's module state: none carries over to the next test.
  toast.dismiss();
  cleanup();
  vi.unstubAllGlobals();
});

const columns: GridColumn[] = [{ field: "legal_name", label: "Razón social", type: "text", kind: "text", mode: "visible", filterable: true, sortable: true }];
const rows: GridRow[] = [{ id: "a", legal_name: "Almacenes Éxito S.A." }];
const fetcher: GridFetcher = async () => ({ rows, total: 1 });

function Shell({ showGrid }: { showGrid: boolean }) {
  return (
    <ExportJobsProvider>
      {showGrid ? <DataGrid entity="core.party" title="Terceros" columns={columns} fetcher={fetcher} debounceMs={5} /> : <p>otra pestaña</p>}
      <Toaster />
    </ExportJobsProvider>
  );
}

describe("ExportJobsProvider", () => {
  it("keeps an export alive when the grid unmounts, downloads the file and says so in a toast", async () => {
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    Object.assign(URL, { createObjectURL: () => "blob:test", revokeObjectURL: () => undefined });
    let finish: (response: Response) => void = () => undefined;
    const exportFetch = vi.fn((_url: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((resolve, reject) => {
      finish = resolve;
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    }));
    vi.stubGlobal("fetch", exportFetch);
    try {
      const view = renderEs(<Shell showGrid />);
      await screen.findByText("Almacenes Éxito S.A.");
      fireEvent.click(screen.getByRole("button", { name: "CSV" }));
      expect(screen.getByText("Generando CSV…")).toBeTruthy();

      // Another tab: the grid unmounts, the export carries on.
      view.rerender(<Shell showGrid={false} />);
      expect((exportFetch.mock.calls[0]![1] as RequestInit).signal!.aborted).toBe(false);

      // Back to the grid while it runs: it still says so and waits (one at a time).
      view.rerender(<Shell showGrid />);
      await screen.findByText("Almacenes Éxito S.A.");
      expect(screen.getByText("Generando CSV…")).toBeTruthy();
      expect((screen.getByRole("button", { name: "Excel" }) as HTMLButtonElement).disabled).toBe(true);

      view.rerender(<Shell showGrid={false} />);
      finish(new Response("a;b", { status: 200, headers: { "content-disposition": 'attachment; filename="terceros.csv"' } }));
      await waitFor(() => expect(click).toHaveBeenCalledTimes(1));
      expect(await screen.findByText("Terceros · Descarga lista: terceros.csv")).toBeTruthy();
    } finally {
      click.mockRestore();
    }
  });

  it("a grid on screen shows the outcome itself, without a toast", async () => {
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    Object.assign(URL, { createObjectURL: () => "blob:test", revokeObjectURL: () => undefined });
    vi.stubGlobal("fetch", vi.fn(async () => new Response("a;b", { status: 200, headers: { "content-disposition": 'attachment; filename="terceros.csv"' } })));
    try {
      renderEs(<Shell showGrid />);
      await screen.findByText("Almacenes Éxito S.A.");
      fireEvent.click(screen.getByRole("button", { name: "CSV" }));
      await waitFor(() => expect(document.querySelector(".erp-grid__status")!.textContent).toBe("Descarga lista: terceros.csv"));
      expect(screen.queryByText("Terceros · Descarga lista: terceros.csv")).toBeNull();
    } finally {
      click.mockRestore();
    }
  });
});
