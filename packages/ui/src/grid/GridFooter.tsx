"use client";

import { useTranslations } from "next-intl";
import { formatMoney } from "../money/format";
import { pageCount, pagerButtons, PAGE_SIZES } from "./grid-model";
import type { GridColumn } from "./types";

export interface GridFooterProps {
  page: number;
  pageSize: number;
  total: number;
  /** The first page has not come back yet: no "0 de 0". */
  loading?: boolean;
  onPage: (page: number) => void;
  onPageSize: (size: number) => void;
  /** Sums of the whole filter per money column (`sum:<field>` aggregates). */
  sums?: { column: GridColumn; sum: unknown }[];
  /** Selected rows and their money totals. */
  selection?: { count: number; totals: { column: GridColumn; sum: number }[] };
}

/** The grid footer (prototype `.grid-ft`): rows shown, the pager with 10 / 25 / 50 / 100 per page, and the money totals. */
export function GridFooter({ page, pageSize, total, loading = false, onPage, onPageSize, sums = [], selection }: GridFooterProps) {
  const t = useTranslations();
  const pages = pageCount(total, pageSize);
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(page * pageSize, total);
  return (
    <div className="erp-grid__ft">
      <span>{loading ? "" : t("grid.rows", { from, to, total })}</span>
      <nav className="erp-pager" aria-label={t("grid.page", { page, pages })}>
        <button type="button" aria-label={t("grid.previous")} disabled={page <= 1} onClick={() => onPage(page - 1)}>
          ‹
        </button>
        {pagerButtons(page, pages).map((p, i) =>
          p === "…" ? (
            <span key={`gap-${i}`} className="erp-muted">
              …
            </span>
          ) : (
            <button key={p} type="button" className={p === page ? "is-on" : undefined} aria-current={p === page ? "page" : undefined} onClick={() => onPage(p)}>
              {p}
            </button>
          ),
        )}
        <button type="button" aria-label={t("grid.next")} disabled={page >= pages} onClick={() => onPage(page + 1)}>
          ›
        </button>
        <select aria-label={t("grid.rows_per_page")} value={pageSize} onChange={(e) => onPageSize(Number(e.target.value))}>
          {PAGE_SIZES.map((n) => (
            <option key={n} value={n}>
              {t("grid.per_page", { count: n })}
            </option>
          ))}
        </select>
      </nav>
      {sums.map(({ column, sum }) => (
        <span key={column.field} className="erp-num">
          {t("grid.sum_filtered", { label: column.label.toLowerCase(), amount: formatMoney(sum as number | string) || formatMoney(0) })}
        </span>
      ))}
      {selection && selection.count > 0 && (
        <span className="erp-grid__selection">
          <b>{t("grid.selected", { count: selection.count })}</b>
          {selection.totals.map(({ column, sum }) => (
            <span key={column.field} className="erp-num">
              {t("grid.selection_sum", { label: column.label, amount: formatMoney(sum) })}
            </span>
          ))}
        </span>
      )}
    </div>
  );
}
