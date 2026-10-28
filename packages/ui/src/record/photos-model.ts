// Types, default copy and pure rules of the "Fotos" tab of a product (design §5.18). Photos are attachments
// tagged `Foto` (or `Foto · IA` when the assistant suggested them), so the tab reuses /api/attachments.

import { MAX_ATTACHMENT_BYTES, type AttachmentItem } from "../attachments-model";

export { MAX_ATTACHMENT_BYTES };
export type { AttachmentItem };

export const PHOTO_TAG = "Foto";
export const PHOTO_AI_TAG = "Foto · IA";

const TAG = /^foto(\s*·\s*ia)?$/i;

/** An image attachment tagged Foto or Foto · IA. */
export const isPhoto = (item: Pick<AttachmentItem, "tag" | "mimeType">): boolean => TAG.test(item.tag.trim()) && item.mimeType.startsWith("image/");

/** Suggested by the assistant (`Foto · IA`) and not a user's own upload. */
export const isAiPhoto = (item: Pick<AttachmentItem, "tag">): boolean => /ia$/i.test(item.tag.trim());

export interface PhotosLabels {
  empty: string;
  saveFirst: string;
  previous: string;
  next: string;
  principal: string;
  uploaded: string;
  aiSuggested: string;
  makePrincipal: string;
  remove: string;
  confirmRemove: string;
  confirmYes: string;
  confirmNo: string;
  dropTitle: string;
  dropOr: string;
  choose: string;
  dropHint: string;
  suggest: string;
  suggesting: string;
  suggestHint: string;
  notImage: (fileName: string) => string;
  tooBig: (fileName: string) => string;
  failed: (fileName: string, reason: string) => string;
  actionFailed: (reason: string) => string;
  loadFailed: string;
}

/** Spanish (es-419) until Task 11 wires packages/i18n; every string can be replaced through the `labels` prop. */
export const DEFAULT_PHOTOS_LABELS: PhotosLabels = {
  empty: "Sin fotos todavía",
  saveFirst: "Guarda el producto para agregar fotos",
  previous: "Anterior",
  next: "Siguiente",
  principal: "principal",
  uploaded: "subida",
  aiSuggested: "sugerida por IA",
  makePrincipal: "Hacer principal",
  remove: "Quitar",
  confirmRemove: "¿Quitar esta foto?",
  confirmYes: "Sí",
  confirmNo: "No",
  dropTitle: "Arrastra fotos aquí",
  dropOr: "o",
  choose: "elígelas",
  dropHint: "JPG, PNG o WebP · hasta 25 MB",
  suggest: "✨ Sugerir foto con IA",
  suggesting: "Generando…",
  suggestHint: "Genera una imagen a partir de la descripción, la unidad y la categoría; queda marcada “sugerida por IA” hasta que la apruebes",
  notImage: (name) => `${name} no es una imagen`,
  tooBig: (name) => `${name} supera 25 MB`,
  failed: (name, reason) => `No se pudo subir ${name}: ${reason}`,
  actionFailed: (reason) => `No se pudo completar la acción: ${reason}`,
  loadFailed: "No se pudieron cargar las fotos",
};
