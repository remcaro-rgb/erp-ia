import type { ReactNode } from "react";

// Types, default copy and pure rules of the record frame (design §5.16, rule 21). No React components here.

/** The frame's own tabs are `datos`, `contactos`, `fotos`, `mensajes`, `extra` and `archivos`; a module's contributed tab is named by its id (`accounting.entries`). */
export type RecordTabId = string;

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
  /** Names of the frame's own tabs; a contributed tab carries its own `label`. */
  tabs: Record<string, string | undefined>;
  number: string;
  /** A documento's number (Número) and reference (Ref.), next to the ID. */
  docNumber: string;
  reference: string;
  /** The copy button's name; `{what}` is the identifier. */
  copy: string;
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
  tabs: {
    datos: "Datos", contactos: "Contactos", fotos: "Fotos", mensajes: "Mensajes", extra: "Datos adicionales", archivos: "Archivos", origen: "Origen",
    saldos: "Saldos", movimientos: "Movimientos", seguridad: "Seguridad", resultados: "Resultados", resumen: "Resumen", comprobantes: "Comprobantes", cierre: "Cierre",
    lineas: "Líneas", probar: "Probar", historial: "Historial", versiones: "Versiones", acceso: "Acceso",
  },
  number: "ID",
  docNumber: "Número",
  reference: "Ref.",
  copy: "Copiar {what}",
  uuid: "UUID",
  assignedOnCreate: "El ID y el UUID se asignan al crear",
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

/**
 * The tabs the accounting records add after Datos (accounting design §8): a Cuenta its balances, movements and, for the admin, Seguridad;
 * a centro de costo its results; the other analytic nodes their balances by account; a Período its summary, comprobantes and close; a Regla
 * contable its lines, a test with a real event and its history. The page leaves out the ones the caller may not have (Seguridad).
 */
const ACCOUNTING_TABS: Readonly<Record<string, readonly RecordTabId[]>> = {
  "accounting.account": ["saldos", "movimientos", "seguridad"],
  "accounting.cost_center": ["resultados", "movimientos"],
  "accounting.open_auxiliary": ["saldos", "movimientos"],
  "accounting.item": ["saldos", "movimientos"],
  "accounting.business_unit": ["saldos", "movimientos"],
  "accounting.period": ["resumen", "comprobantes", "cierre"],
  "accounting.posting_rule": ["lineas", "probar", "historial"],
};

/**
 * The tabs an entity needs, in order: a comprobante adds Origen, parties add Contactos, products add Fotos, tickets add Mensajes; the tabs modules
 * contribute (`contributed`, their ids) come next; every record has Datos adicionales and Archivos.
 */
export function recordTabIds(entity: string, contributed: readonly string[] = []): RecordTabId[] {
  return [
    "datos",
    ...(ACCOUNTING_TABS[entity] ?? []),
    ...(entity === "accounting.entry" ? (["origen"] as const) : []),
    ...(entity === "core.party" ? (["contactos"] as const) : []),
    ...(entity === "core.product" ? (["fotos"] as const) : []),
    ...(entity === "support.ticket" ? (["mensajes"] as const) : []),
    ...contributed,
    "extra",
    "archivos",
    // A maestro or documento (Task 15): a documento's Versiones, and Acceso for an admin; the page passes them only when they apply.
    "versiones",
    "acceso",
  ];
}
