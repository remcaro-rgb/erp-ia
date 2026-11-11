// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { renderEs, stubLayoutApis } from "../../shell/__tests__/intl";
import { ImportDialog } from "../ImportDialog";
import { canRunImport, fileProblem, importPending, previewCounts, refusalOf, templateHref, type ImportPreviewData } from "../import-model";

beforeAll(stubLayoutApis);
afterEach(cleanup);

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const csvFile = (name = "terceros.csv") => new File(["kind;documentNumber\n"], name, { type: "text/csv" });

const preview: ImportPreviewData = {
  entity: "core.party",
  fileName: "terceros.csv",
  headers: ["Tipo de tercero", "Número de documento"],
  unknownHeaders: ["Canal"],
  missingColumns: [],
  total: 2,
  rows: [
    { rowNo: 2, ok: true, errors: [], cells: ["customer", "900373115"] },
    { rowNo: 3, ok: false, errors: ["31: solo dígitos"], cells: ["customer", "800ABC123"] },
  ],
};

describe("import model", () => {
  it("counts the previewed rows and offers the import only with a valid row and every required column", () => {
    expect(previewCounts(preview)).toEqual({ valid: 1, invalid: 1 });
    expect(canRunImport(preview)).toBe(true);
    expect(canRunImport(null)).toBe(false);
    expect(canRunImport({ ...preview, rows: [preview.rows[1]!] })).toBe(false);
    expect(canRunImport({ ...preview, missingColumns: ["Número de documento"] })).toBe(false);
  });

  it("links the templates, checks the file type and size, and knows when an import is still running", () => {
    expect(templateHref("/api/import", "core.party", "xlsx")).toBe("/api/import?entity=core.party&format=xlsx");
    expect(fileProblem(csvFile(), 100)).toBeNull();
    expect(fileProblem(new File(["x"], "foto.pdf"), 100)).toBe("wrong_type");
    const big = csvFile();
    Object.defineProperty(big, "size", { value: 101 });
    expect(fileProblem(big, 100)).toBe("too_big");
    const item = { id: "1", entity: "core.party", rowsTotal: 1, rowsOk: 1, rowsFailed: 0, fileName: "a.csv", errorsAttachmentId: null, startedByName: null, error: null, createdAt: "", finishedAt: null };
    expect(importPending([{ ...item, status: "done" }])).toBe(false);
    expect(importPending([{ ...item, status: "running" }])).toBe(true);
  });

  it("reads a refusal's details, or its code", async () => {
    expect(await refusalOf(json({ code: "invalid_input", details: ["El archivo está vacío"] }, 400))).toEqual({ code: "invalid_input", message: "El archivo está vacío" });
    expect(await refusalOf(json({ code: "forbidden", details: null }, 403))).toEqual({ code: "forbidden", message: "forbidden" });
  });
});

describe("ImportDialog", () => {
  it("offers both templates, previews a dropped file row by row and enables Importar filas válidas", async () => {
    const fetcher = vi.fn(async () => json(preview));
    renderEs(<ImportDialog open onOpenChange={() => {}} entity="core.party" entityLabel="Terceros" fetcher={fetcher as unknown as typeof fetch} />);
    expect(screen.getByText("Importar terceros")).toBeTruthy();
    expect(screen.getByText("Plantilla Excel").closest("a")!.getAttribute("href")).toBe("/api/import?entity=core.party&format=xlsx");
    expect(screen.getByText("Plantilla CSV").closest("a")!.getAttribute("href")).toBe("/api/import?entity=core.party&format=csv");
    const run = screen.getByRole("button", { name: "Importar filas válidas" }) as HTMLButtonElement;
    expect(run.disabled).toBe(true);

    fireEvent.drop(screen.getByTestId("import-drop"), { dataTransfer: { files: [csvFile()] } });
    await screen.findByText("Vista previa · 2 filas", { exact: false });
    const [, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    const sent = init.body as FormData;
    expect(sent.get("mode")).toBe("preview");
    expect(sent.get("entity")).toBe("core.party");
    expect(screen.getByText("1 válida")).toBeTruthy();
    expect(screen.getByText("1 con errores")).toBeTruthy();
    // One line per row: the pill carries the reason as a tooltip; the text itself opens with "Ver".
    expect(screen.getByText("Fila con error").getAttribute("title")).toBe("31: solo dígitos");
    expect(screen.queryByText("31: solo dígitos")).toBeNull();
    expect(screen.getByText("Columnas que no se importan: Canal")).toBeTruthy();
    expect(run.disabled).toBe(false);
  });

  it("asks for the step-up code when the import is sensitive, then starts it with the token", async () => {
    const modes: { mode: string; token: string | null }[] = [];
    const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const form = init!.body as FormData;
      const mode = String(form.get("mode"));
      modes.push({ mode, token: (form.get("stepUpToken") as string | null) ?? null });
      if (mode === "preview") return json(preview);
      return form.get("stepUpToken") ? json({ importId: "imp-1" }, 202) : json({ code: "step_up_required", details: null }, 401);
    });
    const requestStepUp = vi.fn(async () => ({ token: "tok-1" }));
    const onStarted = vi.fn();
    renderEs(
      <ImportDialog open onOpenChange={() => {}} entity="core.party" entityLabel="Terceros" fetcher={fetcher as unknown as typeof fetch} requestStepUp={requestStepUp} onStarted={onStarted} />,
    );
    fireEvent.drop(screen.getByTestId("import-drop"), { dataTransfer: { files: [csvFile()] } });
    await screen.findByText("1 válida");
    fireEvent.click(screen.getByRole("button", { name: "Importar filas válidas" }));
    const code = await screen.findByLabelText("Código de 6 dígitos");
    fireEvent.change(code, { target: { value: "123456" } });
    fireEvent.click(screen.getByRole("button", { name: "Verificar" }));
    await screen.findByText("Importación en curso", { exact: false });
    expect(requestStepUp).toHaveBeenCalledWith("123456");
    expect(onStarted).toHaveBeenCalledWith("imp-1");
    expect(modes).toEqual([
      { mode: "preview", token: null },
      { mode: "run", token: null },
      { mode: "run", token: "tok-1" },
    ]);
  });

  it("refuses a file that is not .xlsx or .csv without sending it, and shows a refused preview's reason", async () => {
    const fetcher = vi.fn(async () => json({ code: "invalid_input", details: ["El archivo está vacío"] }, 400));
    renderEs(<ImportDialog open onOpenChange={() => {}} entity="core.party" entityLabel="Terceros" fetcher={fetcher as unknown as typeof fetch} />);
    fireEvent.drop(screen.getByTestId("import-drop"), { dataTransfer: { files: [new File(["x"], "foto.pdf")] } });
    expect(await screen.findByText("El archivo debe ser .xlsx o .csv")).toBeTruthy();
    expect(fetcher).not.toHaveBeenCalled();
    fireEvent.drop(screen.getByTestId("import-drop"), { dataTransfer: { files: [csvFile("vacio.csv")] } });
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("El archivo está vacío"));
  });

  describe("errors-only preview", () => {
    const many: ImportPreviewData = {
      ...preview,
      total: 5,
      rows: [
        { rowNo: 2, ok: true, errors: [], cells: ["customer", "900373115"] },
        { rowNo: 3, ok: false, errors: ["31: solo dígitos", "municipio: código DANE desconocido"], cells: ["customer", "800ABC123"] },
        { rowNo: 4, ok: true, errors: [], cells: ["customer", "800197268"] },
        { rowNo: 5, ok: true, errors: [], cells: ["supplier", "900555666"] },
        { rowNo: 6, ok: false, errors: ["correo inválido"], cells: ["supplier", "900111222"] },
      ],
    };
    const open = async (data: ImportPreviewData) => {
      const fetcher = vi.fn(async () => json(data));
      renderEs(<ImportDialog open onOpenChange={() => {}} entity="core.party" entityLabel="Terceros" fetcher={fetcher as unknown as typeof fetch} />);
      fireEvent.drop(screen.getByTestId("import-drop"), { dataTransfer: { files: [csvFile()] } });
      await screen.findByText("Vista previa", { exact: false });
    };
    const rowNumbers = () => [...document.querySelectorAll("tbody tr[data-row]")].map((tr) => tr.getAttribute("data-row"));

    it("offers 'Solo filas con error (N)', off by default; turning it on lists only the refused rows with their original numbers", async () => {
      await open(many);
      const toggle = screen.getByRole("checkbox", { name: "Solo filas con error (2)" }) as HTMLInputElement;
      expect(toggle.checked).toBe(false);
      expect(toggle.disabled).toBe(false);
      expect(rowNumbers()).toEqual(["2", "3", "4", "5", "6"]);
      fireEvent.click(toggle);
      expect(rowNumbers()).toEqual(["3", "6"]);
      expect(screen.getByText("6").closest("td")!.className).toContain("erp-num");
      fireEvent.click(toggle);
      expect(rowNumbers()).toEqual(["2", "3", "4", "5", "6"]);
    });

    it("is disabled when no row has an error", async () => {
      await open({ ...preview, total: 1, rows: [preview.rows[0]!] });
      const toggle = screen.getByRole("checkbox", { name: "Solo filas con error (0)" }) as HTMLInputElement;
      expect(toggle.disabled).toBe(true);
      expect(toggle.checked).toBe(false);
    });

    it("keeps every row one line: the reasons are a tooltip and behind a 'Ver' disclosure that opens one extra row", async () => {
      await open(many);
      const bad = screen.getAllByText("Fila con error");
      expect(bad).toHaveLength(2);
      expect(bad[0]!.getAttribute("title")).toBe("31: solo dígitos · municipio: código DANE desconocido");
      expect(screen.queryByText("municipio: código DANE desconocido")).toBeNull();

      const [first, second] = screen.getAllByRole("button", { name: /^Ver/ });
      expect(first!.getAttribute("aria-expanded")).toBe("false");
      // Closed, each disclosure's panel is in the document (aria-controls resolves) but hidden.
      for (const button of [first!, second!]) {
        const panel = document.getElementById(button.getAttribute("aria-controls")!);
        expect(panel).not.toBeNull();
        expect(panel!.hidden).toBe(true);
      }
      const shownRows = () => document.querySelectorAll("tbody tr:not([hidden])").length;
      const before = shownRows();
      fireEvent.click(first!);
      expect(first!.getAttribute("aria-expanded")).toBe("true");
      expect(shownRows()).toBe(before + 1);
      const reasons = screen.getByRole("list", { name: /Errores de la fila 3/ });
      expect([...reasons.querySelectorAll("li")].map((li) => li.textContent)).toEqual(["31: solo dígitos", "municipio: código DANE desconocido"]);
      // The panel is the disclosure's target, and the other row stays closed.
      expect(first!.getAttribute("aria-controls")).toBe(reasons.closest("tr")!.id);
      expect(second!.getAttribute("aria-expanded")).toBe("false");
      expect(screen.queryByText("correo inválido")).toBeNull();

      fireEvent.click(first!);
      expect(first!.getAttribute("aria-expanded")).toBe("false");
      expect(shownRows()).toBe(before);
      expect(document.getElementById(first!.getAttribute("aria-controls")!)!.hidden).toBe(true);
    });

    it("lists a row's reasons by position: two that read the same both show", async () => {
      const twice = { ...many, rows: many.rows.map((row) => (row.ok ? row : { ...row, errors: ["correo inválido", "correo inválido"] })) };
      await open(twice);
      const [first] = screen.getAllByRole("button", { name: /^Ver/ });
      fireEvent.click(first!);
      const reasons = screen.getByRole("list", { name: /Errores de la fila/ });
      expect([...reasons.querySelectorAll("li")].map((li) => li.textContent)).toEqual(["correo inválido", "correo inválido"]);
    });

    it("the disclosure is a real button: reachable by keyboard (not removed from the tab order)", async () => {
      await open(many);
      const button = screen.getAllByRole("button", { name: /^Ver/ })[0]! as HTMLButtonElement;
      expect(button.tagName).toBe("BUTTON");
      expect(button.type).toBe("button");
      expect(button.tabIndex).toBe(0);
    });

    it("a new file starts again with the toggle off", async () => {
      const fetcher = vi.fn(async () => json(many));
      renderEs(<ImportDialog open onOpenChange={() => {}} entity="core.party" entityLabel="Terceros" fetcher={fetcher as unknown as typeof fetch} />);
      fireEvent.drop(screen.getByTestId("import-drop"), { dataTransfer: { files: [csvFile()] } });
      fireEvent.click(await screen.findByRole("checkbox", { name: "Solo filas con error (2)" }));
      expect(rowNumbers()).toEqual(["3", "6"]);
      fireEvent.drop(screen.getByTestId("import-drop"), { dataTransfer: { files: [csvFile("otro.csv")] } });
      await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
      await waitFor(() => expect((screen.getByRole("checkbox", { name: /Solo filas con error/ }) as HTMLInputElement).checked).toBe(false));
    });
  });
});

describe("ImportDialog for a documento (Task 15)", () => {
  it("offers only the Excel template", () => {
    renderEs(<ImportDialog open onOpenChange={() => {}} entity="accounting.entry" entityLabel="Comprobantes" xlsxOnly fetcher={vi.fn() as unknown as typeof fetch} />);
    expect(screen.getByText("Plantilla Excel")).toBeTruthy();
    expect(screen.queryByText("Plantilla CSV")).toBeNull();
  });

  it("names only .xlsx in the file hint and the template help (no CSV for a documento)", () => {
    renderEs(<ImportDialog open onOpenChange={() => {}} entity="accounting.entry" entityLabel="Comprobantes" xlsxOnly fetcher={vi.fn() as unknown as typeof fetch} />);
    expect(screen.queryByText(/\.csv/)).toBeNull();
    expect(document.body.textContent).not.toMatch(/CSV separado/);
    expect(document.body.textContent).toMatch(/hoja Líneas/);
  });

  it("shows each comprobante's lines in the preview", async () => {
    const entry: ImportPreviewData = {
      entity: "accounting.entry",
      fileName: "c.xlsx",
      headers: ["ref", "Fecha"],
      unknownHeaders: [],
      missingColumns: [],
      total: 1,
      rows: [{ rowNo: 2, ok: true, errors: [], cells: ["1", "2026-11-02"], lines: [{ rowNo: 2, cells: ["110505", "10000", "0"] }, { rowNo: 3, cells: ["310505", "0", "10000"] }], lineHeaders: ["Cuenta", "Débito", "Crédito"] }],
    };
    const fetcher = vi.fn(async () => json(entry));
    renderEs(<ImportDialog open onOpenChange={() => {}} entity="accounting.entry" entityLabel="Comprobantes" xlsxOnly fetcher={fetcher as unknown as typeof fetch} />);
    fireEvent.drop(screen.getByTestId("import-drop"), { dataTransfer: { files: [new File(["x"], "c.xlsx")] } });
    await waitFor(() => expect(screen.getByText("2 líneas")).toBeTruthy());
    expect(screen.getByText("310505")).toBeTruthy();
  });
});
