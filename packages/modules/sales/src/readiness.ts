import { ProcessError, type ProcessContext } from "@erp/kernel";

// The invoice-readiness gate of a sale document line (rule 10, design §5.17; plan 2B Global Constraints): a tercero or a product with
// `invoice_ready = false` is refused on every line of a quote, an order, a delivery and an invoice, with the reasons in the error. The
// facts come from core's published views core.v_party_sales / core.v_product_sales (migrations 0081, 0083): `invoice_ready` there is both
// halves of rule 10 (§22.22) — complete (the flag core's triggers compute) and usable (kernel.record_usable: active, Grabado, or Aprobado
// when it requires approval) — plus the DIAN data still missing, the status and the required files it lacks, for the reasons. Shared by crm's quotes and sales' own documents.

/** What a sale line needs of its customer: the tax profile for computeTaxes and the name the messages show. */
export interface SaleParty {
  id: string;
  name: string;
  personType: "1" | "2" | null;
  responsibilities: string[];
}

/** What a sale line needs of its product: its name and the tax facts for computeTaxes. */
export interface SaleProduct {
  id: string;
  sku: string;
  description: string;
  kind: "good" | "service";
  ivaRate: "19" | "5" | "0" | "EXC";
  incRate: "2" | "4" | "8" | "16" | null;
  otherTaxes: string[];
  isFreeSample: boolean;
  referencePrice: number | null;
}

export interface Readiness {
  invoice_ready: boolean | null;
  is_active: boolean | null;
  dian_missing: string[] | null;
  missing_files: string[] | null;
  /** Usable on documents (kernel.record_usable: live, active, Grabado, or Aprobado when it requires approval; rule 10, §22.22). */
  usable?: boolean | null;
  status?: string | null;
  requires_approval?: boolean | null;
}

/** Why a tercero or a product is not invoice_ready (complete and usable), in the words the screens show (es-419). */
export function readinessReasons(row: Readiness): string[] {
  const reasons: string[] = [];
  if (row.usable === false && row.is_active !== false) {
    if (row.requires_approval === true && row.status === "rejected") reasons.push("no fue aprobado");
    else if (row.requires_approval === true && row.status !== "approved") reasons.push("está pendiente de aprobación");
    else if (row.status === "draft") reasons.push("está en borrador, sin grabar");
    else reasons.push("no está habilitado para documentos");
  }
  if ((row.dian_missing ?? []).length > 0) reasons.push(`faltan datos DIAN: ${row.dian_missing!.join(", ")}`);
  if ((row.missing_files ?? []).length > 0) reasons.push(`faltan archivos: ${row.missing_files!.join(", ")}`);
  if (row.is_active === false) reasons.push("está inactivo");
  if (reasons.length === 0) reasons.push("revisa sus datos DIAN, sus archivos, que esté activo y aprobado");
  return reasons;
}

/** A refusal whose message leads with its code; `details` lists every message. */
function refuse(code: string, details: readonly string[]): never {
  throw new ProcessError("invalid_input", `${code}: ${details[0] ?? code}`, { details: [...details] });
}

/**
 * Checks the customer `partyId` and the product of every line, as the caller sees them, and returns their sale facts. Refuses with
 * `invalid_input`:
 *   - `invalid_party` / `invalid_product`: not there, not visible (company RLS, party scope, record read), or the tercero is not a customer;
 *   - `not_invoice_ready`: one detail per tercero or line that is not invoice_ready, with its reasons (`Línea 2: el producto SIN-01 …`).
 * Line numbers in the messages are 1-based positions of `productIds`.
 */
export async function assertSaleReady(ctx: ProcessContext, partyId: string, productIds: readonly string[]): Promise<{ party: SaleParty; products: Map<string, SaleProduct> }> {
  const [party] = await ctx.tx<(Readiness & { kind: string[] | null; person_type: string | null; tax_responsibilities: string[] | null })[]>`
    select kind, person_type, tax_responsibilities, invoice_ready, is_active, dian_missing, missing_files, usable, status, requires_approval from core.v_party_sales where id = ${partyId}`;
  if (!party) refuse("invalid_party", ["El cliente no existe o no es visible"]);
  if (!(party.kind ?? []).includes("customer")) refuse("invalid_party", ["El tercero no es un cliente"]);
  const [named] = await ctx.tx<{ legal_name: string | null; document_number: string | null }[]>`select legal_name, document_number from core.v_parties where id = ${partyId}`;
  const partyName = named?.legal_name ?? named?.document_number ?? partyId;

  const unique = [...new Set(productIds)];
  const rows = unique.length === 0 ? [] : await ctx.tx<(Readiness & {
    id: string; sku: string; description: string; kind: string; iva_rate: string; inc_rate: string | null; other_taxes: string[] | null; is_free_sample: boolean; reference_price: string | null;
  })[]>`
    select id, sku, description, kind, iva_rate, inc_rate, other_taxes, is_free_sample, reference_price::text, invoice_ready, is_active, dian_missing, missing_files,
           usable, status, requires_approval
    from core.v_product_sales where id = any(${unique}::uuid[])`;
  const byId = new Map(rows.map((r) => [r.id, r]));

  const unknown = productIds.flatMap((id, i) => (byId.has(id) ? [] : [`Línea ${i + 1}: el producto no existe o no es visible`]));
  if (unknown.length > 0) refuse("invalid_product", unknown);

  const notReady: string[] = [];
  if (party.invoice_ready !== true) notReady.push(`El cliente ${partyName} no está listo para facturar: ${readinessReasons(party).join("; ")}`);
  productIds.forEach((id, i) => {
    const p = byId.get(id)!;
    if (p.invoice_ready !== true) notReady.push(`Línea ${i + 1}: el producto ${p.sku} (${p.description}) no está listo para facturar: ${readinessReasons(p).join("; ")}`);
  });
  if (notReady.length > 0) refuse("not_invoice_ready", notReady);

  const products = new Map<string, SaleProduct>(
    rows.map((r) => [
      r.id,
      {
        id: r.id,
        sku: r.sku,
        description: r.description,
        kind: r.kind === "service" ? "service" : "good",
        ivaRate: r.iva_rate as SaleProduct["ivaRate"],
        incRate: (r.inc_rate ?? null) as SaleProduct["incRate"],
        otherTaxes: r.other_taxes ?? [],
        isFreeSample: r.is_free_sample === true,
        referencePrice: r.reference_price === null ? null : Number(r.reference_price),
      },
    ]),
  );
  return {
    party: { id: partyId, name: partyName, personType: party.person_type === "1" || party.person_type === "2" ? party.person_type : null, responsibilities: party.tax_responsibilities ?? [] },
    products,
  };
}
