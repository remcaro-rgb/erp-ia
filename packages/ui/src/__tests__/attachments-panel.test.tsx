// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { AttachmentsPanel, type AttachmentItem, type RequiredTag } from "../index";

afterEach(cleanup);

const required: RequiredTag[] = [
  { tag: "RUT", kind: "pdf", required: true, description: "Registro Único Tributario vigente" },
  { tag: "Cámara de Comercio", kind: "pdf", required: true },
  { tag: "Certificación bancaria", kind: "pdf", required: false },
];

const stored = (tag: string, fileName = `${tag}.pdf`, id = fileName): AttachmentItem => ({
  id,
  tag,
  fileName,
  mimeType: "application/pdf",
  sizeBytes: 184320,
  uploadedBy: "u1",
  uploadedByName: "Ana Gómez",
  uploadedAt: "2026-10-28T10:30:00.000Z",
});

const pdf = (name: string, size = 1024, type = "application/pdf") => {
  const file = new File(["x"], name, { type });
  Object.defineProperty(file, "size", { value: size });
  return file;
};

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const drop = (zone: Element, files: File[]) => fireEvent.drop(zone, { dataTransfer: { files } });
const dropZone = () => screen.getByText("Arrastra los archivos aquí").closest(".erp-attachments__drop")!;

describe("AttachmentsPanel", () => {
  it("shows the required files with cargado / obligatorio / opcional and the invoice warning", () => {
    render(<AttachmentsPanel entity="core.party" recordId="p1" requiredTags={required} initialAttachments={[stored("RUT")]} />);
    const items = screen.getAllByRole("listitem");
    expect(within(items[0]!).getByText("cargado")).toBeTruthy();
    expect(within(items[1]!).getByText("obligatorio")).toBeTruthy();
    expect(within(items[2]!).getByText("opcional")).toBeTruthy();
    expect(screen.getByText("Mientras falten Cámara de Comercio el registro no se puede usar en facturas.")).toBeTruthy();
    expect(screen.getByText("Registro Único Tributario vigente", { exact: false })).toBeTruthy();
  });

  it("asks to save the record first, and hides the drop zone and remove buttons when read-only", () => {
    const { unmount } = render(<AttachmentsPanel entity="core.party" recordId={null} />);
    expect(screen.getByText("Guarda el registro para adjuntar archivos")).toBeTruthy();
    expect(screen.queryByText("Arrastra los archivos aquí")).toBeNull();
    unmount();
    render(<AttachmentsPanel entity="core.party" recordId="p1" readOnly initialAttachments={[stored("RUT")]} />);
    expect(screen.queryByText("Arrastra los archivos aquí")).toBeNull();
    expect(screen.queryByLabelText("Quitar RUT.pdf")).toBeNull();
    expect(screen.getByText("Descargar")).toBeTruthy();
  });

  it("stages dropped files, asks a tag for each, offers defined tags and free text, and uploads once every file has one", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const fetcher = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      const form = init?.body as FormData;
      return json({ ...stored(String(form.get("tag")), (form.get("file") as File).name), id: `new-${calls.length}` }, 201);
    }) as unknown as typeof fetch;
    const onChange = vi.fn();
    render(<AttachmentsPanel entity="core.party" recordId="p1" requiredTags={required} initialAttachments={[]} fetcher={fetcher} onChange={onChange} />);

    drop(dropZone(), [pdf("RUT-2026.pdf"), pdf("contrato.pdf")]);
    expect(screen.getByText("Cada archivo necesita una etiqueta")).toBeTruthy();
    const upload = screen.getByRole("button", { name: "Subir 2 archivos" }) as HTMLButtonElement;
    expect(upload.disabled).toBe(true);
    // RUT-2026.pdf was recognised by its name; contrato.pdf needs a tag, here a free one.
    const selects = screen.getAllByRole("combobox") as HTMLSelectElement[];
    expect(selects[0]!.value).toBe("RUT");
    expect(Array.from(selects[1]!.options).map((o) => o.text)).toEqual(["Etiqueta…", "RUT", "Cámara de Comercio", "Certificación bancaria", "Otra…"]);
    fireEvent.change(selects[1]!, { target: { value: "__other__" } });
    expect(upload.disabled).toBe(true);
    fireEvent.change(screen.getByPlaceholderText("nombre de la etiqueta"), { target: { value: "Contrato marco" } });
    expect(screen.getByText("Listo para subir")).toBeTruthy();
    expect(upload.disabled).toBe(false);

    fireEvent.click(upload);
    await waitFor(() => expect(onChange).toHaveBeenCalled());
    expect(calls).toHaveLength(2);
    expect(calls[0]!.url).toBe("/api/attachments");
    expect(calls[0]!.init?.method).toBe("POST");
    const sent = calls.map((c) => Object.fromEntries((c.init!.body as FormData).entries()));
    expect(sent.map((f) => [f.entity, f.recordId, f.tag, (f.file as File).name])).toEqual([
      ["core.party", "p1", "RUT", "RUT-2026.pdf"],
      ["core.party", "p1", "Contrato marco", "contrato.pdf"],
    ]);
    expect(onChange.mock.calls[0]![0]).toHaveLength(2);
    expect(screen.queryByText("Por subir · asigna la etiqueta de cada archivo")).toBeNull();
    expect(screen.getByText("contrato.pdf", { exact: false })).toBeTruthy();
  });

  it("blocks a file over 25 MB, a duplicate name and a type the tag does not accept", () => {
    render(<AttachmentsPanel entity="core.party" recordId="p1" requiredTags={required} initialAttachments={[stored("RUT")]} />);
    drop(dropZone(), [pdf("enorme.pdf", 26 * 1024 * 1024), pdf("rut.pdf")]);
    expect(screen.getByRole("status").textContent).toBe("enorme.pdf supera 25 MB · rut.pdf ya está adjunto");
    expect(screen.queryByText("Por subir · asigna la etiqueta de cada archivo")).toBeNull();

    drop(dropZone(), [pdf("foto.png", 2048, "image/png")]);
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "Cámara de Comercio" } });
    expect(screen.getByRole("alert").textContent).toBe("La etiqueta Cámara de Comercio exige un archivo PDF");
    expect((screen.getByRole("button", { name: "Subir 1 archivo" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("keeps a file that the server refused in the list with the reason, and uploads nothing else", async () => {
    const fetcher = vi.fn(async () => json({ code: "invalid_input", details: ["Ya existe un archivo x.pdf en este registro"] }, 400)) as unknown as typeof fetch;
    render(<AttachmentsPanel entity="core.party" recordId="p1" initialAttachments={[]} fetcher={fetcher} />);
    drop(dropZone(), [pdf("x.pdf")]);
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "__other__" } });
    fireEvent.change(screen.getByPlaceholderText("nombre de la etiqueta"), { target: { value: "Otro" } });
    fireEvent.click(screen.getByRole("button", { name: "Subir 1 archivo" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("No se pudo subir x.pdf: Ya existe un archivo x.pdf en este registro"));
    expect(screen.getByRole("button", { name: "Subir 1 archivo" })).toBeTruthy();
  });

  it("removing asks for confirmation inline, and only a yes calls DELETE", async () => {
    const fetcher = vi.fn(async () => json({ id: "RUT.pdf" })) as unknown as typeof fetch;
    const onChange = vi.fn();
    render(<AttachmentsPanel entity="core.party" recordId="p1" initialAttachments={[stored("RUT")]} fetcher={fetcher} onChange={onChange} />);
    fireEvent.click(screen.getByLabelText("Quitar RUT.pdf"));
    expect(screen.getByText("¿Quitar RUT.pdf (RUT)? Deja de estar disponible pero queda en auditoría.")).toBeTruthy();
    fireEvent.click(screen.getByText("No"));
    expect(fetcher).not.toHaveBeenCalled();
    expect(screen.getByText("RUT.pdf", { exact: false })).toBeTruthy();

    fireEvent.click(screen.getByLabelText("Quitar RUT.pdf"));
    fireEvent.click(screen.getByText("Sí, quitar"));
    await waitFor(() => expect(onChange).toHaveBeenCalledWith([]));
    expect(fetcher).toHaveBeenCalledWith("/api/attachments?id=RUT.pdf", { method: "DELETE" });
    expect(screen.getByText("Sin archivos todavía.")).toBeTruthy();
  });

  it("loads the record's files when none are given, and asks for a signed link on download", async () => {
    const opened: string[] = [];
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      opened.push(this.href);
    });
    const fetcher = vi.fn(async (url: RequestInfo | URL) =>
      String(url).includes("entity=") ? json([stored("RUT")]) : json({ url: "http://storage/signed?token=abc", fileName: "RUT.pdf", expiresIn: 60 }),
    ) as unknown as typeof fetch;
    render(<AttachmentsPanel entity="core.party" recordId="p1" fetcher={fetcher} />);
    await screen.findByText("RUT.pdf", { exact: false });
    expect(fetcher).toHaveBeenCalledWith("/api/attachments?entity=core.party&recordId=p1");
    fireEvent.click(screen.getByText("Descargar"));
    await waitFor(() => expect(opened).toEqual(["http://storage/signed?token=abc"]));
    expect(fetcher).toHaveBeenLastCalledWith("/api/attachments?id=RUT.pdf");
    click.mockRestore();
  });
});
