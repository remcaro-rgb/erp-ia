import type { ReactNode } from "react";

// Types, default copy and pure rules of the record frame (design §5.16, rule 21). No React components here.

export type RecordTabId = "datos" | "contactos" | "fotos" | "mensajes" | "extra" | "archivos";

/** One tab of the frame; the caller supplies the content, the frame only chooses what is shown. */
export interface RecordTab {
  id: RecordTabId;
  /** Overrides the default name of the tab. */
  label?: string;
  /** Items in the tab (contacts, photos, defined fields…). */
  count?: number;
  /** Pending items (invalid or missing data, missing required files), shown as a red badge. */
  warn?: number;
  content: ReactNode;
}

/** Copy of the frame. Spanish (es-419) until Task 11 wires packages/i18n; every string can be replaced through the `labels` prop. */
export interface RecordLabels {
  tabs: Record<RecordTabId, string>;
  number: string;
  uuid: string;
  assignedOnCreate: string;
  openInNewTab: string;
  pending: string;
  /** The action that starts a new record from this one (rule 37). */
  duplicate: string;
  /** Banner of a new record started from a copy; `{name}` is where the source's name (a link to it) goes. */
  copyOf: string;
  /** What the person still has to do on the copy. */
  copyNote: string;
}

export const DEFAULT_RECORD_LABELS: RecordLabels = {
  tabs: { datos: "Datos", contactos: "Contactos", fotos: "Fotos", mensajes: "Mensajes", extra: "Datos adicionales", archivos: "Archivos" },
  number: "N.º",
  uuid: "uuid",
  assignedOnCreate: "N.º y uuid se asignan al crear",
  openInNewTab: "Abrir en una pestaña nueva",
  pending: "Pendientes",
  duplicate: "Duplicar",
  copyOf: "Copia de {name}",
  copyNote: "Completa los datos que identifican el registro. Los contactos, las fotos y los archivos no se copian.",
};

/**
 * The page of a record (rule 21, design §22.15): the kernel's one rule (`@erp/kernel/href`), shared with the assistant's
 * `ui__open_record` and the server loaders. A user opens under Administración › Usuarios, any other record in its frame.
 */
export { recordHref } from "@erp/kernel/href";

/** First 8 characters of the UUID, as the prototype shows it. */
export const shortId = (uuid: string): string => uuid.slice(0, 8);

/** The tabs an entity needs, in order: parties add Contactos, products add Fotos, tickets add Mensajes; every record has Datos adicionales and Archivos. */
export function recordTabIds(entity: string): RecordTabId[] {
  return [
    "datos",
    ...(entity === "core.party" ? (["contactos"] as const) : []),
    ...(entity === "core.product" ? (["fotos"] as const) : []),
    ...(entity === "support.ticket" ? (["mensajes"] as const) : []),
    "extra",
    "archivos",
  ];
}
