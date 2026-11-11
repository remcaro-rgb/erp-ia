import { recordHref } from "./record-model";

// The model of the tab «Documentos relacionados» (design §22.27, R31-8): what the kernel's trail consult answered, shaped for the frame.
// The frame draws it from the process result alone and knows no module (rule 4); the labels come from the title resolver.

/** One visible node of the trail with the label the page resolved (null when the viewer has no title for it). */
export interface RelatedNode {
  direction: "up" | "down";
  depth: number;
  /** The link kind that reaches the node (`order_to_delivery`); null when its edge touches a document the viewer cannot see. */
  kind: string | null;
  entity: string;
  id: string;
  voided: boolean;
  label: string | null;
}

export interface RelatedEntry extends RelatedNode {
  /** Level of indentation: depth 1 is flush. */
  indent: number;
  /** The record's page (rule 21). */
  href: string;
}

export interface RelatedModel {
  /** Upstream before downstream; by depth inside a direction, the walk's order inside a level. */
  entries: RelatedEntry[];
  /** Documents the viewer cannot see (a count, never a name). */
  hidden: number;
  /** The walk stopped at its cap or depth. */
  truncated: boolean;
  /** How many documents the trail returned, seen or not (the N of «Se muestran los primeros N»: what the cap counted, never 0 when it was reached). */
  shown: number;
  /** The chip of the tab: every document the trail found, seen or not. */
  count: number;
}

/** The tab's model, or null when there is nothing to show (no tab: no nodes and none hidden). */
export function relatedModel(result: { nodes: readonly RelatedNode[]; hidden: number; truncated: boolean }): RelatedModel | null {
  const nodes = result.nodes;
  if (nodes.length === 0 && result.hidden === 0) return null;
  const rank = (n: RelatedNode) => (n.direction === "up" ? 0 : 1);
  const entries = nodes
    .map((n, i) => ({ n, i }))
    .sort((a, b) => rank(a.n) - rank(b.n) || a.n.depth - b.n.depth || a.i - b.i)
    .map(({ n }): RelatedEntry => ({ ...n, label: n.label ?? null, indent: Math.max(0, n.depth - 1), href: recordHref(n.entity, n.id) }));
  return { entries, hidden: result.hidden, truncated: result.truncated, shown: entries.length + result.hidden, count: entries.length + result.hidden };
}
