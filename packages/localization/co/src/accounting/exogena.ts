import type { ExogenaFormat } from "@erp/kernel";
import catalogue from "../../data/exogena-2026.json" with { type: "json" };

/** The formats of a tax year; only the 2026 catalogue ships, a later year is added with its own JSON. */
export function exogenaFormats(year: number): ExogenaFormat[] {
  if (year !== catalogue.year) throw new Error(`No hay catálogo de exógena para el año gravable ${year}`);
  return catalogue.formats.map((f) => ({
    format: f.format,
    version: f.version,
    year,
    side: f.side as ExogenaFormat["side"],
    threshold: f.threshold,
    cuantiasMenoresNit: catalogue.cuantiasMenoresNit,
    concepts: f.concepts,
    columns: f.columns as ExogenaFormat["columns"],
  }));
}

/** The PUC accounts the DIAN concepts name directly; descendants inherit and the accountant completes the rest. */
export const defaultConceptMappings = (): { format: string; concept: string; code: string }[] => [
  { format: "1001", concept: "5001", code: "5105" },
  { format: "1001", concept: "5002", code: "5110" },
  { format: "1001", concept: "5003", code: "510518" },
  { format: "1001", concept: "5004", code: "5135" },
  { format: "1001", concept: "5005", code: "5120" },
  { format: "1001", concept: "5006", code: "5305" },
  { format: "1001", concept: "5007", code: "1435" },
  { format: "1003", concept: "1301", code: "135515" },
  { format: "1003", concept: "1302", code: "135517" },
  { format: "1003", concept: "1303", code: "135518" },
  { format: "1005", concept: "4101", code: "240810" },
  { format: "1006", concept: "4001", code: "41" },
  { format: "1007", concept: "4001", code: "41" },
  { format: "1007", concept: "4002", code: "42" },
  { format: "1008", concept: "1315", code: "1305" },
  { format: "1009", concept: "2201", code: "2205" },
];
