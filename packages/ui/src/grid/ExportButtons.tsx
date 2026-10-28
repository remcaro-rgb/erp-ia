"use client";

import { useTranslations } from "next-intl";
import type { ExportFormat } from "./types";

// The prototype's export icons: PDF red, Excel green, CSV grey (design §19a).
const ICONS: Record<ExportFormat, React.ReactNode> = {
  pdf: (
    <>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <path d="M14 2v6h6" />
      <path d="M9 15h1.5a1.5 1.5 0 0 0 0-3H9v6" />
    </>
  ),
  xlsx: (
    <>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <path d="M3 9h18M3 15h18M9 3v18M15 3v18" />
    </>
  ),
  csv: (
    <>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <path d="M14 2v6h6" />
      <path d="M8 13h8M8 17h8" />
    </>
  ),
};

const LABEL: Record<ExportFormat, "pdf" | "excel" | "csv"> = { pdf: "pdf", xlsx: "excel", csv: "csv" };

export function ExportIcon({ format }: { format: ExportFormat }) {
  return (
    <svg className={`erp-icon erp-icon--${format}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      {ICONS[format]}
    </svg>
  );
}

/** The prototype's upload icon (Importar). */
export function ImportIcon() {
  return (
    <svg className="erp-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <path d="M17 8l-5-5-5 5M12 3v12" />
    </svg>
  );
}

export interface ExportButtonsProps {
  /** Exports the grid's current filter, all pages, the visible columns (`kernel.export.run`). */
  onExport?: (format: ExportFormat) => void;
  /** An export is running: one at a time. */
  busy?: boolean;
}

/** PDF / Excel / CSV buttons with their coloured icons (rule 20). Disabled until an export handler is given, and while one runs. */
export function ExportButtons({ onExport, busy = false }: ExportButtonsProps) {
  const t = useTranslations();
  return (
    <span className="erp-grid__exports" role="group" aria-label={t("grid.export.title")}>
      {(["pdf", "xlsx", "csv"] as const).map((format) => (
        <button key={format} type="button" className="erp-btn" disabled={!onExport || busy} onClick={() => onExport?.(format)}>
          <ExportIcon format={format} />
          {t(`grid.export.${LABEL[format]}`)}
        </button>
      ))}
    </span>
  );
}
