import type { ReactNode } from "react";

// Types, default copy and pure rules of the record frame (design §5.16, rule 21). No React components here.

export type RecordTabId = "datos" | "contactos" | "fotos" | "extra" | "archivos";

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
}

export const DEFAULT_RECORD_LABELS: RecordLabels = {
  tabs: { datos: "Datos", contactos: "Contactos", fotos: "Fotos", extra: "Datos adicionales", archivos: "Archivos" },
  number: "N.º",
  uuid: "uuid",
  assignedOnCreate: "N.º y uuid se asignan al crear",
  openInNewTab: "Abrir en una pestaña nueva",
  pending: "Pendientes",
};

/** Deep link of a record: `/r/<entity id>/<record id>`, the same form as a full page. */
export const recordHref = (entity: string, recordId: string): string => `/r/${entity}/${recordId}`;

/** First 8 characters of the UUID, as the prototype shows it. */
export const shortId = (uuid: string): string => uuid.slice(0, 8);

/** The tabs an entity needs, in order: parties add Contactos, products add Fotos; every record has Datos adicionales and Archivos. */
export function recordTabIds(entity: string): RecordTabId[] {
  return [
    "datos",
    ...(entity === "core.party" ? (["contactos"] as const) : []),
    ...(entity === "core.product" ? (["fotos"] as const) : []),
    "extra",
    "archivos",
  ];
}
