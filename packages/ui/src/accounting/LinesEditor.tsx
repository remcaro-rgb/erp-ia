"use client";

import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { useTranslations } from "next-intl";
import { X } from "lucide-react";
import { formatMoney, MoneyInput } from "../money";
import { blankLine, lineTotals, nextFocus, type Chosen, type EditorLine, type LineColumn } from "./entry-model";

// The lines of a comprobante, keyboard first (accounting design §4.7, §8): Tab walks account → tercero → centro de costo →
// auxiliar abierto → ítem → unidad de negocio → débito → crédito, Enter on the last cell opens another line. The optional
// dimension columns exist only while the company uses them; the business unit cell shows the header's value, greyed, until the
// line sets its own. A line on a restricted account comes masked (`••••`) and is not editable. Totals and the difference sit in
// the footer.

/** What a lookup cell searches. */
export type LookupKind = "account" | "party" | "costCenter" | "openAuxiliary" | "item" | "businessUnit";
/** Searches the records of one kind by text (the app answers with the viewer's own permissions). The account lookup lists only accounts the viewer may post to. */
export type LineLookup = (kind: LookupKind, search: string, signal?: AbortSignal) => Promise<Chosen[]>;

const LABEL_KEY: Record<LineColumn, string> = {
  account: "account", party: "party", costCenter: "cost_center", openAuxiliary: "open_auxiliary", item: "item", businessUnit: "business_unit", debit: "debit", credit: "credit",
};
const FIELD: Record<Exclude<LineColumn, "debit" | "credit">, keyof EditorLine> = {
  account: "account", party: "party", costCenter: "costCenter", openAuxiliary: "openAuxiliary", item: "item", businessUnit: "businessUnit",
};

export interface LinesEditorProps {
  lines: readonly EditorLine[];
  onChange: (lines: EditorLine[]) => void;
  columns: readonly LineColumn[];
  lookup: LineLookup;
  /** The header's business unit, shown greyed in a line's own cell while it has none. */
  headerBusinessUnit?: string | null;
  readOnly?: boolean;
  /** The comprobante's own totals, shown when a restricted line hides part of the sum. */
  knownTotals?: { debit: number; credit: number } | null;
  debounceMs?: number;
}

const MASK = "••••";

export function LinesEditor({ lines, onChange, columns, lookup, headerBusinessUnit = null, readOnly = false, knownTotals = null, debounceMs = 150 }: LinesEditorProps) {
  const t = useTranslations("common.entry");
  const tableRef = useRef<HTMLTableElement>(null);
  const [focusAt, setFocusAt] = useState<{ row: number; col: number } | null>(null);

  // A move onto a line that was just added waits for the render that holds it.
  useEffect(() => {
    if (!focusAt) return;
    tableRef.current?.querySelector<HTMLElement>(`[data-cell="${focusAt.row}:${focusAt.col}"]`)?.focus();
    setFocusAt(null);
  }, [focusAt, lines.length]);

  const edit = (index: number, patch: Partial<EditorLine>) => onChange(lines.map((l, i) => (i === index ? { ...l, ...patch } : l)));
  const remove = (index: number) => {
    if (lines.length <= 1) onChange([blankLine()]);
    else onChange(lines.filter((_, i) => i !== index));
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTableElement>) => {
    const target = event.target as HTMLElement;
    const where = target.getAttribute("data-cell")?.split(":").map(Number);
    if (!where || where.length !== 2) return;
    const [row, col] = where as [number, number];
    if (event.key === "Backspace" && event.ctrlKey && !readOnly && lines.length > 0) {
      event.preventDefault();
      remove(row);
      setFocusAt({ row: Math.min(row, Math.max(lines.length - 2, 0)), col });
      return;
    }
    if ((event.key !== "Tab" && event.key !== "Enter") || event.ctrlKey || event.metaKey || event.altKey) return;
    const current = lines[row];
    const move = nextFocus({
      columns, rows: lines.length, row, col, key: event.key, shift: event.shiftKey,
      rowFilled: !!current && (!!current.account || !!current.debit || !!current.credit),
    });
    if (!move) return;
    event.preventDefault();
    if (move.addLine) onChange([...lines, blankLine()]);
    // Focus after the lookup cell that chose an option on this same key has settled.
    setFocusAt({ row: move.row, col: move.col });
  };

  const totals = lineTotals(lines);
  const shown = totals.partial && knownTotals ? { debit: knownTotals.debit, credit: knownTotals.credit, difference: Math.round((knownTotals.debit - knownTotals.credit) * 10_000) / 10_000 } : totals;
  const balanced = shown.difference === 0;

  return (
    <div className="erp-lines">
      <div className="erp-lines__scroll">
        <table ref={tableRef} className="erp-lines__table" aria-label={t("lines_label")} onKeyDown={onKeyDown}>
          <thead>
            <tr>
              <th scope="col" className="erp-lines__no">
                #
              </th>
              {columns.map((c) => (
                <th key={c} scope="col" className={c === "debit" || c === "credit" ? "erp-num" : undefined}>
                  {t(`col.${LABEL_KEY[c]}`)}
                </th>
              ))}
              <th scope="col" className="erp-lines__act" aria-label={t("add_line")} />
            </tr>
          </thead>
          <tbody>
            {lines.map((line, row) => (
              <tr key={line.key} data-restricted={line.restricted ? "" : undefined}>
                <td className="erp-lines__no erp-muted">{row + 1}</td>
                {line.restricted ? (
                  <td colSpan={columns.length} className="erp-lines__masked" title={t("restricted_line")}>
                    <span aria-hidden="true">{MASK}</span> <span className="erp-small erp-muted">{t("restricted_line")}</span>
                  </td>
                ) : (
                  columns.map((c, col) => (
                    <td key={c} className={c === "debit" || c === "credit" ? "erp-num" : undefined}>
                      {c === "debit" || c === "credit" ? (
                        <MoneyInput
                          data-cell={`${row}:${col}`}
                          aria-label={`${t(`col.${LABEL_KEY[c]}`)}, ${t("line_n", { n: row + 1 })}`}
                          disabled={readOnly}
                          value={line[c]}
                          onChange={(value) => {
                            const amount = value && value > 0 ? value : null;
                            // A line carries one side: an amount on one side clears the other.
                            edit(row, c === "debit" ? { debit: amount, ...(amount ? { credit: null } : {}) } : { credit: amount, ...(amount ? { debit: null } : {}) });
                          }}
                        />
                      ) : (
                        <LookupCell
                          cell={`${row}:${col}`}
                          label={`${t(`col.${LABEL_KEY[c]}`)}, ${t("line_n", { n: row + 1 })}`}
                          kind={c}
                          value={line[FIELD[c]] as Chosen | null}
                          placeholder={c === "businessUnit" && !line.businessUnit ? (headerBusinessUnit ?? undefined) : undefined}
                          inherit={c === "businessUnit" && !line.businessUnit && !!headerBusinessUnit}
                          disabled={readOnly}
                          lookup={lookup}
                          debounceMs={debounceMs}
                          onPick={(picked) => edit(row, { [FIELD[c]]: picked } as Partial<EditorLine>)}
                        />
                      )}
                    </td>
                  ))
                )}
                <td className="erp-lines__act">
                  {!readOnly && (
                    <button type="button" className="erp-iconbtn" tabIndex={-1} aria-label={t("remove_line", { n: row + 1 })} onClick={() => remove(row)}>
                      <X size={14} aria-hidden="true" />
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="erp-lines__foot" role="group" aria-label={t("totals_label")}>
        {!readOnly && (
          <button type="button" className="erp-btn" onClick={() => { onChange([...lines, blankLine()]); setFocusAt({ row: lines.length, col: 0 }); }}>
            {t("add_line")}
          </button>
        )}
        <span className="erp-grow erp-small erp-muted">{!readOnly && t("keyboard_hint")}</span>
        <span>
          {t("total_debit")} <b className="erp-num" data-total="debit">{formatMoney(shown.debit)}</b>
        </span>
        <span>
          {t("total_credit")} <b className="erp-num" data-total="credit">{formatMoney(shown.credit)}</b>
        </span>
        <span className={balanced ? "erp-lines__diff is-ok" : "erp-lines__diff is-bad"}>
          {t("difference")} <b className="erp-num" data-total="difference">{formatMoney(shown.difference)}</b>
        </span>
        <span role="status" className={balanced ? "erp-pill erp-pill--ok" : "erp-pill erp-pill--danger"}>
          {balanced ? t("balanced") : t("unbalanced", { amount: formatMoney(Math.abs(shown.difference)) })}
        </span>
      </div>
    </div>
  );
}

export interface LookupCellProps {
  cell: string;
  label: string;
  kind: LookupKind;
  value: Chosen | null;
  placeholder: string | undefined;
  inherit: boolean;
  disabled: boolean;
  lookup: LineLookup;
  debounceMs: number;
  onPick: (value: Chosen | null) => void;
  /** The cell's accessible name when it is not a cell of the lines table. */
}

/**
 * A lookup inside a cell: a box that searches as the user types, with the list under it. Arrows move in the list; Enter or Tab
 * choose the highlighted option when the user searched (a list that merely opened chooses nothing), then the editor moves on.
 */
export function LookupCell({ cell, label, kind, value, placeholder, inherit, disabled, lookup, debounceMs, onPick }: LookupCellProps) {
  const t = useTranslations("common.entry");
  const listId = useId();
  const [text, setText] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<Chosen[]>([]);
  const [highlight, setHighlight] = useState(0);
  const [searched, setSearched] = useState(false);
  const lookupRef = useRef(lookup);
  useEffect(() => {
    lookupRef.current = lookup;
  });

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      lookupRef.current(kind, text ?? "", controller.signal).then(
        (rows) => {
          if (controller.signal.aborted) return;
          setItems(rows);
          setHighlight(0);
        },
        () => !controller.signal.aborted && setItems([]),
      );
    }, debounceMs);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [open, text, kind, debounceMs]);

  const close = () => {
    setOpen(false);
    setText(null);
    setSearched(false);
  };
  const choose = (picked: Chosen) => {
    onPick(picked);
    close();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setOpen(true);
      setSearched(true);
      setHighlight((h) => (items.length === 0 ? 0 : (h + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length));
    } else if (event.key === "Escape" && open) {
      event.stopPropagation();
      close();
    } else if ((event.key === "Enter" || event.key === "Tab") && !event.shiftKey && open && searched && items[highlight]) {
      // The editor's own handler (a parent) moves the caret afterwards; the choice is made first.
      choose(items[highlight]);
    } else if (event.key === "Backspace" && (text ?? "") === "" && value) {
      onPick(null);
    }
  };

  return (
    <div className="erp-lines__lookup">
      <input
        data-cell={cell}
        role="combobox"
        aria-label={label}
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        autoComplete="off"
        disabled={disabled}
        className={inherit ? "erp-lines__inherit" : undefined}
        placeholder={placeholder}
        value={text ?? value?.label ?? ""}
        onFocus={(event) => {
          setOpen(true);
          event.currentTarget.select();
        }}
        onBlur={close}
        onChange={(event) => {
          setText(event.target.value);
          setSearched(true);
          setOpen(true);
        }}
        onKeyDown={onKeyDown}
      />
      {open && (
        <ul id={listId} role="listbox" aria-label={label} className="erp-lines__list">
          {items.length === 0 ? (
            <li role="presentation" className="erp-muted erp-small">
              {searched ? t("lookup_empty") : t("lookup_hint")}
            </li>
          ) : (
            items.map((item, index) => (
              <li
                key={item.id}
                id={`${listId}-${index}`}
                role="option"
                aria-selected={index === highlight}
                className={index === highlight ? "is-active" : undefined}
                // Mouse down, not click: the box would lose focus (and close the list) before the click lands.
                onMouseDown={(event) => {
                  event.preventDefault();
                  choose(item);
                }}
              >
                {item.label}
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  );
}
