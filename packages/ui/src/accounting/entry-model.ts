// The pure rules of the comprobante record (accounting design §4.6, §4.7, §5.5, §8): which line columns show, how the keyboard moves
// through the lines editor, the totals, what the status bar offers and how the form's data becomes the process input.

/** A chosen record of a lookup cell: its id and how it reads. */
export interface Chosen {
  id: string;
  label: string;
}

/** The columns of the lines editor, in Tab order. */
export type LineColumn = "account" | "party" | "costCenter" | "openAuxiliary" | "item" | "businessUnit" | "description" | "debit" | "credit";

/** The company settings the comprobante depends on (`accounting.settings.consult`). */
export interface EntrySettings {
  requireApprovalOnManual: boolean;
  useOpenAuxiliaries: boolean;
  useItems: boolean;
  useBusinessUnits: boolean;
  requireAttachmentOnManual?: boolean;
}

/** One row of the editor. `key` is the row's identity in the browser (never sent). */
export interface EditorLine {
  key: string;
  account: Chosen | null;
  party: Chosen | null;
  costCenter: Chosen | null;
  openAuxiliary: Chosen | null;
  item: Chosen | null;
  businessUnit: Chosen | null;
  description: string;
  debit: number | null;
  credit: number | null;
  /** The line is on an account the viewer may not see: its figures and links come masked and it is not editable. */
  restricted: boolean;
}

const round4 = (value: number) => Math.round(value * 10_000) / 10_000;

let counter = 0;
/** An empty row with a fresh identity. */
export const blankLine = (): EditorLine => ({
  key: `line-${++counter}`, account: null, party: null, costCenter: null, openAuxiliary: null, item: null, businessUnit: null, description: "", debit: null, credit: null, restricted: false,
});

/** Debit and credit sums (four decimals), their difference, and whether a restricted line hides part of them. */
export function lineTotals(lines: readonly EditorLine[]): { debit: number; credit: number; difference: number; partial: boolean } {
  let debit = 0;
  let credit = 0;
  for (const l of lines) {
    debit += l.debit ?? 0;
    credit += l.credit ?? 0;
  }
  return { debit: round4(debit), credit: round4(credit), difference: round4(debit - credit), partial: lines.some((l) => l.restricted) };
}

/** Whether any line carries an amount: an entry with none is empty, not balanced. */
export const hasAmounts = (lines: readonly EditorLine[]): boolean => lines.some((l) => (l.debit ?? 0) !== 0 || (l.credit ?? 0) !== 0);

export type EntryProblem = "date" | "description" | "lines" | "account" | "unbalanced";

/** What still stands between the form and a complete entry, in the order the form shows it (restricted lines hide figures, so they add none). */
export function entryProblems(header: { description: string; date: string }, lines: readonly EditorLine[]): EntryProblem[] {
  const problems: EntryProblem[] = [];
  if (header.date === "") problems.push("date");
  if (header.description.trim() === "") problems.push("description");
  if (!hasAmounts(lines)) problems.push("lines");
  if (lines.some((l) => !l.restricted && !l.account && ((l.debit ?? 0) !== 0 || (l.credit ?? 0) !== 0))) problems.push("account");
  const totals = lineTotals(lines);
  if (hasAmounts(lines) && !totals.partial && totals.difference !== 0) problems.push("unbalanced");
  return problems;
}

/** The editor's columns: the three optional dimensions only while the company uses them (§4.11). */
export function visibleColumns(settings: PickOf<EntrySettings, "useOpenAuxiliaries" | "useItems" | "useBusinessUnits">): LineColumn[] {
  return [
    "account", "party", "costCenter",
    ...(settings.useOpenAuxiliaries ? (["openAuxiliary"] as const) : []),
    ...(settings.useItems ? (["item"] as const) : []),
    ...(settings.useBusinessUnits ? (["businessUnit"] as const) : []),
    "description", "debit", "credit",
  ];
}
/** The `entry_lines` fields an export prints for the columns on screen: the line number, then each column in order. */
export function lineExportFields(columns: readonly LineColumn[]): string[] {
  const field: Record<LineColumn, string> = {
    account: "account_id", party: "party_id", costCenter: "cost_center_id", openAuxiliary: "open_auxiliary_id", item: "item_id", businessUnit: "business_unit_id", description: "description", debit: "debit", credit: "credit",
  };
  return ["line_no", ...columns.map((c) => field[c])];
}
type PickOf<T, K extends keyof T> = { [P in K]: T[P] };

export interface FocusInput {
  columns: readonly LineColumn[];
  rows: number;
  row: number;
  col: number;
  key: "Tab" | "Enter";
  shift: boolean;
  /** The row has an account or an amount: only then does Tab at the end of the last row open another line. */
  rowFilled: boolean;
}
export interface FocusMove {
  row: number;
  col: number;
  /** The move lands on a line that does not exist yet: the editor adds it first. */
  addLine: boolean;
}

/**
 * Where the caret goes next. Tab walks the columns and then the next row; Shift+Tab goes back; Enter moves like Tab but at the
 * last cell of the last row always opens a line. Null: leave the move to the browser (Tab out of the table).
 */
export function nextFocus({ columns, rows, row, col, key, shift, rowFilled }: FocusInput): FocusMove | null {
  const last = columns.length - 1;
  if (shift) {
    if (col > 0) return { row, col: col - 1, addLine: false };
    return row > 0 ? { row: row - 1, col: last, addLine: false } : null;
  }
  if (col < last) return { row, col: col + 1, addLine: false };
  if (row < rows - 1) return { row: row + 1, col: 0, addLine: false };
  return key === "Enter" || rowFilled ? { row: rows, col: 0, addLine: true } : null;
}

export type EntryAction = "submit" | "approve" | "return" | "post" | "reverse" | "void" | "delete";

export interface EntryFacts {
  status: string;
  origin: string;
  createdBy: string | null;
  isClosing?: boolean;
  reversalOfId?: string | null;
  /** The comprobante's Requiere aprobación (the row's flag, entity types spec §5.1); unknown falls back to the company setting. */
  requiresApproval?: boolean;
  /** Already reversed: it stays Contabilizado with the mark (D2). */
  reversed?: boolean;
}
export interface ActionState {
  action: EntryAction;
  disabled?: boolean;
  /** i18n key of the reason a button is disabled. */
  hint?: string;
}

/** The states whose header and lines the form edits (D3): Borrador, Grabado and No Aprobado. */
export const isEditableStatus = (status: string): boolean => status === "draft" || status === "saved" || status === "rejected";

/**
 * The buttons the status bar offers (accounting design §4.6, §5.5; entity types spec §5, D2, D8): by status and by Requiere
 * aprobación. Without approval a Borrador is posted by Grabar (`post`); with approval it is sent (`submit`: Grabar, then Enviar a
 * aprobación), another person approves it when the four-eyes control is on (the creator's button is disabled with the reason), and
 * No Aprobar (`return`) hands it back as No Aprobado, which is sent again. A Borrador is deleted; a Grabado, Pendiente or No Aprobado
 * one is voided. A posted entry is reversed unless it is a reversal, a year-closing one or already reversed.
 */
export function allowedActions(entry: EntryFacts, settings: PickOf<EntrySettings, "requireApprovalOnManual">, userId: string, may: { canReturn?: boolean } = {}): ActionState[] {
  const approval = entry.origin !== "auto" && (entry.requiresApproval ?? settings.requireApprovalOnManual);
  if (entry.status === "draft") return [{ action: approval ? "submit" : "post" }, { action: "delete" }];
  if (entry.status === "saved" || entry.status === "rejected") return [{ action: approval ? "submit" : "post" }, { action: "void" }];
  if (entry.status === "pending") {
    const own = settings.requireApprovalOnManual && entry.origin !== "auto" && entry.createdBy !== null && entry.createdBy === userId;
    return [
      { action: "approve", ...(own ? { disabled: true, hint: "accounting.entry.same_user" } : {}) },
      ...(may.canReturn === false ? [] : [{ action: "return" } as const]),
      { action: "void" },
    ];
  }
  if (entry.status === "posted" && !entry.reversalOfId && !entry.isClosing && !entry.reversed) return [{ action: "reverse" }];
  return [];
}

/** The header of the form as strings, the way inputs hold them. */
export interface EntryHeader {
  journalId: string;
  date: string;
  description: string;
  businessUnit: Chosen | null;
  reverseOn: string;
}

const text = (value: unknown): string => (value === null || value === undefined ? "" : String(value));
const dateText = (value: unknown): string => (value instanceof Date ? value.toISOString().slice(0, 10) : text(value).slice(0, 10));
const amountOrNull = (value: unknown): number | null => {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) && n !== 0 ? n : null;
};
const labelled = (labels: Readonly<Record<string, string>>, id: unknown): Chosen | null => (typeof id === "string" && id ? { id, label: labels[id] ?? id } : null);

/**
 * A consult row (header and lines, restricted lines masked) as the form edits it. `labels` reads the linked records by id
 * (party, dimensions, header business unit) as the loader resolved them for the viewer.
 */
export function entryDraftOf(record: Readonly<Record<string, unknown>> | null, labels: Readonly<Record<string, string>> = {}): { header: EntryHeader; lines: EditorLine[] } {
  const header: EntryHeader = {
    journalId: text(record?.journal_id),
    date: dateText(record?.date),
    description: text(record?.description),
    businessUnit: labelled(labels, record?.business_unit_id),
    reverseOn: dateText(record?.reverse_on),
  };
  const rows = Array.isArray(record?.lines) ? (record.lines as Record<string, unknown>[]) : [];
  const lines = rows.map((row): EditorLine => {
    if (row.is_restricted === true) return { ...blankLine(), restricted: true };
    const code = text(row.account_code);
    return {
      ...blankLine(),
      account: typeof row.account_id === "string" ? { id: row.account_id, label: code ? `${code} · ${text(row.account_name)}` : (labels[row.account_id] ?? row.account_id) } : null,
      party: labelled(labels, row.party_id),
      costCenter: labelled(labels, row.cost_center_id),
      openAuxiliary: labelled(labels, row.open_auxiliary_id),
      item: labelled(labels, row.item_id),
      businessUnit: labelled(labels, row.business_unit_id),
      description: text(row.description),
      debit: amountOrNull(row.debit),
      credit: amountOrNull(row.credit),
    };
  });
  return { header, lines };
}

/** True for a row with nothing in it: it is left out of the input. */
export const isBlank = (l: EditorLine): boolean => !l.account && !l.debit && !l.credit && !l.party && !l.costCenter && !l.openAuxiliary && !l.item && !l.businessUnit && l.description.trim() === "";

/** The input of `accounting.entry.create / update` (header strings turned into ids and nulls, empty rows dropped). */
export function entryInput(
  header: { journalId?: string; date: string; description: string; businessUnitId?: string | null; reverseOn?: string | null },
  lines: readonly EditorLine[],
): Record<string, unknown> {
  return {
    ...(header.journalId ? { journalId: header.journalId } : {}),
    date: header.date,
    description: header.description,
    businessUnitId: header.businessUnitId || null,
    reverseOn: header.reverseOn || null,
    lines: lines
      .filter((l) => !isBlank(l))
      .map((l) => ({
        accountId: l.account?.id,
        partyId: l.party?.id ?? null,
        costCenterId: l.costCenter?.id ?? null,
        openAuxiliaryId: l.openAuxiliary?.id ?? null,
        itemId: l.item?.id ?? null,
        businessUnitId: l.businessUnit?.id ?? null,
        description: l.description.trim() || null,
        debit: l.debit ?? 0,
        credit: l.credit ?? 0,
      })),
  };
}
