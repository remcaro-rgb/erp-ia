import { describe, it, expect } from "vitest";
import {
  DEFAULT_LABELS,
  TAG_OTHER,
  definedTags,
  formatSize,
  guessTag,
  isLoaded,
  kindFits,
  missingTags,
  stagedProblem,
  type AttachmentItem,
  type RequiredTag,
} from "../attachments-model";

const item = (tag: string, mimeType = "application/pdf", fileName = `${tag}.pdf`): AttachmentItem => ({
  id: fileName,
  tag,
  fileName,
  mimeType,
  sizeBytes: 1024,
  uploadedBy: null,
  uploadedAt: "2026-10-28T10:00:00.000Z",
});

const defs: RequiredTag[] = [
  { tag: "RUT", kind: "pdf", required: true },
  { tag: "Cámara de Comercio", kind: "pdf", required: true },
  { tag: "Certificación bancaria", kind: "pdf", required: false },
  { tag: "Fachada", kind: "image", required: false },
];

describe("attachments model", () => {
  it("a required file counts as loaded only with its tag (any case) and a fitting type", () => {
    expect(isLoaded(defs[0]!, [item("rut")])).toBe(true);
    expect(isLoaded(defs[0]!, [item("RUT", "image/png", "rut.png")])).toBe(false);
    expect(isLoaded(defs[3]!, [item("Fachada", "image/jpeg", "f.jpg")])).toBe(true);
    expect(kindFits("any", "application/zip")).toBe(true);
  });

  it("lists the mandatory tags still missing, and none when everything mandatory is there", () => {
    expect(missingTags(defs, [item("RUT")])).toEqual(["Cámara de Comercio"]);
    expect(missingTags(defs, [item("RUT"), item("Cámara de Comercio")])).toEqual([]);
    expect(DEFAULT_LABELS.missing(["RUT", "Cámara de Comercio"])).toBe("Mientras falten RUT y Cámara de Comercio el registro no se puede usar en facturas.");
  });

  it("guesses the tag from the file name for a mandatory file not loaded yet", () => {
    expect(guessTag("RUT-2026.pdf", defs, [])).toBe("RUT");
    expect(guessTag("camara.pdf", defs, [])).toBe("");
    expect(guessTag("Cámara de comercio.pdf", defs, [])).toBe("Cámara de Comercio");
    expect(guessTag("RUT-2026.pdf", defs, [item("RUT")])).toBe("");
  });

  it("offers each defined tag once", () => {
    expect(definedTags([...defs, { tag: "rut", kind: "any", required: false }])).toEqual(["RUT", "Cámara de Comercio", "Certificación bancaria", "Fachada"]);
  });

  it("a staged file needs a tag and a type the tag accepts", () => {
    const file = (type: string) => new File(["x"], "a", { type });
    expect(stagedProblem({ file: file("application/pdf"), tag: "" }, defs, DEFAULT_LABELS)).toBe(DEFAULT_LABELS.needsTag);
    expect(stagedProblem({ file: file("application/pdf"), tag: TAG_OTHER }, defs, DEFAULT_LABELS)).toBe(DEFAULT_LABELS.needsTag);
    expect(stagedProblem({ file: file("application/pdf"), tag: "   " }, defs, DEFAULT_LABELS)).toBe(DEFAULT_LABELS.needsTag);
    expect(stagedProblem({ file: file("image/png"), tag: "rut" }, defs, DEFAULT_LABELS)).toBe("La etiqueta RUT exige un archivo PDF");
    expect(stagedProblem({ file: file("application/pdf"), tag: "RUT" }, defs, DEFAULT_LABELS)).toBeNull();
    expect(stagedProblem({ file: file("application/zip"), tag: "Otro documento" }, defs, DEFAULT_LABELS)).toBeNull();
  });

  it("formats sizes like the prototype", () => {
    expect(formatSize(184320)).toBe("180 KB");
    expect(formatSize(10)).toBe("1 KB");
    expect(formatSize(1572864)).toBe("1,5 MB");
  });
});
