"use client";

import { useEffect, useId, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Search, X } from "lucide-react";
import { AdvancedFilter } from "../grid/AdvancedFilter";
import { ConditionChips } from "../grid/ConditionChips";
import { dianPill, stateFilters } from "../grid/grid-model";
import { Pill } from "../grid/GridCell";
import type { Condition, GridColumn, GridFetcher, GridRow, GridStateInput } from "../grid/types";
import { invoiceBlockers, moveHighlight, type InvoiceBlocker } from "./lookup-model";

type Filter = NonNullable<GridStateInput["filters"]>[number];

export interface EntityLookupProps {
  id?: string;
  "aria-label"?: string;
  /** The entity's name, for the advanced filter's title. */
  entityLabel: string;
  /** Reads the entity through the grid route (`search` matches its searchable fields). */
  fetcher: GridFetcher;
  /** Every field the advanced filter offers. */
  fields: readonly GridColumn[];
  /** Columns of the advanced filter's live results; the fields not filter-only by default. */
  previewColumns?: readonly GridColumn[];
  /** How a record reads in the list and in the box. */
  describe: (row: GridRow) => { label: string; sub?: string };
  /** The record chosen, as the box shows it. */
  value?: { id: string; label: string } | null;
  /** A record was chosen, or the choice was cleared (null). */
  onPick: (row: GridRow | null) => void;
  /** Records that are not invoice-ready show disabled with their reasons (design §5.17). */
  forInvoice?: boolean;
  /** Filters every search carries (`kind = supplier` for a supplier box). */
  baseFilters?: Filter[];
  placeholder?: string;
  disabled?: boolean;
  /** Rows of the dropdown. */
  limit?: number;
  debounceMs?: number;
}

/**
 * The entity lookup (design §9, prototype `lookupHtml`): a text box that searches the entity's searchable fields as
 * the user types, a dropdown with the DIAN status (and, for invoices, whether each record can be used), arrow keys and
 * Enter, and the magnifier at the right that opens the advanced filter to pick a record without leaving the form.
 */
export function EntityLookup(props: EntityLookupProps) {
  const { fetcher, fields, describe, value, onPick, forInvoice = false, baseFilters, disabled, limit = 8, debounceMs = 200 } = props;
  const t = useTranslations();
  const listId = useId();
  const [text, setText] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<GridRow[] | null>(null);
  const [highlight, setHighlight] = useState(0);
  const [conditions, setConditions] = useState<Condition[]>([]);
  const [message, setMessage] = useState("");
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const fetcherRef = useRef(fetcher);
  useEffect(() => {
    fetcherRef.current = fetcher;
  }, [fetcher]);

  // A new value from the form replaces whatever was typed.
  const valueId = value?.id ?? null;
  const [seenValue, setSeenValue] = useState(valueId);
  if (seenValue !== valueId) {
    setSeenValue(valueId);
    setText(null);
  }

  const shown = text ?? value?.label ?? "";
  const filters = stateFilters(fields, { columnFilters: {}, conditions }, baseFilters);
  const query = JSON.stringify({ search: open ? shown.trim() : null, filters });

  useEffect(() => {
    if (!open) return;
    const { search, filters: sent } = JSON.parse(query) as { search: string; filters: Filter[] };
    const controller = new AbortController();
    const timer = setTimeout(() => {
      fetcherRef.current({ filters: sent, sort: [], page: 1, pageSize: limit, ...(search ? { search } : {}) }, controller.signal).then(
        (page) => {
          if (controller.signal.aborted) return;
          setItems(page.rows);
          setHighlight((h) => (h < page.rows.length ? h : 0));
        },
        () => !controller.signal.aborted && setItems([]),
      );
    }, debounceMs);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [open, query, limit, debounceMs]);

  const reasonText = (blockers: InvoiceBlocker[]) =>
    blockers
      .map((b) =>
        b.key === "dian" ? t("grid.lookup.reason_dian", { items: b.items.join(", ") }) : t(`grid.lookup.reason_${b.key === "dian_errors" ? "dian_errors" : b.key === "inactive" ? "inactive" : "files"}`),
      )
      .join("; ");
  const blockedReason = (row: GridRow): string | null => {
    if (!forInvoice) return null;
    const blockers = invoiceBlockers(row);
    return blockers.length > 0 ? reasonText(blockers) : null;
  };

  const choose = (row: GridRow) => {
    const reason = blockedReason(row);
    if (reason) {
      setMessage(t("grid.adv.not_invoiceable", { reasons: reason }));
      return;
    }
    const { label } = describe(row);
    setText(label);
    setOpen(false);
    setMessage(t("grid.lookup.picked", { label }));
    onPick(row);
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    const list = items ?? [];
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!open) setOpen(true);
      setHighlight((h) => moveHighlight(h, list.length, event.key === "ArrowDown" ? 1 : -1));
    } else if (event.key === "Enter" && open && list[highlight]) {
      event.preventDefault();
      choose(list[highlight]!);
    } else if (event.key === "Escape") {
      setOpen(false);
    }
  };

  const list = items ?? [];
  const optionId = (i: number) => `${listId}-option-${i}`;
  return (
    <div className="erp-lk">
      <input
        id={props.id}
        role="combobox"
        aria-label={props["aria-label"]}
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={open && list[highlight] ? optionId(highlight) : undefined}
        autoComplete="off"
        className="erp-lk__input"
        placeholder={props.placeholder ?? t("grid.lookup.placeholder")}
        disabled={disabled}
        value={shown}
        onChange={(e) => {
          setText(e.target.value);
          setOpen(true);
          setHighlight(0);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={onKeyDown}
      />
      {value && !disabled && (
        <button type="button" className="erp-lk__clear" aria-label={t("grid.lookup.clear")} onMouseDown={(e) => e.preventDefault()} onClick={() => (setText(""), onPick(null))}>
          <X aria-hidden="true" className="erp-icon" />
        </button>
      )}
      <button
        type="button"
        className={conditions.length > 0 ? "erp-lk__mag is-on" : "erp-lk__mag"}
        aria-label={t("grid.advanced_filter")}
        title={t("grid.advanced_filter")}
        disabled={disabled}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => setAdvancedOpen(true)}
      >
        <Search aria-hidden="true" className="erp-icon" />
      </button>
      {open && items !== null && (
        <div className="erp-lk__dd">
          <ul id={listId} role="listbox" aria-label={props["aria-label"]}>
            {list.map((row, i) => {
              const { label, sub } = describe(row);
              const reason = blockedReason(row);
              const pill = dianPill(row.dian_status);
              return (
                <li
                  key={row.id}
                  id={optionId(i)}
                  role="option"
                  aria-selected={i === highlight ? "true" : "false"}
                  aria-disabled={reason ? true : undefined}
                  title={reason ? t("grid.adv.not_invoiceable", { reasons: reason }) : undefined}
                  className={["erp-lk__item", i === highlight && "is-on", reason && "is-blocked"].filter(Boolean).join(" ")}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    choose(row);
                  }}
                >
                  <span className="erp-grow">
                    <span className="erp-lk__label">{label}</span>
                    {sub && <span className="erp-small erp-muted erp-lk__sub">{sub}</span>}
                  </span>
                  {pill && <Pill tone={pill.tone}>{t(`grid.dian.${pill.key}`, { count: pill.count })}</Pill>}
                  {forInvoice && <Pill tone={reason ? "danger" : "ok"}>{reason ? t("grid.lookup.invoice_no") : t("grid.lookup.invoice_ok")}</Pill>}
                </li>
              );
            })}
            {list.length === 0 && <li className="erp-lk__item erp-muted">{t("grid.lookup.none")}</li>}
          </ul>
          <div className="erp-lk__ft">
            <span>
              {t("grid.lookup.results", { count: list.length })}
              {conditions.length > 0 && ` · ${t("grid.lookup.conditions", { count: conditions.length })}`}
            </span>
          </div>
          {conditions.length > 0 && (
            <div className="erp-lk__chips" onMouseDown={(e) => e.preventDefault()}>
              <ConditionChips conditions={conditions} fields={fields} onRemove={(i) => setConditions((c) => c.filter((_, k) => k !== i).map((x, k) => (k === 0 ? { ...x, join: undefined } : x)))} />
            </div>
          )}
        </div>
      )}
      <span role="status" className="sr-only">
        {message}
      </span>
      <AdvancedFilter
        open={advancedOpen}
        onOpenChange={setAdvancedOpen}
        entityLabel={props.entityLabel}
        fields={fields}
        conditions={conditions}
        onApply={setConditions}
        preview={(conds) => fetcher({ filters: stateFilters(fields, { columnFilters: {}, conditions: conds }, baseFilters), sort: [], page: 1, pageSize: 50 })}
        previewColumns={props.previewColumns ?? fields.filter((f) => !f.filterOnly && f.mode !== "hidden")}
        mode="pick"
        onPickRow={choose}
        blockedReason={forInvoice ? blockedReason : undefined}
      />
    </div>
  );
}
