// "Guardar como plantilla" (accounting design §4.10): the lines of a stored comprobante as the lines of a plantilla de comprobante.

type Row = Record<string, unknown>;

export interface TemplateLineInput {
  accountId: string;
  side: "debit" | "credit";
  amount?: number;
  partyId?: string;
  costCenterId?: string;
  openAuxiliaryId?: string;
  itemId?: string;
  businessUnitId?: string;
  description?: string;
}

const text = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);

/** The comprobante's lines as template lines; `blankAmounts` leaves every amount open (asked at use). Fails on no lines or a line the viewer cannot see (restricted account). */
export function templateLinesOf(lines: readonly Row[], blankAmounts: boolean): { ok: true; lines: TemplateLineInput[] } | { ok: false } {
  if (lines.length === 0) return { ok: false };
  const out: TemplateLineInput[] = [];
  for (const line of [...lines].sort((a, b) => Number(a.line_no) - Number(b.line_no))) {
    const accountId = text(line.account_id);
    if (line.is_restricted === true || !accountId) return { ok: false };
    const debit = Number(line.debit ?? 0);
    const credit = Number(line.credit ?? 0);
    const side = debit > 0 ? "debit" : "credit";
    const optional = {
      amount: blankAmounts ? undefined : side === "debit" ? debit : credit,
      partyId: text(line.party_id),
      costCenterId: text(line.cost_center_id),
      openAuxiliaryId: text(line.open_auxiliary_id),
      itemId: text(line.item_id),
      businessUnitId: text(line.business_unit_id),
      description: text(line.description),
    };
    out.push({ accountId, side, ...(Object.fromEntries(Object.entries(optional).filter(([, v]) => v !== undefined)) as Partial<TemplateLineInput>) });
  }
  return { ok: true, lines: out };
}
