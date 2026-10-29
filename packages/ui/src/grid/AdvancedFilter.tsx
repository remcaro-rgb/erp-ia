"use client";

import { Fragment, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { useTranslations } from "next-intl";
import { NO_VALUE_OPS, OPERATORS } from "@erp/kernel/query";
import { Dialog, DialogContent, DialogTitle } from "@erp/ui/components/ui/dialog";
import { draftConditions, draftOf, newDraft, withField, withOp, type DraftCondition } from "./condition-model";
import { GridCell, Pill } from "./GridCell";
import type { Condition, FilterOp, GridColumn, GridPage, GridRow } from "./types";

export const PREVIEW_ROWS = 50;

export interface AdvancedFilterProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The entity's name, for the title. */
  entityLabel: string;
  /** Every field of the entity the caller may know of: grid columns, stored fields, admin-defined data. */
  fields: readonly GridColumn[];
  /** The applied conditions; the draft starts from them. */
  conditions: readonly Condition[];
  onApply: (conditions: Condition[]) => void;
  /** Reads the records matching the draft (up to 50) for the live results. */
  preview: (conditions: Condition[]) => Promise<GridPage>;
  /** Columns of the live results (the first seven fit). */
  previewColumns: readonly GridColumn[];
  /** `open`: a row click opens the record (grid); `pick`: it selects the row into the field (lookup). */
  mode: "open" | "pick";
  onPickRow: (row: GridRow) => void;
  /** Why a row cannot be picked (a `forInvoice` lookup: not invoice-ready), or null. Such rows are dimmed. */
  blockedReason?: (row: GridRow) => string | null;
  debounceMs?: number;
}

/**
 * The advanced filter popup (design §9, prototype `advOpen` / `advRender` / `advApply` / `advPickRow`): conditions
 * `field · rule · value(s)` over every field, rules by type, joined with Y / O where Y binds tighter (a line marks
 * each new O group), and the matching records listed live under them. Masked fields are listed but cannot be chosen.
 */
export function AdvancedFilter(props: AdvancedFilterProps) {
  const t = useTranslations();
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent showCloseButton={false} className="erp-dialog erp-adv-dialog" aria-describedby={undefined}>
        <div className="erp-dialog__head">
          <DialogTitle className="erp-dialog__title">{t("grid.adv.title", { entity: props.entityLabel })}</DialogTitle>
          <button type="button" className="erp-btn erp-btn--ghost" aria-label={t("common.close")} onClick={() => props.onOpenChange(false)}>
            ✕
          </button>
        </div>
        {props.open && <AdvancedFilterBody {...props} />}
      </DialogContent>
    </Dialog>
  );
}

function AdvancedFilterBody({ fields, conditions, onApply, onOpenChange, preview, previewColumns, mode, onPickRow, blockedReason, debounceMs = 250 }: AdvancedFilterProps) {
  const t = useTranslations();
  const [draft, setDraft] = useState<DraftCondition[]>(() => (conditions.length > 0 ? draftOf(conditions) : [newDraft(fields)]));
  const live = draftConditions(draft, fields);
  const liveKey = JSON.stringify(live);
  const [results, setResults] = useState<GridPage | null>(null);
  // Roving tabindex over the live results: one tab stop, ↑ ↓ Home End move, Enter or Space picks.
  const [activeResult, setActiveResult] = useState(0);
  const resultsRef = useRef<HTMLTableSectionElement>(null);
  const previewRef = useRef(preview);
  useEffect(() => {
    previewRef.current = preview;
  }, [preview]);

  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(() => {
      previewRef.current(JSON.parse(liveKey) as Condition[]).then(
        (page) => {
          if (cancelled) return;
          setResults(page);
          setActiveResult(0);
        },
        () => !cancelled && setResults({ rows: [], total: 0 }),
      );
    }, debounceMs);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [liveKey, debounceMs]);

  const set = (index: number, next: DraftCondition) => setDraft((d) => d.map((c, i) => (i === index ? next : c)));
  const remove = (index: number) => setDraft((d) => (d.length > 1 ? d.filter((_, i) => i !== index) : [newDraft(fields)]));
  const apply = () => {
    onApply(live);
    onOpenChange(false);
  };
  const pick = (row: GridRow) => {
    if (blockedReason?.(row)) return;
    if (mode === "open") onApply(live);
    onOpenChange(false);
    onPickRow(row);
  };

  const resultRows = (results?.rows ?? []).slice(0, PREVIEW_ROWS);
  const focusResult = (index: number) => {
    const next = Math.max(0, Math.min(resultRows.length - 1, index));
    setActiveResult(next);
    resultsRef.current?.querySelectorAll<HTMLTableRowElement>("tr[data-row]")[next]?.focus();
  };
  // In the conditions: Enter applies (a button keeps its own Enter, a multiple select its options), Alt+↓ goes to the
  // results.
  const onConditionsKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    if (event.key === "Enter" && !event.nativeEvent.isComposing && target.tagName !== "BUTTON" && !(target instanceof HTMLSelectElement && target.multiple)) {
      event.preventDefault();
      apply();
    } else if (event.key === "ArrowDown" && event.altKey && resultRows.length > 0) {
      event.preventDefault();
      focusResult(activeResult);
    }
  };
  const onResultKey = (event: KeyboardEvent<HTMLTableRowElement>, index: number, row: GridRow) => {
    const moves: Record<string, number> = { ArrowDown: index + 1, ArrowUp: index - 1, Home: 0, End: resultRows.length - 1 };
    const move = moves[event.key];
    if (move !== undefined) {
      event.preventDefault();
      focusResult(move);
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      pick(row);
    }
  };
  const tabResult = Math.min(activeResult, Math.max(resultRows.length - 1, 0));

  const shownColumns = previewColumns.slice(0, 7);
  const total = results?.total ?? 0;
  return (
    <>
      <div className="erp-dialog__body">
        <div className="erp-adv" onKeyDown={onConditionsKey} aria-keyshortcuts="Enter Alt+ArrowDown">
          {draft.map((condition, index) => (
            <Fragment key={index}>
              {index > 0 && condition.join === "or" && <div className="erp-adv__or" role="separator" />}
              <ConditionRow index={index} condition={condition} fields={fields} onChange={(next) => set(index, next)} onRemove={() => remove(index)} />
            </Fragment>
          ))}
        </div>
        <div className="erp-row">
          <button type="button" className="erp-btn erp-btn--sm" onClick={() => setDraft((d) => [...d, newDraft(fields)])}>
            {t("grid.adv.add")}
          </button>
          <span className="erp-small erp-muted">{t("grid.adv.precedence", { count: fields.length })}</span>
        </div>
        <section className="erp-adv__results" aria-label={t("grid.adv.results")}>
          <h3>
            {t("grid.adv.results")} <Pill tone="gray">{t("grid.results", { count: total })}</Pill>{" "}
            <span className="erp-hint">
              {mode === "pick" ? t("grid.adv.hint_pick") : t("grid.adv.hint_open")} · {t("grid.adv.keys_hint")}
              {total > PREVIEW_ROWS && ` · ${t("grid.adv.capped")}`}
            </span>
          </h3>
          <div className="erp-adv__table">
            <table>
              <thead>
                <tr>
                  {shownColumns.map((c) => (
                    <th key={c.field}>{c.label}</th>
                  ))}
                  {blockedReason && <th>{t("grid.adv.invoice")}</th>}
                </tr>
              </thead>
              <tbody ref={resultsRef}>
                {resultRows.map((row, index) => {
                  const reason = blockedReason?.(row) ?? null;
                  return (
                    <tr
                      key={row.id}
                      data-row=""
                      tabIndex={index === tabResult ? 0 : -1}
                      className={reason ? "erp-row-link is-blocked" : "erp-row-link"}
                      title={reason ? t("grid.adv.not_invoiceable", { reasons: reason }) : undefined}
                      aria-disabled={reason ? true : undefined}
                      onFocus={(event) => event.target === event.currentTarget && setActiveResult(index)}
                      onKeyDown={(event) => event.target === event.currentTarget && onResultKey(event, index, row)}
                      onClick={() => pick(row)}
                    >
                      {shownColumns.map((c) => (
                        <GridCell key={c.field} column={c} row={row} />
                      ))}
                      {blockedReason && (
                        <td>
                          <Pill tone={reason ? "danger" : "ok"}>{reason ? t("common.no") : t("common.yes")}</Pill>
                        </td>
                      )}
                    </tr>
                  );
                })}
                {results && results.rows.length === 0 && (
                  <tr>
                    <td colSpan={shownColumns.length + (blockedReason ? 1 : 0)} className="erp-muted erp-grid__empty">
                      {t("grid.adv.none")}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>
      </div>
      <div className="erp-dialog__foot">
        <span className="erp-small erp-muted erp-grow">{mode === "pick" ? t("grid.adv.foot_pick", { count: total }) : t("grid.adv.foot_grid", { count: total })}</span>
        <button type="button" className="erp-btn erp-btn--ghost" onClick={() => setDraft([newDraft(fields)])}>
          {t("grid.adv.clear")}
        </button>
        <button type="button" className="erp-btn" onClick={() => onOpenChange(false)}>
          {t("common.cancel")}
        </button>
        <button type="button" className="erp-btn erp-btn--primary" onClick={apply}>
          {t("grid.apply")}
        </button>
      </div>
    </>
  );
}

interface ConditionRowProps {
  index: number;
  condition: DraftCondition;
  fields: readonly GridColumn[];
  onChange: (next: DraftCondition) => void;
  onRemove: () => void;
}

function ConditionRow({ index, condition, fields, onChange, onRemove }: ConditionRowProps) {
  const t = useTranslations();
  const field = fields.find((f) => f.field === condition.field) ?? fields[0];
  if (!field) return null;
  const ops = OPERATORS[field.kind];
  const noValue = NO_VALUE_OPS.has(condition.op);
  const two = condition.op === "between";
  const options = field.options ?? (field.type === "boolean" ? [{ value: "true", label: t("common.yes") }, { value: "false", label: t("common.no") }] : null);

  const valueInput = (which: "value" | "value2", label: string) => {
    const current = which === "value" ? condition.value : condition.value2;
    const set = (v: string | string[]) => onChange({ ...condition, [which]: v });
    if (options && (field.kind === "enum" || field.kind === "uuid")) {
      if (condition.op === "in") {
        const chosen = Array.isArray(current) ? current : [];
        return (
          <select multiple aria-label={label} value={chosen} onChange={(e) => set([...e.target.selectedOptions].map((o) => o.value))}>
            {options.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        );
      }
      return (
        <select aria-label={label} value={typeof current === "string" ? current : ""} onChange={(e) => set(e.target.value)}>
          <option value="">—</option>
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      );
    }
    const numeric = field.kind === "number";
    return (
      <input
        aria-label={label}
        type={field.kind === "date" ? "date" : "text"}
        inputMode={numeric ? "decimal" : undefined}
        style={numeric ? { textAlign: "right" } : undefined}
        placeholder={numeric ? "0" : t("grid.adv.value").toLowerCase()}
        value={typeof current === "string" ? current : ""}
        onChange={(e) => set(e.target.value)}
      />
    );
  };

  return (
    <div className={two && !noValue ? "erp-adv__cond erp-adv__cond--two" : "erp-adv__cond"} role="group" aria-label={t("grid.adv.condition", { n: index + 1 })}>
      {index === 0 ? (
        <span className="erp-adv__join">{t("grid.adv.where")}</span>
      ) : (
        <select className="erp-adv__join" aria-label={t("grid.adv.join")} value={condition.join} onChange={(e) => onChange({ ...condition, join: e.target.value as "and" | "or" })}>
          <option value="and">{t("grid.rule_and")}</option>
          <option value="or">{t("grid.rule_or")}</option>
        </select>
      )}
      <select
        aria-label={t("grid.adv.field")}
        value={field.field}
        onChange={(e) => {
          const next = fields.find((f) => f.field === e.target.value);
          if (next) onChange(withField(condition, next));
        }}
      >
        {fields.map((f) => (
          <option key={f.field} value={f.field} disabled={f.mode !== "visible" || !f.filterable}>
            {f.label}
            {f.field.startsWith("extra.") ? ` ${t("grid.adv.extra_suffix")}` : ""}
            {f.mode === "masked" ? ` ${t("grid.adv.masked_suffix")}` : ""}
          </option>
        ))}
      </select>
      <select aria-label={t("grid.adv.rule")} value={condition.op} onChange={(e) => onChange(withOp(condition, e.target.value as FilterOp))}>
        {ops.map((op) => (
          <option key={op} value={op}>
            {t(`grid.ops.${field.kind}.${op}`)}
          </option>
        ))}
      </select>
      {noValue ? <span className="erp-small erp-muted">{t("grid.adv.no_value")}</span> : valueInput("value", t("grid.adv.value"))}
      {two && !noValue && valueInput("value2", t("grid.adv.value2"))}
      <button type="button" className="erp-btn erp-btn--sm erp-btn--ghost" aria-label={t("grid.remove_condition")} onClick={onRemove}>
        ✕
      </button>
    </div>
  );
}
