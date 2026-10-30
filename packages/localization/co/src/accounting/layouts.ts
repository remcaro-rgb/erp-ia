import type { LineCode, StatementSection } from "@erp/kernel";

const section = (code: string): StatementSection => ({ code, label: `accounting.statement.${code}` });

/** Sections in the order they print (`statementSection` of the chart); labels are i18n keys. */
export const statementLayouts = (): { balanceSheet: StatementSection[]; incomeStatement: StatementSection[]; f2516: { esf: LineCode[]; eri: LineCode[] } } => ({
  balanceSheet: ["assets_current", "assets_noncurrent", "liabilities_current", "liabilities_noncurrent", "equity"].map(section),
  incomeStatement: ["revenue", "cost_of_sales", "operating_expenses", "other_income", "other_expenses", "income_tax"].map(section),
  f2516: { esf: ESF, eri: ERI },
});

const line = (prefix: string, label: string, sheet: "ESF" | "ERI"): LineCode => ({ code: `${sheet}-${prefix}`, label, prefixes: [prefix] });

// Formato 2516 (H2 estado de situación financiera, H3 estado de resultados) by PUC group. The line codes follow the
// group so each reads its valor contable from the ledger (accounting design §5.10); the DIAN's own row numbering of the
// resolution in force is mapped by the exógena/2516 export, which changes per tax year without touching the ledger.
const ESF: LineCode[] = [
  ["11", "Efectivo y equivalentes al efectivo"], ["12", "Inversiones"], ["13", "Cuentas por cobrar"], ["14", "Inventarios"],
  ["15", "Propiedades, planta y equipo"], ["16", "Activos intangibles"], ["17", "Activos diferidos"], ["18", "Otros activos"], ["19", "Valorizaciones"],
  ["21", "Obligaciones financieras"], ["22", "Proveedores"], ["23", "Cuentas por pagar"], ["24", "Impuestos, gravámenes y tasas"],
  ["25", "Obligaciones laborales"], ["26", "Pasivos estimados y provisiones"], ["27", "Pasivos diferidos"], ["28", "Otros pasivos"], ["29", "Bonos y papeles comerciales"],
  ["31", "Capital social"], ["32", "Superávit de capital"], ["33", "Reservas"], ["34", "Revalorización del patrimonio"], ["35", "Dividendos decretados en acciones"],
  ["36", "Resultados del ejercicio"], ["37", "Resultados de ejercicios anteriores"], ["38", "Superávit por valorizaciones"],
].map(([prefix, label]) => line(prefix!, label!, "ESF"));

const ERI: LineCode[] = [
  ["41", "Ingresos operacionales"], ["42", "Ingresos no operacionales"], ["47", "Ajustes por inflación"],
  ["51", "Gastos operacionales de administración"], ["52", "Gastos operacionales de ventas"], ["53", "Gastos no operacionales"], ["54", "Impuesto de renta y complementarios"],
  ["61", "Costo de ventas y de prestación de servicios"], ["62", "Compras"], ["71", "Costos de producción: materia prima"], ["72", "Costos de producción: mano de obra directa"],
  ["73", "Costos de producción: costos indirectos"], ["74", "Costos de producción: contratos de servicios"],
].map(([prefix, label]) => line(prefix!, label!, "ERI"));
