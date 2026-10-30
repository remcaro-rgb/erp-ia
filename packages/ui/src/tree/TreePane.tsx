"use client";

import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useTranslations } from "next-intl";
import { ChevronRight, Lock, Search } from "lucide-react";
import { cn } from "@erp/ui/lib/utils";
import { formatMoney } from "../money/format";
import { ancestorsOf, buildTree, expandAll, expandToLevel, filterTree, openForMatches, visibleNodes, type TreeNode } from "./tree-model";

/** One node of the pane: a chart account or a node of a dimension, with the figure the page computed for the period. */
export interface TreeItem extends Record<string, unknown> {
  id: string;
  parentId: string | null;
  code: string;
  name: string;
  /** The period's figure beside the node (balance, result or net movement); null or absent shows none. */
  figure?: number | string | null;
  /** A restricted account: a lock, and never a figure unless the caller may view it (the page leaves the figure out otherwise). */
  restricted?: boolean;
  /** Shown dimmed (an inactive node). */
  inactive?: boolean;
}

export interface TreePaneProps {
  items: readonly TreeItem[];
  /** The selected node, or null when none is. */
  selectedId: string | null;
  onSelect: (id: string) => void;
  /** Accessible name of the tree. */
  label: string;
  /** Heading of the figure column ("Saldo", "Resultado", "Movimiento neto"). */
  figureLabel?: string;
  /** Levels the "Nivel n" buttons open (default 4: clase, grupo, cuenta, subcuenta). */
  levels?: number;
  /** Levels open at first (default 2). */
  initialLevel?: number;
}

/**
 * The tree pane of the analytic masters and the chart (accounting design §8): a search box over código and descripción,
 * "Nivel 1 … n" and "Todo" to open by level, the figure of the period beside each node and a lock on the restricted
 * ones. Keyboard: ↑ ↓ move, → opens or goes to the first child, ← closes or goes to the parent, Enter selects, Home and End.
 */
export function TreePane({ items, selectedId, onSelect, label, figureLabel, levels = 4, initialLevel = 2 }: TreePaneProps) {
  const t = useTranslations("grid.tree");
  const roots = useMemo(() => buildTree(items, { idField: "id", parentField: "parentId" }), [items]);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState<Set<string>>(() => expandToLevel(roots, initialLevel));
  const [active, setActive] = useState<string | null>(selectedId);
  // The page may mount the pane before its rows arrive (the first switch to Árbol): the initial level applies when the first rows do.
  const seeded = useRef(roots.length > 0);
  useEffect(() => {
    if (seeded.current || roots.length === 0) return;
    seeded.current = true;
    setOpen(expandToLevel(roots, initialLevel));
  }, [roots, initialLevel]);
  const listRef = useRef<HTMLDivElement>(null);

  // New rows (another period's figures arrive with the same nodes; a node was created): keep what is open, add nothing.
  const filtered = useMemo(() => filterTree(roots, query), [roots, query]);
  const shownOpen = useMemo(() => (query.trim() === "" ? open : new Set([...open, ...openForMatches(filtered, query)])), [open, filtered, query]);
  const visible = useMemo(() => visibleNodes(filtered, shownOpen), [filtered, shownOpen]);

  // The selected node is revealed when the selection comes from outside (the page restores it).
  useEffect(() => {
    if (!selectedId) return;
    const path = ancestorsOf(roots, selectedId);
    if (path.length > 0) setOpen((o) => (path.every((id) => o.has(id)) ? o : new Set([...o, ...path])));
  }, [selectedId, roots]);

  const current = visible.find((n) => n.id === active) ?? visible.find((n) => n.id === selectedId) ?? visible[0] ?? null;
  const focusNode = (id: string) => {
    setActive(id);
    // After the render that makes it the tab stop.
    requestAnimationFrame(() => listRef.current?.querySelector<HTMLElement>(`[data-node="${CSS.escape(id)}"]`)?.focus());
  };
  const toggle = (id: string, to?: boolean) =>
    setOpen((o) => {
      const next = new Set(o);
      if (to ?? !next.has(id)) next.add(id);
      else next.delete(id);
      return next;
    });

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!current) return;
    const index = visible.findIndex((n) => n.id === current.id);
    const isOpen = shownOpen.has(current.id);
    switch (event.key) {
      case "ArrowDown":
        if (visible[index + 1]) focusNode(visible[index + 1]!.id);
        break;
      case "ArrowUp":
        if (visible[index - 1]) focusNode(visible[index - 1]!.id);
        break;
      case "Home":
        focusNode(visible[0]!.id);
        break;
      case "End":
        focusNode(visible[visible.length - 1]!.id);
        break;
      case "ArrowRight":
        if (current.children.length > 0 && !isOpen) toggle(current.id, true);
        else if (current.children.length > 0) focusNode(current.children[0]!.id);
        break;
      case "ArrowLeft":
        if (current.children.length > 0 && isOpen && query.trim() === "") toggle(current.id, false);
        else if (current.parentId && visible.some((n) => n.id === current.parentId)) focusNode(current.parentId);
        break;
      case "Enter":
      case " ":
        onSelect(current.id);
        break;
      default:
        return;
    }
    event.preventDefault();
  };

  const level = (n: number) => setOpen(expandToLevel(roots, n));

  return (
    <div className="erp-tree">
      <div className="erp-tree__bar">
        <label className="erp-tree__search">
          <Search size={14} aria-hidden />
          <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t("search")} aria-label={t("search")} />
        </label>
        <div className="erp-tree__levels" role="group" aria-label={t("levels")}>
          {Array.from({ length: levels }, (_, i) => i + 1).map((n) => (
            <button key={n} type="button" className="erp-btn erp-btn--sm" onClick={() => level(n)} aria-label={t("level", { n })}>
              {n}
            </button>
          ))}
          <button type="button" className="erp-btn erp-btn--sm" onClick={() => setOpen(expandAll(roots))}>
            {t("all")}
          </button>
        </div>
      </div>
      {figureLabel && (
        <div className="erp-tree__head erp-small erp-muted" aria-hidden>
          <span>{t("node")}</span>
          <span>{figureLabel}</span>
        </div>
      )}
      <div ref={listRef} role="tree" aria-label={label} className="erp-tree__list" onKeyDown={onKeyDown}>
        {visible.length === 0 && <p className="erp-small erp-muted erp-tree__empty">{t("empty")}</p>}
        {visible.map((node) => (
          <TreeRow
            key={node.id}
            node={node}
            open={shownOpen.has(node.id)}
            selected={node.id === selectedId}
            tabStop={node.id === current?.id}
            onToggle={() => toggle(node.id)}
            onSelect={() => {
              setActive(node.id);
              onSelect(node.id);
            }}
            restrictedLabel={t("restricted")}
          />
        ))}
      </div>
    </div>
  );
}

function TreeRow({ node, open, selected, tabStop, onToggle, onSelect, restrictedLabel }: { node: TreeNode<TreeItem>; open: boolean; selected: boolean; tabStop: boolean; onToggle: () => void; onSelect: () => void; restrictedLabel: string }) {
  const item = node.row;
  const hasChildren = node.children.length > 0;
  const figure = item.figure === null || item.figure === undefined ? "" : formatMoney(item.figure);
  return (
    <div
      role="treeitem"
      data-node={node.id}
      aria-label={figure === "" ? `${item.code} ${item.name}` : `${item.code} ${item.name}, ${figure}`}
      aria-level={node.depth + 1}
      aria-expanded={hasChildren ? open : undefined}
      aria-selected={selected}
      tabIndex={tabStop ? 0 : -1}
      className={cn("erp-tree__row", selected && "is-selected", item.inactive && "is-inactive")}
      style={{ paddingLeft: 8 + node.depth * 16 }}
      onClick={onSelect}
    >
      <span
        className={cn("erp-tree__twisty", open && "is-open", !hasChildren && "is-leaf")}
        aria-hidden
        onClick={(event) => {
          event.stopPropagation();
          if (hasChildren) onToggle();
        }}
      >
        {hasChildren && <ChevronRight size={14} />}
      </span>
      <span className="erp-mono erp-tree__code">{item.code}</span>
      <span className="erp-tree__name">{item.name}</span>
      {item.restricted && <Lock size={13} className="erp-tree__lock" role="img" aria-label={restrictedLabel} />}
      {figure !== "" && <span className="erp-num erp-tree__figure">{figure}</span>}
    </div>
  );
}
