"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { DataGrid, defaultView, ImportDialog, ImportIcon, TreePane, viewFromSaved, type SavedGridState, type TreeItem } from "@erp/ui";
import type { MasterTree } from "@erp/module-accounting";
import { loadMasterTreeAction, saveMasterViewAction } from "@/lib/accounting/actions";
import { canHangAuxiliary, type MasterView } from "@/lib/accounting/masters";
import type { MasterPageData } from "@/lib/accounting/load";
import { requestStepUp } from "@/lib/auth/step-up-client";
import { deleteViewAction, saveViewAction } from "@/lib/grid/actions";
import { NewNodeDialog, type NodeParent } from "./new-node-dialog";


type Filter = NonNullable<Parameters<typeof DataGrid>[0]["baseFilters"]>[number];

/** "octubre de 2026" for the period selector, from the period's first day (a calendar date, read in UTC). */
const periodLabel = (startsOn: string) => new Intl.DateTimeFormat("es-CO", { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${startsOn}T00:00:00Z`));

/**
 * The master page of the chart and the four analytic dimensions (accounting design §8): a Tabla · Árbol toggle remembered per user
 * (`kernel.user_prefs`, key `master_view.<entity>`). Tabla is the DataGrid of every node; Árbol is the tree pane with the selected
 * period's figure beside each node (balance, result or net movement) and the DataGrid of the selected node's children on the right.
 */
export function MasterPage({ data }: { data: MasterPageData }) {
  const t = useTranslations();
  const { grid } = data;
  const entity = grid.entity;
  const isAccount = entity === "accounting.account";

  const [view, setView] = useState<MasterView>(data.view);
  const [periodId, setPeriodId] = useState(data.periodId);
  const [tree, setTree] = useState<MasterTree | null>(data.tree);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [restrictedOnly, setRestrictedOnly] = useState(false);
  const [creating, setCreating] = useState(false);
  const [importing, setImporting] = useState(false);
  const [version, setVersion] = useState(0);
  const [views, setViews] = useState(grid.views);
  const [, startTransition] = useTransition();

  // The tree of the shown period: asked again after a creation or a period change, and the first time the page switches to Árbol.
  const loadedKey = useRef(data.tree ? `${data.periodId}:0` : "");
  useEffect(() => {
    if (view !== "tree") return;
    const key = `${periodId}:${version}`;
    if (loadedKey.current === key) return;
    loadedKey.current = key;
    let stale = false;
    void loadMasterTreeAction(entity, periodId).then((result) => {
      if (!stale && result.ok) setTree(result.tree);
    });
    return () => {
      stale = true;
      loadedKey.current = "";
    };
  }, [view, periodId, version, entity]);

  const items = useMemo<TreeItem[]>(
    () => (tree?.items ?? []).map((n) => ({ id: n.id, parentId: n.parentId, code: n.code, name: n.name, figure: n.restricted && n.figure === null ? null : n.figure, restricted: n.restricted, inactive: n.inactive })),
    [tree],
  );
  const selected = tree?.items.find((n) => n.id === selectedId) ?? null;

  const choose = (next: MasterView) => {
    if (next === view) return;
    setView(next);
    startTransition(() => void saveMasterViewAction(entity, next));
  };

  const baseFilters = useMemo<Filter[]>(() => {
    const filters: Filter[] = [];
    if (view === "tree") filters.push(selectedId ? { field: "parent_id", op: "eq", value: selectedId } : { field: "parent_id", op: "is_null" });
    if (restrictedOnly) filters.push({ field: "access", op: "eq", value: "restricted" });
    return filters;
  }, [view, selectedId, restrictedOnly]);

  const initialState = useMemo(() => {
    const saved = defaultView(grid.views);
    return saved ? viewFromSaved(grid.columns, saved.state) : undefined;
    // The saved views change while the page is open; the grid only starts from them.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [grid.columns]);

  // The parent of what "Nuevo" creates: an account hangs from the selected subcuenta or auxiliary; an analytic node from the selected group
  // (or from the group of the selected leaf).
  const parent: NodeParent | null = useMemo(() => {
    if (!selected || !tree) return null;
    if (isAccount) return { id: selected.id, code: selected.code, name: selected.name };
    const group = selected.level === "group" ? selected : tree.items.find((n) => n.id === selected.parentId);
    return group ? { id: group.id, code: group.code, name: group.name } : null;
  }, [selected, tree, isAccount]);

  const canNew = grid.canCreate && (!isAccount || view !== "tree" || canHangAuxiliary(selected?.level));
  const newLabel = isAccount ? t("accounting.master.new_account") : t("accounting.master.new");
  const figureLabel = t(`accounting.master.${data.figure}`);

  // Tabla shows the selected period's figure as a column (header: the figure's name, as the tree pane's); Árbol shows it beside the nodes instead.
  const columns = useMemo(
    () => (view === "tree" ? grid.columns.filter((c) => c.field !== "period_figure") : grid.columns.map((c) => (c.field === "period_figure" ? { ...c, label: figureLabel } : c))),
    [grid.columns, view, figureLabel],
  );
  const params = useMemo(() => (view === "table" && periodId ? { period_id: periodId } : undefined), [view, periodId]);

  const changeViews = async (result: Awaited<ReturnType<typeof saveViewAction>>) => {
    if (!result.ok) throw new Error(result.code);
    setViews(result.views);
  };

  const toggle = (
    <span className="erp-row">
      <span className="erp-seg" role="group" aria-label={t("accounting.master.view")}>
        <button type="button" aria-pressed={view === "table"} onClick={() => choose("table")}>
          {t("accounting.master.table")}
        </button>
        <button type="button" aria-pressed={view === "tree"} onClick={() => choose("tree")}>
          {t("accounting.master.tree")}
        </button>
      </span>
      <label className="erp-row erp-small">
        <span className="erp-muted">{t("accounting.master.period")}</span>
        {data.periods.length === 0 ? (
          <span className="erp-muted">{t("accounting.master.no_period")}</span>
        ) : (
          <select aria-label={t("accounting.master.period")} value={periodId ?? ""} onChange={(e) => setPeriodId(e.target.value)} className="erp-btn">
            {data.periods.map((p) => (
              <option key={p.id} value={p.id}>
                {periodLabel(p.startsOn)}
              </option>
            ))}
          </select>
        )}
      </label>
    </span>
  );

  const gridView = (
    <DataGrid
      key={`${view}:${version}`}
      entity={entity}
      title={grid.title}
      columns={columns}
      initialState={initialState}
      baseFilters={baseFilters}
      params={params}
      headerExtra={toggle}
      onRowOpen={view === "tree" ? (row) => setSelectedId(row.id) : undefined}
      toolbar={
        <>
          {grid.canCreate && (
            <button type="button" className="erp-btn erp-btn--primary" disabled={!canNew} title={!canNew && isAccount ? t("accounting.master.new_account_hint") : undefined} onClick={() => setCreating(true)}>
              {newLabel}
            </button>
          )}
          {grid.canImport && (
            <button type="button" className="erp-btn" onClick={() => setImporting(true)}>
              <ImportIcon />
              {t("grid.import.title")}
            </button>
          )}
          {isAccount && (
            <button type="button" className="erp-btn" aria-pressed={restrictedOnly} onClick={() => setRestrictedOnly((r) => !r)}>
              {t("accounting.master.restricted_filter")}
            </button>
          )}
        </>
      }
      savedViews={{
        views,
        onSave: async (name: string, isDefault: boolean, state: SavedGridState) => changeViews(await saveViewAction(entity, name, isDefault, state)),
        onDelete: async (id: string) => changeViews(await deleteViewAction(entity, id)),
      }}
    />
  );

  return (
    <div className="erp-master">
      {view === "tree" ? (
        <div className="erp-master__split">
          <TreePane
            items={items}
            selectedId={selectedId}
            onSelect={setSelectedId}
            label={t("accounting.master.tree_label", { title: grid.title })}
            figureLabel={figureLabel}
          />
          <div className="erp-master__grid">{gridView}</div>
        </div>
      ) : (
        gridView
      )}
      <NewNodeDialog
        open={creating}
        onOpenChange={setCreating}
        entity={entity}
        title={isAccount ? t("accounting.master.dialog_account") : t("accounting.master.dialog_node", { title: t(`entity.${entity}`) })}
        parent={parent}
        onCreated={() => setVersion((v) => v + 1)}
      />
      {grid.canImport && <ImportDialog open={importing} onOpenChange={setImporting} entity={entity} entityLabel={grid.title} requestStepUp={requestStepUp} />}
    </div>
  );
}
