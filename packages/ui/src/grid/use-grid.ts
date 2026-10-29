"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { failureCode } from "./fetch-grid";
import { identityField, initialView, moveColumn, setColumnShown, stepColumn, toggleSort, toGridState } from "./grid-model";
import type { ColumnFilterValue, Condition, GridColumn, GridFetcher, GridPage, GridStateInput, GridView } from "./types";

type Filter = NonNullable<GridStateInput["filters"]>[number];

export interface UseGridOptions {
  columns: readonly GridColumn[];
  fetcher: GridFetcher;
  initialView?: Partial<GridView>;
  /** Filters every request carries (the party switches); a change goes back to page 1. */
  baseFilters?: readonly Filter[];
  /** Wait after typing in the filter row before asking the server. */
  debounceMs?: number;
}

export interface GridData {
  page: GridPage | null;
  loading: boolean;
  /** Code of the last failure (`field_hidden`, `forbidden`, `network`…), or null. */
  error: string | null;
}

/**
 * The state of a DataGrid and its server round trips (design §9): every change becomes a grid state for the
 * fetcher; typing in the filter row waits `debounceMs`, everything else asks at once. A newer request cancels the
 * one in flight, so a slow answer never overwrites a newer one.
 */
export function useGrid({ columns, fetcher, initialView: start, baseFilters = [], debounceMs = 300 }: UseGridOptions) {
  const [view, setView] = useState<GridView>(() => initialView(columns, start));
  const [data, setData] = useState<GridData>({ page: null, loading: true, error: null });
  const fetcherRef = useRef(fetcher);
  useEffect(() => {
    fetcherRef.current = fetcher;
  }, [fetcher]);
  const debounceNext = useRef(false);

  // A change of the fixed filters starts over from page 1 (state updated during render, as React recommends).
  const baseKey = JSON.stringify(baseFilters);
  const [seenBase, setSeenBase] = useState(baseKey);
  if (seenBase !== baseKey) {
    setSeenBase(baseKey);
    setView((v) => ({ ...v, page: 1 }));
  }

  const state = useMemo(() => toGridState(columns, view, { base: JSON.parse(baseKey) as Filter[] }), [columns, view, baseKey]);
  // What the server is asked for, regardless of the column order: moving a column brings the same rows, so it asks
  // nothing (the rows, the selection and the active row stay). The request itself carries the shown order (rule 20).
  const fetchKey = JSON.stringify({
    ...state,
    columns: [...(state.columns ?? [])].sort(),
    aggregates: state.aggregates && [...state.aggregates].sort((a, b) => a.field.localeCompare(b.field)),
  });
  const stateRef = useRef(state);
  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  useEffect(() => {
    const controller = new AbortController();
    const delay = debounceNext.current ? debounceMs : 0;
    debounceNext.current = false;
    const timer = setTimeout(() => {
      setData((d) => ({ ...d, loading: true }));
      fetcherRef.current(stateRef.current, controller.signal).then(
        (page) => {
          if (!controller.signal.aborted) setData({ page, loading: false, error: null });
        },
        (error: unknown) => {
          if (!controller.signal.aborted) setData((d) => ({ ...d, loading: false, error: failureCode(error) }));
        },
      );
    }, delay);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [fetchKey, debounceMs]);

  const update = useCallback((change: (v: GridView) => GridView, debounce = false) => {
    debounceNext.current = debounce;
    setView(change);
  }, []);

  const actions = useMemo(
    () => ({
      setColumnFilter(field: string, value: ColumnFilterValue | undefined, debounce = true) {
        update((v) => {
          const columnFilters = { ...v.columnFilters };
          if (value === undefined || value === "") delete columnFilters[field];
          else columnFilters[field] = value;
          return { ...v, columnFilters, page: 1 };
        }, debounce);
      },
      setConditions(conditions: Condition[]) {
        update((v) => ({ ...v, conditions, page: 1 }));
      },
      removeCondition(index: number) {
        update((v) => {
          const conditions = v.conditions.filter((_, i) => i !== index);
          // The condition after the removed first one becomes the first: it has no join.
          if (index === 0 && conditions[0]) conditions[0] = { ...conditions[0], join: undefined };
          return { ...v, conditions, page: 1 };
        });
      },
      sortBy(field: string, multi: boolean) {
        update((v) => ({ ...v, sort: toggleSort(v.sort, field, multi) }));
      },
      setPage(page: number) {
        update((v) => ({ ...v, page }));
      },
      setPageSize(pageSize: number) {
        update((v) => ({ ...v, pageSize, page: 1 }));
      },
      /** A header dropped at `toIndex` of the shown columns (design §22.12). */
      moveColumn(field: string, toIndex: number) {
        update((v) => moveColumn(v, field, toIndex, identityField(columns)));
      },
      /** Alt+← / Alt+→ on a header: one place from where it is now (each auto-repeated press from the last one's result). */
      moveColumnBy(field: string, delta: -1 | 1) {
        update((v) => moveColumn(v, field, v.columns.indexOf(field) + delta, identityField(columns)));
      },
      /** ↑ / ↓ in the column chooser: one place in its full order. */
      stepColumn(field: string, delta: -1 | 1) {
        update((v) => stepColumn(v, field, delta, identityField(columns)));
      },
      showColumn(field: string, on: boolean) {
        update((v) => setColumnShown(v, field, on));
      },
      /** Back to the columns, and their order, the grid started with. */
      resetColumns() {
        const start = initialView(columns);
        update((v) => ({ ...v, columns: start.columns, order: start.order }));
      },
      /** Filters, conditions and sort off; columns and page size stay. */
      clear() {
        update((v) => ({ ...v, columnFilters: {}, conditions: [], sort: [], page: 1 }));
      },
      /** Replaces the view (a saved view applied). */
      apply(next: Partial<GridView>) {
        update(() => initialView(columns, next));
      },
    }),
    [update, columns],
  );

  return { view, state, data, ...actions };
}
