import { defineProcess, ProcessError } from "@erp/kernel";
import { z } from "zod";
import { exogenaData } from "../reports/exogena";
import { companyPack } from "./common";

// accounting.report.exogena_xml (accounting design §5.11): the prevalidador's XML of a format and year, written by the country pack.
// It refuses while the report lists errors, so a mapping gap never reaches the DIAN.

export const exogenaXml = defineProcess({
  id: "accounting.report.exogena_xml",
  module: "accounting",
  kind: "consult",
  feature: "accounting.ledger",
  description: "Genera el archivo XML de exógena de un formato y año gravable para el prevalidador; se niega mientras el reporte tenga errores",
  input: z.object({ year: z.number().int().min(2000).max(2100), format: z.string().trim().min(1), threshold: z.number().min(0).optional() }).strict(),
  output: z.object({ fileName: z.string(), xml: z.string(), rows: z.number() }),
  handler: async (ctx, { year, format, threshold }) => {
    const data = await exogenaData(ctx, year, format, threshold);
    if (data.errors.length > 0) throw new ProcessError("invalid_input", "the exogena report lists errors", { details: data.errors });
    if (data.exogenaRows.length === 0) throw new ProcessError("invalid_input", "the exogena report has no rows", { details: [`El formato ${format} no tiene información para ${year}`] });
    const [company] = await ctx.tx<{ legal_name: string; tax_id: string | null }[]>`select legal_name, tax_id from kernel.companies where id = ${ctx.companyId}`;
    const taxId = company?.tax_id?.trim() ?? "";
    const [nit, dv] = taxId.includes("-") ? (taxId.split("-") as [string, string]) : [taxId, ""];
    if (!/^\d+$/.test(nit.replace(/\./g, ""))) throw new ProcessError("invalid_input", "the company has no NIT", { details: ["La empresa no tiene NIT registrado: complétalo antes de generar el archivo"] });
    const pack = await companyPack(ctx);
    const xml = pack.exogenaXml(data.format, data.exogenaRows, { nit: nit.replace(/\./g, ""), dv, name: company!.legal_name, year });
    return { fileName: `Dmuisca_${format.padStart(6, "0")}${String(data.format.version).padStart(2, "0")}${year}.xml`, xml, rows: data.exogenaRows.length };
  },
});

export const EXOGENA_XML_PROCESSES = [exogenaXml];
