import type { ExogenaCompany, ExogenaFormat, ExogenaRow } from "@erp/kernel";

const escape = (text: string): string =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Whole pesos, half up: the prevalidador takes no decimals. */
const pesos = (n: number): number => Math.sign(n) * Math.round(Math.abs(n));

/**
 * The prevalidador's file for one format: a `<Cab>` header (year, `CodCpt` 1 = envío ordinario, format, version,
 * shipment, dates, `ValorTotal` = sum of every value column of every row, `CantReg` = rows) and one `<formatoNNNN>` element
 * per row. Refuses a row whose concept or value column is not in the format, so a mapping typo never reaches the DIAN.
 */
export function exogenaXml(format: ExogenaFormat, rows: ExogenaRow[], company: ExogenaCompany): string {
  const concepts = new Set(format.concepts.map((c) => c.code));
  const columns = format.columns.map((c) => c.id);
  let total = 0;
  const lines = rows.map((row) => {
    if (!concepts.has(row.concept)) throw new Error(`El concepto ${row.concept} no pertenece al formato ${format.format}`);
    for (const id of Object.keys(row.values)) if (!columns.includes(id)) throw new Error(`La columna ${id} no pertenece al formato ${format.format}`);
    const attributes: [string, string][] = [
      ["cpt", row.concept],
      ["tdoc", row.partyDocumentType],
      ["nid", row.partyDocument],
      ...(row.partyDv ? ([["dv", row.partyDv]] as [string, string][]) : []),
      ["raz", row.partyName],
      ...(row.departmentCode ? ([["dpto", row.departmentCode]] as [string, string][]) : []),
      ...(row.municipalityCode ? ([["mun", row.municipalityCode]] as [string, string][]) : []),
      ["pais", row.countryCode],
    ];
    for (const id of columns) {
      if (row.values[id] === undefined) continue;
      const value = pesos(row.values[id]);
      total += value;
      attributes.push([id, String(value)]);
    }
    return `  <formato${format.format} ${attributes.map(([k, v]) => `${k}="${escape(v)}"`).join(" ")}/>`;
  });
  const year = company.year;
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<mas xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="${format.format}.xsd">`,
    `  <Cab>`,
    `    <Ano>${year}</Ano>`,
    `    <CodCpt>1</CodCpt>`,
    `    <Formato>${format.format}</Formato>`,
    `    <Version>${format.version}</Version>`,
    `    <NumEnvio>${company.shipment ?? 1}</NumEnvio>`,
    `    <FecEnvio>${company.sentAt ?? `${year + 1}-01-01T00:00:00`}</FecEnvio>`,
    `    <FecInicial>${year}-01-01</FecInicial>`,
    `    <FecFinal>${year}-12-31</FecFinal>`,
    `    <ValorTotal>${total}</ValorTotal>`,
    `    <CantReg>${rows.length}</CantReg>`,
    `  </Cab>`,
    ...lines,
    `</mas>`,
    ``,
  ].join("\n");
}
