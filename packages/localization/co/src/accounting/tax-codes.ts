type TaxCode = { code: string; family: "IVA" | "INC" | "RTEFTE" | "RTEIVA" | "RTEICA"; rate: number | null; label: string };

/** The codes a posting rule line may put in `taxCode`; the rate is a percentage, null when it varies by concept. */
export const taxCodes = (): TaxCode[] => [
  { code: "IVA19", family: "IVA", rate: 19, label: "IVA tarifa general 19%" },
  { code: "IVA5", family: "IVA", rate: 5, label: "IVA tarifa reducida 5%" },
  { code: "IVA0", family: "IVA", rate: 0, label: "IVA tarifa 0%" },
  { code: "EXC", family: "IVA", rate: null, label: "Excluido de IVA" },
  { code: "INC2", family: "INC", rate: 2, label: "Impuesto nacional al consumo 2%" },
  { code: "INC4", family: "INC", rate: 4, label: "Impuesto nacional al consumo 4%" },
  { code: "INC8", family: "INC", rate: 8, label: "Impuesto nacional al consumo 8%" },
  { code: "INC16", family: "INC", rate: 16, label: "Impuesto nacional al consumo 16%" },
  { code: "RTEFTE", family: "RTEFTE", rate: null, label: "Retención en la fuente" },
  { code: "RTEIVA", family: "RTEIVA", rate: 15, label: "Retención de IVA 15% del impuesto" },
  { code: "RTEICA", family: "RTEICA", rate: null, label: "Retención de industria y comercio" },
];
