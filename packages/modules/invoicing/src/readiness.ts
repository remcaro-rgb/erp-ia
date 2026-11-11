import { ProcessError, type ProcessContext } from "@erp/kernel";

// The invoice-readiness gate of an invoice (rule 10, design §5.17): the customer and the product of every line must be invoice_ready, i.e.
// complete (core's flag) AND usable on documents (kernel.record_usable), with the reasons in the error. The facts come from core's published
// views only (core.v_party_sales, core.v_product_sales, migrations 0081 and 0083; core.v_party_fiscal, 0091, for the tax id the CUFE names)
// — never from sales' code (rule 3: the same check the sales documents make, written again here over the same published views).

export interface InvoiceParty {
  id: string;
  name: string;
  /** The customer's identification number as the CUFE carries it (no check digit). */
  taxId: string;
  /** Its document type (the pack keeps the letters of a foreign document in the CUFE, Task 18 fix round 1); null when not visible. */
  documentType: string | null;
  /** Its country (ISO 3166-1 alpha-2; null when not visible): «Emitir» freezes whether the invoice is an export from it. */
  countryCode: string | null;
  personType: "1" | "2" | null;
  responsibilities: string[];
}

export interface InvoiceProduct {
  id: string;
  sku: string;
  description: string;
  kind: "good" | "service";
  ivaRate: "19" | "5" | "0" | "EXC";
  incRate: "2" | "4" | "8" | "16" | null;
  otherTaxes: string[];
  isFreeSample: boolean;
  referencePrice: number | null;
  listPrice: number | null;
  categoryId: string | null;
}

interface Readiness {
  invoice_ready: boolean | null;
  is_active: boolean | null;
  dian_missing: string[] | null;
  missing_files: string[] | null;
  usable: boolean | null;
  status: string | null;
  requires_approval: boolean | null;
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
export function refuse(code: string, details: readonly string[]): never {
  throw new ProcessError("invalid_input", `${code}: ${details[0] ?? code}`, { details: [...details] });
}

export interface ReadinessResult {
  party: InvoiceParty;
  products: Map<string, InvoiceProduct>;
  /** One message per tercero or line that is not invoice_ready, with its reasons; empty when everything is ready. */
  notReady: string[];
}

/**
 * Reads the customer `partyId` and the product of every line as the caller sees them. Refuses with `invalid_input` what can never be
 * invoiced: `invalid_party` / `invalid_product` (not there, not visible, the tercero is not a customer). What is not invoice_ready is
 * answered in `notReady` (`Línea 2: el producto SIN-01 …`): `assertInvoiceReady` refuses it, an automatic invoice keeps it as a
 * recommendation. Line numbers are 1-based positions of `productIds`.
 */
export async function readInvoiceFacts(ctx: ProcessContext, partyId: string, productIds: readonly string[]): Promise<ReadinessResult> {
  const [party] = await ctx.tx<(Readiness & { kind: string[] | null; person_type: string | null; tax_responsibilities: string[] | null })[]>`
    select kind, person_type, tax_responsibilities, invoice_ready, is_active, dian_missing, missing_files, usable, status, requires_approval
    from core.v_party_sales where id = ${partyId}`;
  if (!party) refuse("invalid_party", ["El cliente no existe o no es visible"]);
  if (!(party.kind ?? []).includes("customer")) refuse("invalid_party", ["El tercero no es un cliente"]);
  const [fiscal] = await ctx.tx<{ legal_name: string | null; document_number: string | null; document_type: string | null; country_code: string | null }[]>`
    select legal_name, document_number, document_type, country_code from core.v_party_fiscal where id = ${partyId}`;
  const partyName = fiscal?.legal_name ?? fiscal?.document_number ?? partyId;

  const unique = [...new Set(productIds)];
  const rows = unique.length === 0 ? [] : await ctx.tx<(Readiness & {
    id: string; sku: string; description: string; kind: string; iva_rate: string; inc_rate: string | null; other_taxes: string[] | null;
    is_free_sample: boolean; reference_price: string | null; list_price: string | null; category_id: string | null;
  })[]>`
    select s.id, s.sku, s.description, s.kind, s.iva_rate, s.inc_rate, s.other_taxes, s.is_free_sample, s.reference_price::text,
           p.list_price::text, p.category_id, s.invoice_ready, s.is_active, s.dian_missing, s.missing_files, s.usable, s.status, s.requires_approval
    from core.v_product_sales s left join core.v_products p on p.id = s.id
    where s.id = any(${unique}::uuid[])`;
  const byId = new Map(rows.map((r) => [r.id, r]));
  const unknown = productIds.flatMap((id, i) => (byId.has(id) ? [] : [`Línea ${i + 1}: el producto no existe o no es visible`]));
  if (unknown.length > 0) refuse("invalid_product", unknown);

  const notReady: string[] = [];
  if (party.invoice_ready !== true) notReady.push(`El cliente ${partyName} no está listo para facturar: ${readinessReasons(party).join("; ")}`);
  productIds.forEach((id, i) => {
    const p = byId.get(id)!;
    if (p.invoice_ready !== true) notReady.push(`Línea ${i + 1}: el producto ${p.sku} (${p.description}) no está listo para facturar: ${readinessReasons(p).join("; ")}`);
  });

  const products = new Map<string, InvoiceProduct>(rows.map((r) => [r.id, {
    id: r.id,
    sku: r.sku,
    description: r.description,
    kind: r.kind === "service" ? "service" : "good",
    ivaRate: r.iva_rate as InvoiceProduct["ivaRate"],
    incRate: (r.inc_rate ?? null) as InvoiceProduct["incRate"],
    otherTaxes: r.other_taxes ?? [],
    isFreeSample: r.is_free_sample === true,
    referencePrice: r.reference_price === null ? null : Number(r.reference_price),
    listPrice: r.list_price === null ? null : Number(r.list_price),
    categoryId: r.category_id ?? null,
  }]));
  return {
    party: {
      id: partyId,
      name: partyName,
      taxId: fiscal?.document_number ?? "",
      documentType: fiscal?.document_type ?? null,
      countryCode: fiscal?.country_code ?? null,
      personType: party.person_type === "1" || party.person_type === "2" ? party.person_type : null,
      responsibilities: party.tax_responsibilities ?? [],
    },
    products,
    notReady,
  };
}

/** `readInvoiceFacts`, refusing `not_invoice_ready` (one detail per tercero or line, with its reasons). */
export async function assertInvoiceReady(ctx: ProcessContext, partyId: string, productIds: readonly string[]): Promise<ReadinessResult> {
  const facts = await readInvoiceFacts(ctx, partyId, productIds);
  if (facts.notReady.length > 0) refuse("not_invoice_ready", facts.notReady);
  return facts;
}
