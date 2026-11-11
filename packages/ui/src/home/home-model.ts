// The home dashboard's layout (design §19a, rule 25): the widgets of the user's home, in order, each with the columns it
// spans (1–4 of a 4-column grid) and a free height. It is the user's own: saved per user and company in `kernel.user_prefs`
// (key `home_layout`), cached in the browser like the theme and the tabs, and reset to the default with one button.
// Pure functions, so the drag-and-drop and the resize rules are unit-tested without a browser.

export const HOME_LAYOUT_KEY = "home_layout";
export const HOME_COLUMNS = 4;
export const HOME_GAP_PX = 12;
export const HOME_MIN_HEIGHT = 160;
export const HOME_MAX_HEIGHT = 1200;
/** Keyboard step of a widget's height. */
export const HOME_HEIGHT_STEP = 40;

export interface WidgetLayout {
  id: string;
  /** Columns spanned, 1–4. */
  w: number;
  /** Minimum height in px; the content may grow it. */
  h: number;
}

/** The widgets of phase 1. Other modules' widgets and saved reports arrive with phase 2. */
export const HOME_WIDGET_IDS = ["kpis", "recommendations", "recent", "help"] as const;

/** The layout everyone starts with and "Restablecer tarjetas" returns to (the role default is this one until phase 3). */
export const DEFAULT_HOME_LAYOUT: readonly WidgetLayout[] = [
  { id: "kpis", w: 4, h: 170 },
  { id: "recommendations", w: 2, h: 300 },
  { id: "help", w: 2, h: 300 },
  { id: "recent", w: 4, h: 360 },
];

export const homeStorageKey = (userId: string): string => `erp.home.${userId}`;

const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));

/**
 * The saved value as a clean layout, or null when it is not one: a list of known widgets, each once, with whole spans and
 * numeric heights (clamped to the allowed range). An unknown id invalidates the whole list: it may come from a newer or
 * an older version, and the default is the safe answer.
 */
export function sanitizeHomeLayout(value: unknown, known: readonly string[] | ((id: string) => boolean) = HOME_WIDGET_IDS): WidgetLayout[] | null {
  const isKnown = typeof known === "function" ? known : (id: string) => known.includes(id);
  if (!Array.isArray(value) || value.length === 0 || value.length > 64) return null;
  const seen = new Set<string>();
  const layout: WidgetLayout[] = [];
  for (const item of value) {
    if (typeof item !== "object" || item === null) return null;
    const { id, w, h } = item as { id?: unknown; w?: unknown; h?: unknown };
    if (typeof id !== "string" || !isKnown(id) || seen.has(id)) return null;
    if (typeof w !== "number" || typeof h !== "number" || !Number.isFinite(w) || !Number.isFinite(h)) return null;
    seen.add(id);
    layout.push({ id, w: clamp(Math.round(w), 1, HOME_COLUMNS), h: clamp(Math.round(h), HOME_MIN_HEIGHT, HOME_MAX_HEIGHT) });
  }
  return layout;
}

/**
 * The layout to show for a saved value: the saved one when valid (plus, at its end, any known widget it does not list yet,
 * so a widget shipped later is not lost), else the default.
 */
export function resolveHomeLayout(saved: unknown, defaults: readonly WidgetLayout[] = DEFAULT_HOME_LAYOUT, known?: (id: string) => boolean): WidgetLayout[] {
  const layout = sanitizeHomeLayout(saved, known ?? defaults.map((w) => w.id));
  if (!layout) return defaults.map((w) => ({ ...w }));
  const listed = new Set(layout.map((w) => w.id));
  return [...layout, ...defaults.filter((w) => !listed.has(w.id)).map((w) => ({ ...w }))];
}

/**
 * Moves widget `fromId` to the place of `toId`, as the prototype's splice does: it is taken out and put back at the index
 * `toId` had, so dragging onto an earlier widget lands before it and onto a later one lands after it.
 */
export function moveWidget(layout: WidgetLayout[], fromId: string, toId: string): WidgetLayout[] {
  const from = layout.findIndex((w) => w.id === fromId);
  const to = layout.findIndex((w) => w.id === toId);
  if (from < 0 || to < 0 || from === to) return layout;
  const next = [...layout];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved!);
  return next;
}

/** The span a drag of `deltaX` px from `startSpan` lands on: whole columns, 1–4. */
export function resizedSpan(startSpan: number, deltaX: number, columnPx: number, gapPx: number = HOME_GAP_PX): number {
  const width = startSpan * columnPx + (startSpan - 1) * gapPx + deltaX;
  return clamp(Math.round(width / (columnPx + gapPx)), 1, HOME_COLUMNS);
}

/** The height a drag of `deltaY` px from `startHeight` lands on: free above the minimum. */
export function resizedHeight(startHeight: number, deltaY: number): number {
  return clamp(Math.round(startHeight + deltaY), HOME_MIN_HEIGHT, HOME_MAX_HEIGHT);
}

/** The width of one column given the grid's width. */
export const columnWidth = (gridPx: number, gapPx: number = HOME_GAP_PX): number => (gridPx - gapPx * (HOME_COLUMNS - 1)) / HOME_COLUMNS;

// A module's Inicio page (design §19a): the module's indicators as one strip and each of its charts as a card of its own, laid
// out per user and module (key `home_layout.<module>`). The charts a module ships are not known to the browser, so a saved
// layout is valid when its ids have the shape of a widget of that page.

/** The id of a chart's card in a module page's layout. */
export const chartWidgetId = (chartId: string): string => `chart:${chartId}`;

const MODULE_WIDGET = /^(kpis|chart:[a-z][a-z0-9_]*\.[a-z0-9_]+)$/;
export const isModuleWidgetId = (id: string): boolean => MODULE_WIDGET.test(id);

/** The preference holding a module page's layout. */
export const moduleLayoutKey = (module: string): string => `${HOME_LAYOUT_KEY}.${module}`;

/** The preference listing the KPIs and charts the user switched off (all pages): new ones start on. */
export const HOME_HIDDEN_KEY = "home_hidden";
const ITEM_ID = /^[a-z][a-z0-9_]*\.[a-z0-9_]+$/;

/** The hidden list as stored, cleaned: known-shaped ids, once each, sorted; null when it is not a list. */
export function sanitizeHiddenItems(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > 200) return null;
  if (!value.every((id) => typeof id === "string" && ITEM_ID.test(id))) return null;
  return [...new Set(value as string[])].sort();
}

/** The layout a module page starts with and "Restablecer tarjetas" returns to: the indicators strip, then two charts per row. */
export function defaultModuleLayout(chartIds: readonly string[]): WidgetLayout[] {
  return [{ id: "kpis", w: 4, h: 170 }, ...chartIds.map((id) => ({ id: chartWidgetId(id), w: 2, h: 300 }))];
}
