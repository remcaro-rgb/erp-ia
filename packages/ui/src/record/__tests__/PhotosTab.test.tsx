// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { PhotosTab, isPhoto, type AttachmentItem } from "../../index";

afterEach(cleanup);

const item = (id: string, tag: string, mimeType = "image/jpeg", fileName = `${id}.jpg`): AttachmentItem => ({
  id,
  tag,
  fileName,
  mimeType,
  sizeBytes: 2048,
  uploadedBy: "u1",
  uploadedByName: "Ana Gómez",
  uploadedAt: "2026-10-28T10:30:00.000Z",
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** An in-memory /api/attachments: list, signed link, upload and removal. */
function api(initial: AttachmentItem[]) {
  let items = [...initial];
  const calls: { method: string; url: string; body?: FormData }[] = [];
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://x");
    const method = init?.method ?? "GET";
    calls.push({ method, url: url.pathname + url.search, body: init?.body as FormData | undefined });
    if (method === "POST") {
      const form = init!.body as FormData;
      const file = form.get("file") as File;
      const created = item(`n${items.length}`, String(form.get("tag")), file.type, file.name);
      items = [...items, created];
      return json(created, 201);
    }
    if (method === "DELETE") {
      items = items.filter((i) => i.id !== url.searchParams.get("id"));
      return json({ id: url.searchParams.get("id") });
    }
    if (url.searchParams.has("id")) return json({ url: `https://files.test/${url.searchParams.get("id")}?sig=1`, fileName: "x", expiresIn: 60 });
    return json(items);
  });
  return { fetcher: fetcher as unknown as typeof fetch, calls, setItems: (next: AttachmentItem[]) => (items = next) };
}

const photo = (src: string) => screen.getAllByRole("img").find((i) => i.getAttribute("src")?.includes(src));

describe("PhotosTab", () => {
  it("loads the record's photos (attachments tagged Foto, images only) as a carousel with thumbnails", async () => {
    const { fetcher } = api([item("a", "Foto"), item("b", "Foto · IA"), item("c", "RUT", "application/pdf", "rut.pdf"), item("d", "Foto", "application/pdf", "mal.pdf")]);
    render(<PhotosTab entity="core.product" recordId="p1" fetcher={fetcher} />);
    await waitFor(() => expect(photo("files.test/a")).toBeTruthy());
    expect(screen.getByText(/principal · subida/)).toBeTruthy();
    expect(screen.getAllByRole("img")).toHaveLength(3); // the large one and two thumbnails
    fireEvent.click(screen.getByRole("button", { name: "Siguiente" }));
    expect(screen.getByText(/sugerida por IA ·/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Siguiente" }));
    expect(screen.getByText(/principal · subida/)).toBeTruthy();
  });

  it("says so when there are no photos and asks to save the product first when it is new", async () => {
    const { fetcher } = api([]);
    const { rerender } = render(<PhotosTab entity="core.product" recordId="p1" fetcher={fetcher} />);
    expect(await screen.findByText("Sin fotos todavía")).toBeTruthy();
    rerender(<PhotosTab entity="core.product" recordId={null} fetcher={fetcher} />);
    expect(screen.getByText("Guarda el producto para agregar fotos")).toBeTruthy();
  });

  it("uploads images tagged Foto and refuses other files", async () => {
    const { fetcher, calls } = api([]);
    render(<PhotosTab entity="core.product" recordId="p1" fetcher={fetcher} />);
    await screen.findByText("Sin fotos todavía");
    const zone = screen.getByText("Arrastra fotos aquí").closest(".erp-photos__drop")!;
    const png = new File(["x"], "taza.png", { type: "image/png" });
    const pdf = new File(["x"], "ficha.pdf", { type: "application/pdf" });
    const huge = new File(["x"], "enorme.jpg", { type: "image/jpeg" });
    Object.defineProperty(huge, "size", { value: 26 * 1024 * 1024 });
    fireEvent.drop(zone, { dataTransfer: { files: [png, pdf, huge] } });
    await waitFor(() => expect(photo("files.test/n0")).toBeTruthy());
    const posts = calls.filter((c) => c.method === "POST");
    expect(posts).toHaveLength(1);
    expect(posts[0]!.body!.get("tag")).toBe("Foto");
    expect(posts[0]!.body!.get("entity")).toBe("core.product");
    expect(posts[0]!.body!.get("recordId")).toBe("p1");
    expect((posts[0]!.body!.get("file") as File).name).toBe("taza.png");
    expect(screen.getByRole("status").textContent).toBe("ficha.pdf no es una imagen · enorme.jpg supera 25 MB");
  });

  it("asks for confirmation before removing a photo", async () => {
    const { fetcher, calls } = api([item("a", "Foto"), item("b", "Foto")]);
    render(<PhotosTab entity="core.product" recordId="p1" fetcher={fetcher} />);
    await waitFor(() => expect(photo("files.test/a")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Quitar" }));
    expect(screen.getByText("¿Quitar esta foto?")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "No" }));
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Quitar" }));
    fireEvent.click(screen.getByRole("button", { name: "Sí" }));
    await waitFor(() => expect(calls.some((c) => c.method === "DELETE" && c.url === "/api/attachments?id=a")).toBe(true));
    await waitFor(() => expect(screen.getAllByRole("img")).toHaveLength(2));
  });

  it("Sugerir foto con IA calls onSuggest and shows what it stored", async () => {
    const harness = api([]);
    const onSuggest = vi.fn(async () => {
      harness.setItems([item("ia", "Foto · IA")]);
    });
    render(<PhotosTab entity="core.product" recordId="p1" fetcher={harness.fetcher} onSuggest={onSuggest} />);
    await screen.findByText("Sin fotos todavía");
    fireEvent.click(screen.getByRole("button", { name: "✨ Sugerir foto con IA" }));
    await waitFor(() => expect(onSuggest).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByText(/sugerida por IA ·/)).toBeTruthy());
  });

  it("Hacer principal moves the chosen photo first through onReorder", async () => {
    const { fetcher } = api([item("a", "Foto"), item("b", "Foto"), item("c", "Foto")]);
    const onReorder = vi.fn(async () => {});
    render(<PhotosTab entity="core.product" recordId="p1" fetcher={fetcher} onReorder={onReorder} />);
    await waitFor(() => expect(photo("files.test/a")).toBeTruthy());
    // The principal photo has nothing to promote.
    expect(screen.queryByRole("button", { name: "Hacer principal" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Siguiente" }));
    fireEvent.click(screen.getByRole("button", { name: "Siguiente" }));
    fireEvent.click(screen.getByRole("button", { name: "Hacer principal" }));
    await waitFor(() => expect(onReorder).toHaveBeenCalledWith(["c", "a", "b"]));
    await waitFor(() => expect(screen.getByText(/principal · subida/)).toBeTruthy());
    expect(photo("files.test/c")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Hacer principal" })).toBeNull();
  });

  it("keeps the order and says why when onReorder fails", async () => {
    const { fetcher } = api([item("a", "Foto"), item("b", "Foto")]);
    render(<PhotosTab entity="core.product" recordId="p1" fetcher={fetcher} onReorder={async () => { throw new Error("sin permiso"); }} />);
    await waitFor(() => expect(photo("files.test/a")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Siguiente" }));
    fireEvent.click(screen.getByRole("button", { name: "Hacer principal" }));
    expect((await screen.findByRole("status")).textContent).toBe("No se pudo completar la acción: sin permiso");
    expect(screen.getByRole("button", { name: "Hacer principal" })).toBeTruthy();
  });

  it("the stored `suggested` flag decides: a Foto · IA photo the user approved is no longer shown as a suggestion", async () => {
    const { fetcher } = api([{ ...item("a", "Foto · IA"), suggested: false }, { ...item("b", "Foto"), suggested: true }]);
    render(<PhotosTab entity="core.product" recordId="p1" fetcher={fetcher} />);
    await waitFor(() => expect(photo("files.test/a")).toBeTruthy());
    expect(screen.getByText(/principal · subida/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Siguiente" }));
    expect(screen.getByText(/sugerida por IA ·/)).toBeTruthy();
  });

  it("making a suggested photo principal approves it: the badge stops saying it is a suggestion", async () => {
    const { fetcher } = api([{ ...item("a", "Foto"), suggested: false }, { ...item("b", "Foto · IA"), suggested: true }]);
    render(<PhotosTab entity="core.product" recordId="p1" fetcher={fetcher} onReorder={async () => {}} />);
    await waitFor(() => expect(photo("files.test/a")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Siguiente" }));
    expect(screen.getByText(/sugerida por IA ·/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Hacer principal" }));
    await waitFor(() => expect(screen.getByText(/principal · subida/)).toBeTruthy());
    expect(screen.queryByText(/sugerida por IA/)).toBeNull();
  });

  it("has no suggest button without onSuggest, and no upload or removal when read-only", async () => {
    const { fetcher } = api([item("a", "Foto")]);
    render(<PhotosTab entity="core.product" recordId="p1" fetcher={fetcher} readOnly onSuggest={async () => {}} />);
    await waitFor(() => expect(photo("files.test/a")).toBeTruthy());
    expect(screen.queryByRole("button", { name: "✨ Sugerir foto con IA" })).toBeNull();
    expect(screen.queryByText("Arrastra fotos aquí")).toBeNull();
    expect(screen.queryByRole("button", { name: "Quitar" })).toBeNull();
  });
});

describe("PhotosTab onChange", () => {
  it("fires after an upload, a removal, making a photo principal and a suggestion, so the page can refresh", async () => {
    const harness = api([item("a", "Foto"), item("b", "Foto")]);
    const onChange = vi.fn();
    render(
      <PhotosTab
        entity="core.product"
        recordId="p1"
        fetcher={harness.fetcher}
        onChange={onChange}
        onReorder={async () => {}}
        onSuggest={async () => {
          harness.setItems([item("a", "Foto"), item("b", "Foto"), item("ia", "Foto · IA")]);
        }}
      />,
    );
    await waitFor(() => expect(photo("files.test/a")).toBeTruthy());
    expect(onChange).not.toHaveBeenCalled();

    const zone = screen.getByText("Arrastra fotos aquí").closest(".erp-photos__drop")!;
    fireEvent.drop(zone, { dataTransfer: { files: [new File(["x"], "taza.png", { type: "image/png" })] } });
    await waitFor(() => expect(onChange).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole("button", { name: "Hacer principal" }));
    await waitFor(() => expect(onChange).toHaveBeenCalledTimes(2));

    fireEvent.click(screen.getByRole("button", { name: "✨ Sugerir foto con IA" }));
    await waitFor(() => expect(onChange).toHaveBeenCalledTimes(3));

    fireEvent.click(screen.getByRole("button", { name: "Quitar" }));
    fireEvent.click(screen.getByRole("button", { name: "Sí" }));
    await waitFor(() => expect(onChange).toHaveBeenCalledTimes(4));
  });

  it("does not fire when the action failed", async () => {
    const { fetcher } = api([item("a", "Foto"), item("b", "Foto")]);
    const onChange = vi.fn();
    render(<PhotosTab entity="core.product" recordId="p1" fetcher={fetcher} onChange={onChange} onReorder={async () => { throw new Error("no"); }} />);
    await waitFor(() => expect(photo("files.test/a")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Siguiente" }));
    fireEvent.click(screen.getByRole("button", { name: "Hacer principal" }));
    await screen.findByRole("status");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("canRemove=false hides the Quitar button but keeps the rest", async () => {
    const { fetcher } = api([item("a", "Foto"), item("b", "Foto")]);
    render(<PhotosTab entity="core.product" recordId="p1" fetcher={fetcher} canRemove={false} onReorder={async () => {}} />);
    await waitFor(() => expect(photo("files.test/a")).toBeTruthy());
    expect(screen.queryByRole("button", { name: "Quitar" })).toBeNull();
    expect(screen.getByText("Arrastra fotos aquí")).toBeTruthy();
  });
});

describe("isPhoto", () => {
  it("is an image tagged Foto or Foto · IA, in any case", () => {
    expect(isPhoto(item("a", "Foto"))).toBe(true);
    expect(isPhoto(item("a", " foto · ia "))).toBe(true);
    expect(isPhoto(item("a", "Foto", "application/pdf"))).toBe(false);
    expect(isPhoto(item("a", "Fotocopia"))).toBe(false);
    expect(isPhoto(item("a", "RUT"))).toBe(false);
  });
});
