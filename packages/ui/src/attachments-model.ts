// Types, default copy and pure rules of the attachments panel (design §5.13, rule 22). No React here,
// so the rules are unit-tested without a DOM.

// The server enforces the same limit; the dependency-free subpath keeps the kernel's server code out of the browser bundle.
export { MAX_ATTACHMENT_BYTES } from "@erp/kernel/limits";

/** Value of the tag select that opens the free-text tag input. */
export const TAG_OTHER = "__other__";

export type RequiredKind = "pdf" | "image" | "any";

/** A file the administrator defined for the entity (`kernel.required_attachments`) that applies to this record. */
export interface RequiredTag {
  tag: string;
  kind: RequiredKind;
  required: boolean;
  description?: string;
}

/** A stored file, as `kernel.attachment.list` returns it. */
export interface AttachmentItem {
  id: string;
  tag: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  uploadedBy: string | null;
  uploadedByName?: string | null;
  uploadedAt: string;
  /** A picture the assistant suggested that no user has approved yet (`kernel.attachment.list`). */
  suggested?: boolean;
}

/** Copy of the panel. Spanish (es-419) until Task 11 wires packages/i18n; every string can be replaced through the `labels` prop. */
export interface AttachmentsLabels {
  requiredTitle: string;
  loaded: string;
  required: string;
  optional: string;
  kindPdf: string;
  kindImage: string;
  kindAny: string;
  missing: (tags: string[]) => string;
  saveFirst: string;
  dropTitle: string;
  dropOr: string;
  choose: string;
  dropHint: string;
  stageTitle: string;
  tagPlaceholder: string;
  tagOther: string;
  tagName: string;
  unstage: string;
  readyToUpload: string;
  needsTag: string;
  upload: (count: number) => string;
  uploading: string;
  listTitle: string;
  empty: string;
  download: string;
  remove: (fileName: string) => string;
  confirmRemove: (fileName: string, tag: string) => string;
  confirmYes: string;
  confirmNo: string;
  tooBig: (fileName: string) => string;
  duplicate: (fileName: string) => string;
  wrongKind: (tag: string, kind: RequiredKind) => string;
  failed: (fileName: string, reason: string) => string;
  actionFailed: (reason: string) => string;
  loadFailed: string;
}

export const DEFAULT_LABELS: AttachmentsLabels = {
  requiredTitle: "Archivos definidos por el administrador",
  loaded: "cargado",
  required: "obligatorio",
  optional: "opcional",
  kindPdf: "PDF",
  kindImage: "imagen",
  kindAny: "cualquier tipo",
  missing: (tags) => `Mientras falten ${tags.join(" y ")} el registro no se puede usar en facturas.`,
  saveFirst: "Guarda el registro para adjuntar archivos",
  dropTitle: "Arrastra los archivos aquí",
  dropOr: "o",
  choose: "elígelos",
  dropHint: "Cualquier tipo · hasta 25 MB por archivo · descarga con URL firmada de 60 s",
  stageTitle: "Por subir · asigna la etiqueta de cada archivo",
  tagPlaceholder: "Etiqueta…",
  tagOther: "Otra…",
  tagName: "nombre de la etiqueta",
  unstage: "Quitar de la lista",
  readyToUpload: "Listo para subir",
  needsTag: "Cada archivo necesita una etiqueta",
  upload: (n) => `Subir ${n} archivo${n === 1 ? "" : "s"}`,
  uploading: "Subiendo…",
  listTitle: "Archivos adjuntos",
  empty: "Sin archivos todavía.",
  download: "Descargar",
  remove: (name) => `Quitar ${name}`,
  confirmRemove: (name, tag) => `¿Quitar ${name} (${tag})? Deja de estar disponible pero queda en auditoría.`,
  confirmYes: "Sí, quitar",
  confirmNo: "No",
  tooBig: (name) => `${name} supera 25 MB`,
  duplicate: (name) => `${name} ya está adjunto`,
  wrongKind: (tag, kind) => `La etiqueta ${tag} exige ${kind === "pdf" ? "un archivo PDF" : "una imagen"}`,
  failed: (name, reason) => `No se pudo subir ${name}: ${reason}`,
  actionFailed: (reason) => `No se pudo completar la acción: ${reason}`,
  loadFailed: "No se pudieron cargar los archivos",
};

/** A translator of the `common.attachments` namespace (next-intl's `useTranslations("common.attachments")`). */
export type AttachmentsTranslator = (key: string, values?: Record<string, string | number>) => string;

/**
 * The panel's copy from the catalogue (rule 24): every label from `common.attachments`, lists of tags joined the
 * locale's way ("RUT, Cámara y Banco", "RUT and Chamber"), and an API refusal code read through `reason` when given.
 */
export function attachmentsLabels(t: AttachmentsTranslator, locale: string, reason: (code: string) => string = (code) => code): AttachmentsLabels {
  const list = new Intl.ListFormat(locale, { type: "conjunction" });
  return {
    requiredTitle: t("required_title"),
    loaded: t("loaded"),
    required: t("required"),
    optional: t("optional"),
    kindPdf: t("kind_pdf"),
    kindImage: t("kind_image"),
    kindAny: t("kind_any"),
    missing: (tags) => t("missing", { tags: list.format(tags) }),
    saveFirst: t("save_first"),
    dropTitle: t("drop_title"),
    dropOr: t("drop_or"),
    choose: t("choose"),
    dropHint: t("drop_hint"),
    stageTitle: t("stage_title"),
    tagPlaceholder: t("tag_placeholder"),
    tagOther: t("tag_other"),
    tagName: t("tag_name"),
    unstage: t("unstage"),
    readyToUpload: t("ready_to_upload"),
    needsTag: t("needs_tag"),
    upload: (count) => t("upload", { count }),
    uploading: t("uploading"),
    listTitle: t("list_title"),
    empty: t("empty"),
    download: t("download"),
    remove: (name) => t("remove", { name }),
    confirmRemove: (name, tag) => t("confirm_remove", { name, tag }),
    confirmYes: t("confirm_yes"),
    confirmNo: t("confirm_no"),
    tooBig: (name) => t("too_big", { name }),
    duplicate: (name) => t("duplicate", { name }),
    wrongKind: (tag, kind) => t(kind === "pdf" ? "wrong_kind_pdf" : "wrong_kind_image", { tag }),
    failed: (name, code) => t("failed", { name, reason: reason(code) }),
    actionFailed: (code) => t("action_failed", { reason: reason(code) }),
    loadFailed: t("load_failed"),
  };
}

/** A file waiting for its tag. */
export interface StagedFile {
  key: number;
  file: File;
  /** Chosen or typed tag; "" until the user picks one. */
  tag: string;
  /** The user opened the free-text tag input. */
  custom: boolean;
  /** Why the last upload attempt failed. */
  error?: string;
}

const norm = (value: string) => value.trim().toLowerCase();

export const sameTag = (a: string, b: string) => norm(a) === norm(b);

/** Whether a file of `mimeType` satisfies the required `kind`. */
export function kindFits(kind: RequiredKind, mimeType: string): boolean {
  if (kind === "pdf") return mimeType === "application/pdf";
  if (kind === "image") return mimeType.startsWith("image/");
  return true;
}

/** `cargado` when a stored file carries the tag with a fitting type. */
export function isLoaded(def: RequiredTag, items: readonly AttachmentItem[]): boolean {
  return items.some((item) => sameTag(item.tag, def.tag) && kindFits(def.kind, item.mimeType));
}

/** Tags of the mandatory definitions that still lack a file: the record is not invoice-ready while any is missing. */
export function missingTags(defs: readonly RequiredTag[], items: readonly AttachmentItem[]): string[] {
  return defs.filter((def) => def.required && !isLoaded(def, items)).map((def) => def.tag);
}

/** The tags the select offers: the ones the administrator defined, once each. */
export function definedTags(defs: readonly RequiredTag[]): string[] {
  const seen: string[] = [];
  for (const def of defs) if (!seen.some((t) => sameTag(t, def.tag))) seen.push(def.tag);
  return seen;
}

/** The mandatory tag a file name most likely is (its first word appears in the name) and that is not loaded yet, or "". */
export function guessTag(fileName: string, defs: readonly RequiredTag[], items: readonly AttachmentItem[]): string {
  const name = fileName.toLowerCase();
  const found = defs.find((def) => {
    const first = norm(def.tag).split(/\s+/)[0] ?? "";
    return first !== "" && name.includes(first) && !items.some((item) => sameTag(item.tag, def.tag));
  });
  return found?.tag ?? "";
}

/** Why a staged file cannot go up yet, or null: no tag, or a type the tag does not accept. */
export function stagedProblem(staged: Pick<StagedFile, "file" | "tag">, defs: readonly RequiredTag[], labels: AttachmentsLabels): string | null {
  const tag = staged.tag.trim();
  if (tag === "" || tag === TAG_OTHER) return labels.needsTag;
  const def = defs.find((d) => sameTag(d.tag, tag));
  if (def && !kindFits(def.kind, staged.file.type)) return labels.wrongKind(def.tag, def.kind);
  return null;
}

/** Human size: `184 KB`, `1,5 MB`. */
export function formatSize(bytes: number): string {
  if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(1).replace(".", ",")} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export function fileIcon(mimeType: string): string {
  if (mimeType.startsWith("image/")) return "🖼";
  if (mimeType === "application/pdf") return "📄";
  if (/sheet|excel|csv/.test(mimeType)) return "📊";
  return "📎";
}

export function kindLabel(kind: RequiredKind, labels: AttachmentsLabels): string {
  return kind === "pdf" ? labels.kindPdf : kind === "image" ? labels.kindImage : labels.kindAny;
}
