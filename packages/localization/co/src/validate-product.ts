import type { ProductFiscalInput, ProductValidation } from "@erp/kernel";
import { gtinValid } from "./gtin";
import { INC_RATES, ITEM_ID_SCHEMES, ITEM_LIMITS, IVA_RATES, OTHER_TAXES, PRICE_TYPES, UOM_CODES } from "./item-tables";

const clean = (s: string | undefined): string | undefined => {
  const v = s?.trim();
  return v ? v : undefined;
};

/** Colombian product validation (design §5.8b). `errors` block the save; `missing` only sets `dian_status`. */
export function validateProduct(input: ProductFiscalInput): ProductValidation {
  const errors: string[] = [];
  const missing: string[] = [];

  const sku = input.sku.trim();
  const description = input.description.trim();
  const brand = clean(input.brand);
  const model = clean(input.model);
  let standardCode = clean(input.standardCode);

  if (!sku) missing.push("Código interno");
  else {
    if (sku.length > ITEM_LIMITS.sku) errors.push(`Código: máximo ${ITEM_LIMITS.sku} caracteres`);
    if (!/^[A-Za-z0-9._-]+$/.test(sku)) errors.push("Código: solo letras, números, punto, guion y guion bajo");
  }
  if (!description) missing.push("Descripción para la factura");
  else if (description.length > ITEM_LIMITS.description) errors.push(`Descripción: máximo ${ITEM_LIMITS.description} caracteres`);

  // Identification scheme and standard code
  const scheme = ITEM_ID_SCHEMES.find((s) => s.code === input.idScheme);
  if (!scheme) {
    errors.push("Esquema de identificación inválido");
  } else if (scheme.kind !== "own") {
    if (!standardCode) {
      missing.push(scheme.standardCodeLabel);
    } else if (scheme.kind === "gtin") {
      if (gtinValid(standardCode)) standardCode = standardCode.padStart(scheme.length, "0");
      else errors.push("GTIN inválido: 8, 12, 13 o 14 dígitos con dígito de control GS1");
    } else if (!new RegExp(`^\\d{${scheme.length}}$`).test(standardCode)) {
      errors.push(`${scheme.standardCodeLabel.replace(/^Código /, "")}: exactamente ${scheme.length} dígitos`);
    }
  }

  if (!UOM_CODES.some((u) => u.code === input.uomCode)) errors.push("Unidad de medida fuera de la tabla UN/ECE");
  if (!IVA_RATES.some((r) => r.code === input.ivaRate)) errors.push("Tarifa de IVA inválida");
  if (input.incRate !== undefined && !INC_RATES.some((r) => r.code === input.incRate)) errors.push("Tarifa de INC inválida");
  for (const tax of input.otherTaxes) {
    if (!OTHER_TAXES.some((t) => t.code === tax)) errors.push(`Impuesto adicional inválido: ${tax}`);
  }
  if (brand && brand.length > ITEM_LIMITS.brand) errors.push(`Marca: máximo ${ITEM_LIMITS.brand} caracteres`);
  if (model && model.length > ITEM_LIMITS.model) errors.push(`Modelo: máximo ${ITEM_LIMITS.model} caracteres`);

  // Prices
  const negative = input.listPrice < 0 || (input.standardCost !== undefined && input.standardCost < 0);
  if (negative) errors.push("Precio y costo no pueden ser negativos");
  else if (!input.isFreeSample && !(input.listPrice > 0)) {
    errors.push("Precio de lista debe ser mayor que cero (o marca el producto como muestra gratuita)");
  }
  if (input.isFreeSample) {
    if (!input.referencePriceType || !PRICE_TYPES.some((t) => t.code === input.referencePriceType)) {
      errors.push("Tipo de precio de referencia inválido");
    }
    if (!(input.referencePrice !== undefined && input.referencePrice > 0)) {
      errors.push("Precio de referencia de la muestra gratuita debe ser mayor que cero");
    }
  }
  if (input.kind === "good" && input.standardCost === undefined) missing.push("Costo estándar");

  // Stock
  if (input.kind === "service" && input.trackStock) errors.push("Un servicio no controla existencias");
  if (input.minStock !== undefined && input.minStock < 0) errors.push("Existencias mínimas no pueden ser negativas");

  return {
    errors,
    missing,
    normalized: {
      ...input,
      sku,
      description,
      standardCode,
      brand,
      model,
      trackStock: input.kind === "service" ? false : input.trackStock,
    },
  };
}
