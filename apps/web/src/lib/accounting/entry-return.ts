// "Devolver a borrador" (accounting design §5.5): a pending comprobante goes back to a draft through `accounting.entry.update`, which
// replaces the header and the lines and sets the status to draft. This is the update input that keeps exactly what the entry holds.
// A comprobante with lines on restricted accounts cannot be returned: their figures come masked, so they cannot be sent back.

type Row = Record<string, unknown>;

const dateText = (value: unknown): string => (value instanceof Date ? value.toISOString().slice(0, 10) : String(value ?? "").slice(0, 10));
const idOrNull = (value: unknown): string | null => (typeof value === "string" && value ? value : null);
const text = (value: unknown): string | null => (typeof value === "string" && value.trim() !== "" ? value : null);

/** True when some line is masked: the entry cannot be sent back to a draft by a viewer who cannot see all of it. */
export const hasRestrictedLines = (entry: Row): boolean => Array.isArray(entry.lines) && (entry.lines as Row[]).some((l) => l.is_restricted === true);

/** The input of `accounting.entry.update` that restores the comprobante as a draft, unchanged. */
export function returnToDraftInput(entry: Row): Record<string, unknown> {
  const lines = Array.isArray(entry.lines) ? (entry.lines as Row[]) : [];
  return {
    id: entry.id,
    journalId: entry.journal_id,
    date: dateText(entry.date),
    description: entry.description,
    currency: typeof entry.currency === "string" ? entry.currency : "COP",
    exchangeRate: Number(entry.exchange_rate ?? 1),
    businessUnitId: idOrNull(entry.business_unit_id),
    reverseOn: entry.reverse_on ? dateText(entry.reverse_on) : null,
    lines: lines.map((l) => ({
      accountId: l.account_id,
      partyId: idOrNull(l.party_id),
      costCenterId: idOrNull(l.cost_center_id),
      openAuxiliaryId: idOrNull(l.open_auxiliary_id),
      itemId: idOrNull(l.item_id),
      businessUnitId: idOrNull(l.business_unit_id),
      description: text(l.description),
      debit: Number(l.debit ?? 0),
      credit: Number(l.credit ?? 0),
      taxCode: text(l.tax_code),
      taxRate: l.tax_rate === null || l.tax_rate === undefined ? null : Number(l.tax_rate),
      taxBase: l.tax_base === null || l.tax_base === undefined ? null : Number(l.tax_base),
      reference: text(l.reference),
      dueDate: l.due_date ? dateText(l.due_date) : null,
    })),
  };
}
