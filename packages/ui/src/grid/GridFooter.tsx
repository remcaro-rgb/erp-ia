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
  /** Selected rows and their money totals. */
  selection?: { count: number; totals: { column: GridColumn; sum: number | null }[] };
  /** Rows of the page hidden in collapsed groups. */
  hiddenInGroups?: number;
  /** Shows the keyboard hint of the rows (↑↓ · Espacio · Enter · /). */
  keysHint?: boolean;
}

/**
 * The grid footer (prototype `.grid-ft`): rows shown, the pager with 10 / 25 / 50 / 100 per page, and the selection with
 * its money totals. The filter's totals are not here: they sit under their own columns in the grid's `tfoot` (OD-5).
 */
export function GridFooter({ page, pageSize, total, loading = false, onPage, onPageSize, selection, keysHint = false, hiddenInGroups = 0 }: GridFooterProps) {
  const t = useTranslations();
  const pages = pageCount(total, pageSize);
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(page * pageSize, total);
  return (
    <div className="erp-grid__ft">
      <span>
        {loading ? "" : t("grid.rows", { from, to, total })}
        {hiddenInGroups > 0 && (
          <>
            {" · "}
            <span className="erp-muted">{t("grid.group.hidden_in_collapsed", { count: hiddenInGroups })}</span>
          </>
        )}
      </span>
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
      {/* One line: the selection and the key hint sit in a right-aligned group that never wraps (the footer scrolls
          sideways if it must), so ticking a row never shrinks the body. */}
      <span className="erp-grid__ft-end">
        <span className="erp-grid__selection" aria-live="polite">
          {selection && selection.count > 0 && (
            <>
              <b>{t("grid.selected", { count: selection.count })}</b>
              {selection.totals.map(({ column, sum }) => (
                <span key={column.field} className="erp-num">
                  {t("grid.selection_sum", { label: column.label, amount: sum === null ? "—" : formatMoney(sum) })}
                </span>
              ))}
            </>
          )}
        </span>
        {keysHint && (
          <span className="erp-grid__keys" aria-hidden="true">
            {t("grid.keys_hint")}
          </span>
        )}
      </span>
    </div>
  );
}
