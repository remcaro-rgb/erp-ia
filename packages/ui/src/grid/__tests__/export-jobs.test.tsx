// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { Toaster, toast } from "@erp/ui/components/ui/sonner";
import { DataGrid } from "../DataGrid";
import { ExportJobsProvider } from "../export-jobs";
import { useGridExport } from "../use-grid-export";
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

  // Branch review fix 2: the provider leaving (sign-out, company switch) takes its jobs with it.
  it("aborts every running export when the provider itself unmounts: no download, no toast", async () => {
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    let signal: AbortSignal | undefined;
    vi.stubGlobal("fetch", vi.fn((_url: RequestInfo | URL, init?: RequestInit) => {
      signal = init?.signal ?? undefined;
      return new Promise<Response>((_resolve, reject) => signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
    }));
    try {
      const view = renderEs(<Shell showGrid />);
      await screen.findByText("Almacenes Éxito S.A.");
      fireEvent.click(screen.getByRole("button", { name: "CSV" }));
      expect(signal?.aborted).toBe(false);
      view.unmount();
      expect(signal?.aborted).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(click).not.toHaveBeenCalled();
    } finally {
      click.mockRestore();
    }
  });

  it("an export that fails off-screen says why in a toast, with the entity's name", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ code: "forbidden", details: null }), { status: 403 })));
    const view = renderEs(<Shell showGrid />);
    await screen.findByText("Almacenes Éxito S.A.");
    let resolveLater!: () => void;
    // Hold the answer until the grid is gone.
    const gate = new Promise<void>((resolve) => (resolveLater = resolve));
    const original = globalThis.fetch;
    vi.stubGlobal("fetch", vi.fn(async (...args: Parameters<typeof fetch>) => (await gate, original(...args))));
    fireEvent.click(screen.getByRole("button", { name: "PDF" }));
    view.rerender(<Shell showGrid={false} />);
    resolveLater();
    expect(await screen.findByText("Terceros · No se pudo exportar. No tienes permiso para hacer esto.")).toBeTruthy();
  });

  it("names the entity from the catalogue when the export has no screen title (the assistant's result table)", async () => {
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    Object.assign(URL, { createObjectURL: () => "blob:test", revokeObjectURL: () => undefined });
    vi.stubGlobal("fetch", vi.fn(async () => new Response("a;b", { status: 200, headers: { "content-disposition": 'attachment; filename="r.csv"' } })));
    function Untitled() {
      const exporter = useGridExport({ entity: "core.party" });
      return (
        <button type="button" onClick={() => void exporter.run("csv", { filters: [], sort: [], page: 1, pageSize: 10 })}>
          exportar
        </button>
      );
    }
    try {
      const view = renderEs(
        <ExportJobsProvider>
          <Untitled />
          <Toaster />
        </ExportJobsProvider>,
      );
      fireEvent.click(screen.getByRole("button", { name: "exportar" }));
      // The result table goes away (its message scrolled off): the toast names the entity, not core.party.
      view.rerender(
        <ExportJobsProvider>
          <Toaster />
        </ExportJobsProvider>,
      );
      expect(await screen.findByText("Tercero · Descarga lista: r.csv")).toBeTruthy();
    } finally {
      click.mockRestore();
    }
  });
});
