// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createTranslator } from "next-intl";
import { messages } from "@erp/i18n";
import { AttachmentsPanel, PhotosTab, attachmentsLabels, type AttachmentItem, type AttachmentsTranslator } from "../index";
import { CellFormatProvider } from "../grid/cell-format";
import { ImportDialog } from "../import/ImportDialog";
import { renderEs, stubLayoutApis } from "../shell/__tests__/intl";

// UI density audit quick wins 1 (H1) and 12 (M14): every file chooser is a real button that Tab reaches and Enter
// opens, and the Archivos tab speaks the user's language, joins lists the locale's way and shows times in the
// company's zone.

beforeAll(stubLayoutApis);
afterEach(cleanup);

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const stored: AttachmentItem = {
  id: "a1",
  tag: "RUT",
  fileName: "rut.pdf",
  mimeType: "application/pdf",
  sizeBytes: 2048,
  uploadedBy: "u1",
  uploadedByName: "Ana Gómez",
  uploadedAt: "2026-10-28T15:04:00.000Z",
};

/** The chooser button opens the hidden input, which no label wraps and Tab skips. */
async function expectChooserButton(name: string) {
  const user = userEvent.setup();
  const button = screen.getByRole("button", { name });
  const input = document.querySelector<HTMLInputElement>("input[type=file]")!;
  expect(input.closest("label")).toBeNull();
  expect(input.tabIndex).toBe(-1);
  const click = vi.spyOn(input, "click");
  button.focus();
  expect(document.activeElement).toBe(button);
  await user.keyboard("{Enter}");
  expect(click).toHaveBeenCalledTimes(1);
  await user.keyboard(" ");
  expect(click).toHaveBeenCalledTimes(2);
}

describe("file choosers", () => {
  it("Archivos: elígelos is a button", async () => {
    render(<AttachmentsPanel entity="core.party" recordId="p1" initialAttachments={[]} />);
    await expectChooserButton("elígelos");
  });

  it("Fotos: the chooser is a button", async () => {
    const fetcher = vi.fn(async () => json([]));
    render(<PhotosTab entity="core.product" recordId="p1" fetcher={fetcher as unknown as typeof fetch} />);
    await expectChooserButton("elígelas");
  });

  it("Importar: the chooser is a button", async () => {
    renderEs(<ImportDialog open onOpenChange={() => {}} entity="core.party" entityLabel="Terceros" fetcher={vi.fn() as unknown as typeof fetch} />);
    await expectChooserButton("elige el archivo");
  });
});

describe("Archivos tab copy and time", () => {
  it("shows the upload time in the company's zone, not a UTC slice", () => {
    render(
      <CellFormatProvider timeZone="America/Bogota">
        <AttachmentsPanel entity="core.party" recordId="p1" initialAttachments={[stored]} />
      </CellFormatProvider>,
    );
    const expected = new Intl.DateTimeFormat("es-CO", { dateStyle: "short", timeStyle: "short", timeZone: "America/Bogota" }).format(new Date(stored.uploadedAt));
    const time = document.querySelector("time")!;
    expect(time.getAttribute("datetime")).toBe(stored.uploadedAt);
    expect(time.textContent).toBe(expected);
    expect(document.body.textContent).not.toContain("2026-10-28 15:04");
  });

  it("builds the labels from common.attachments in either language, lists joined the locale's way", () => {
    const translator = (locale: "en" | "es-419") => createTranslator({ locale, messages: messages(locale), namespace: "common.attachments" }) as unknown as AttachmentsTranslator;
    const en = attachmentsLabels(translator("en"), "en");
    expect(en.choose).toBe("choose them");
    expect(en.missing(["RUT", "Chamber of commerce"])).toContain("RUT and Chamber of commerce");
    expect(en.upload(2)).toBe("Upload 2 files");
    const es = attachmentsLabels(translator("es-419"), "es-419");
    expect(es.missing(["RUT", "Cámara", "Banco"])).toBe("Mientras falten RUT, Cámara y Banco el registro no se puede usar en facturas.");
    expect(es.confirmRemove("rut.pdf", "RUT")).toBe("¿Quitar rut.pdf (RUT)? Deja de estar disponible pero queda en auditoría.");
    expect(es.wrongKind("RUT", "pdf")).toBe("La etiqueta RUT exige un archivo PDF");
    // A refusal code is read through the caller's translator when it has one.
    const withReasons = attachmentsLabels(translator("es-419"), "es-419", (code) => (code === "file_too_large" ? "el archivo es muy grande" : code));
    expect(withReasons.failed("a.pdf", "file_too_large")).toBe("No se pudo subir a.pdf: el archivo es muy grande");
  });

  // Branch review fix 9: an engine without Intl.ListFormat still lists the tags.
  it("joins the tags with commas where Intl.ListFormat is missing", () => {
    const original = Intl.ListFormat;
    // @ts-expect-error simulating an engine without it
    delete Intl.ListFormat;
    try {
      const translator = createTranslator({ locale: "es-419", messages: messages("es-419"), namespace: "common.attachments" }) as unknown as AttachmentsTranslator;
      expect(attachmentsLabels(translator, "es-419").missing(["RUT", "Cámara"])).toBe("Mientras falten RUT, Cámara el registro no se puede usar en facturas.");
    } finally {
      Object.defineProperty(Intl, "ListFormat", { value: original, configurable: true, writable: true });
    }
  });
});
