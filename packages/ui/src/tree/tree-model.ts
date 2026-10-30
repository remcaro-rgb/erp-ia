import { foldText } from "../grid/code-filter";

// The tree pane's model (accounting design §8, Task 26): rows with a parent become nested nodes, a level opens the first
// levels of the tree, and a query keeps the matching nodes with the path to them. Pure, so the pane and the pages share it.

export interface TreeNode<T extends Record<string, unknown> = Record<string, unknown>> {
  id: string;
  parentId: string | null;
  /** 0 for a root (a class of the chart, a top node of a dimension). */
  depth: number;
  row: T;
  children: TreeNode<T>[];
}

export interface TreeFields {
  /** Field holding the row's id. */
  idField: string;
  /** Field holding the parent's id; null or an unknown id makes the row a root. */
  parentField: string;
}

/** The roots of the rows nested by parent, siblings in the order the rows come in. A parent cycle is cut at the row that closes it. */
export function buildTree<T extends Record<string, unknown>>(rows: readonly T[], { idField, parentField }: TreeFields): TreeNode<T>[] {
  const nodes = new Map<string, TreeNode<T>>();
  for (const row of rows) {
    const id = String(row[idField]);
    nodes.set(id, { id, parentId: null, depth: 0, row, children: [] });
  }
  const roots: TreeNode<T>[] = [];
  for (const node of nodes.values()) {
    const parentRaw = node.row[parentField];
    const parent = parentRaw === null || parentRaw === undefined ? undefined : nodes.get(String(parentRaw));
    if (parent && !reaches(node, parent, nodes)) {
      node.parentId = parent.id;
      parent.children.push(node);
    } else {
      roots.push(node);
    }
  }
  const setDepth = (node: TreeNode<T>, depth: number) => {
    node.depth = depth;
    for (const child of node.children) setDepth(child, depth + 1);
  };
  for (const root of roots) setDepth(root, 0);
  return roots;
}

/** True when `candidate` is `node` or lies below it through the links made so far (so linking `node` under it would close a cycle). */
function reaches<T extends Record<string, unknown>>(node: TreeNode<T>, candidate: TreeNode<T>, nodes: Map<string, TreeNode<T>>): boolean {
  for (let current: TreeNode<T> | undefined = candidate, steps = 0; current && steps <= nodes.size; steps++) {
    if (current === node) return true;
    current = current.parentId === null ? undefined : nodes.get(current.parentId);
  }
  return false;
}

/** The ids to open so that `level` levels show (a node without children included, so a child added later shows): `expandToLevel(tree, 2)` opens the classes and the groups, so accounts appear but not subaccounts. */
export function expandToLevel<T extends Record<string, unknown>>(roots: readonly TreeNode<T>[], level: number): Set<string> {
  const open = new Set<string>();
  const visit = (node: TreeNode<T>) => {
    // A node without children is listed too: the children it gets later (a node just created) show without another click.
    if (node.depth < level) open.add(node.id);
    for (const child of node.children) visit(child);
  };
  for (const root of roots) visit(root);
  return open;
}

/** The ids of every node that has children (open all). */
export function expandAll<T extends Record<string, unknown>>(roots: readonly TreeNode<T>[]): Set<string> {
  return expandToLevel(roots, Number.POSITIVE_INFINITY);
}

/**
 * The nodes whose code or name contains `query` (no accents, no case) plus the path from their root, with the matching
 * node's whole subtree kept when its own text matches. The tree is returned as new nodes; an empty query returns it as it is.
 */
export function filterTree<T extends Record<string, unknown>>(roots: readonly TreeNode<T>[], query: string, fields: readonly string[] = ["code", "name"]): TreeNode<T>[] {
  const needle = foldText(query);
  if (needle === "") return [...roots];
  const matches = (node: TreeNode<T>) => fields.some((f) => foldText(String(node.row[f] ?? "")).includes(needle));
  const prune = (node: TreeNode<T>): TreeNode<T> | null => {
    if (matches(node)) return node;
    const kept = node.children.map(prune).filter((n): n is TreeNode<T> => n !== null);
    return kept.length > 0 ? { ...node, children: kept } : null;
  };
  return roots.map(prune).filter((n): n is TreeNode<T> => n !== null);
}

/** Ids of the nodes of a filtered tree that must be open to show every match (the ancestors of a match). */
export function openForMatches<T extends Record<string, unknown>>(filtered: readonly TreeNode<T>[], query: string, fields: readonly string[] = ["code", "name"]): Set<string> {
  const needle = foldText(query);
  const open = new Set<string>();
  if (needle === "") return open;
  const matches = (node: TreeNode<T>) => fields.some((f) => foldText(String(node.row[f] ?? "")).includes(needle));
  const visit = (node: TreeNode<T>): boolean => {
    const below = node.children.map(visit).some(Boolean);
    if (below) open.add(node.id);
    return below || matches(node);
  };
  for (const root of filtered) visit(root);
  return open;
}

/** The nodes in display order: a node, then its children when it is open. */
export function visibleNodes<T extends Record<string, unknown>>(roots: readonly TreeNode<T>[], open: ReadonlySet<string>): TreeNode<T>[] {
  const out: TreeNode<T>[] = [];
  const visit = (node: TreeNode<T>) => {
    out.push(node);
    if (open.has(node.id)) for (const child of node.children) visit(child);
  };
  for (const root of roots) visit(root);
  return out;
}

/** The ids on the path from a root to `id`, the node itself excluded (what to open to reveal it). */
export function ancestorsOf<T extends Record<string, unknown>>(roots: readonly TreeNode<T>[], id: string): string[] {
  const walk = (node: TreeNode<T>, path: string[]): string[] | null => {
    if (node.id === id) return path;
    for (const child of node.children) {
      const found = walk(child, [...path, node.id]);
      if (found) return found;
    }
    return null;
  };
  for (const root of roots) {
    const found = walk(root, []);
    if (found) return found;
  }
  return [];
}
