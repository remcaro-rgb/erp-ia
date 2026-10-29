"use client";

import { useCallback, useEffect, useRef, useState, type DragEvent, type PointerEvent, type ReactNode } from "react";
import { useTranslations } from "next-intl";
import { browserStorage, newerSaved, readCachedPref, writeCachedPref } from "../shell/prefs-cache";
import type { Saved } from "../shell/types";
import {
  columnWidth,
  DEFAULT_HOME_LAYOUT,
  HOME_COLUMNS,
  HOME_HEIGHT_STEP,
  homeStorageKey,
  moveWidget,
  resizedHeight,
  resizedSpan,
  resolveHomeLayout,
  sanitizeHomeLayout,
  type WidgetLayout,
} from "./home-model";
import { Widget } from "./Widget";

export interface DashboardWidget {
  /** Id in the layout (`kpis`, `recommendations`…). */
  id: string;
  /** Already translated. */
  title: string;
  /** In the header, right of the title (when the data was read). */
  meta?: ReactNode;
  content: ReactNode;
}

export interface DashboardProps {
  userId: string;
  companyId: string;
  /** The widgets this user's home can show now, by id; a layout entry with no widget here keeps its place but is not drawn. */
  widgets: DashboardWidget[];
  /** The layout everyone starts with and "Restablecer tarjetas" returns to. */
  defaultLayout?: readonly WidgetLayout[];
  /** The user's saved layout in this company (`kernel.user_prefs`, key `home_layout`), or null. */
  initial: Saved<unknown> | null;
  /** The greeting row's left side. */
  heading?: ReactNode;
  /** Every change of the layout with its time, to save it (the dashboard already caches it in localStorage). */
  onChange?: (layout: WidgetLayout[], savedAt: number) => void;
  /** The preference cache; the browser's localStorage by default. */
  storage?: Storage | null;
}

interface Preview {
  id: string;
  w: number;
  h: number;
}

type Valid = Saved<WidgetLayout[]> | null;
const validSaved = (saved: Saved<unknown> | null | undefined, ids: string[]): Valid => {
  const layout = saved ? sanitizeHomeLayout(saved.value, ids) : null;
  return saved && layout ? { value: layout, savedAt: saved.savedAt } : null;
};

/**
 * The home screen's widget grid (design §19a, rule 25, prototype `wgStart/wgOver/wgDrop/wgResize`): 4 columns; a widget is
 * dragged by its header onto another to take its place and resized from its corner (1–4 columns, free height). The layout
 * is the user's own: every change is saved (the caller's `onChange`, plus the browser cache so a change the server never
 * received survives a reload) and "Restablecer tarjetas" returns to the default. Nothing is ever rearranged by itself.
 */
export function Dashboard({ userId, companyId, widgets, defaultLayout = DEFAULT_HOME_LAYOUT, initial, heading, onChange, storage: storageProp }: DashboardProps) {
  const t = useTranslations("home.dashboard");
  const [storage] = useState<Storage | null>(() => (storageProp === undefined ? browserStorage() : storageProp));
  const ids = defaultLayout.map((w) => w.id);

  const [layout, setLayout] = useState<WidgetLayout[]>(() => resolveHomeLayout(initial?.value ?? null, defaultLayout));
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const cleanup = useRef<(() => void) | null>(null);

  const latest = useRef({ onChange, layout });
  useEffect(() => {
    latest.current = { onChange, layout };
  });

  const commit = useCallback(
    (next: WidgetLayout[], savedAt: number = Date.now()) => {
      setLayout(next);
      writeCachedPref(storage, homeStorageKey(userId), companyId, { value: next, savedAt });
      latest.current.onChange?.(next, savedAt);
    },
    [storage, userId, companyId],
  );

  // Once mounted (the server render had no cache): this browser's copy wins when it is newer than the server's, e.g. a
  // change made just before the page closed that never reached the server. The newer copy is then saved.
  useEffect(() => {
    const server = validSaved(initial, ids);
    const cached = validSaved(readCachedPref(storage, homeStorageKey(userId), companyId), ids);
    const winner = newerSaved(server, cached);
    if (winner && winner === cached && cached !== server) {
      const next = resolveHomeLayout(cached.value, defaultLayout);
      setLayout(next);
      latest.current.onChange?.(next, cached.savedAt);
    }
    // Once per mounted dashboard: the first render's saved copies decide.
  }, []);

  // A drag or resize in progress when the dashboard goes away must not leave listeners on the document.
  useEffect(() => () => cleanup.current?.(), []);

  const shown = layout.filter((item) => widgets.some((w) => w.id === item.id));
  const widgetOf = (id: string) => widgets.find((w) => w.id === id)!;

  const moveTo = (fromId: string, toId: string) => {
    const next = moveWidget(layout, fromId, toId);
    if (next !== layout) commit(next);
  };

  const onDragStart = (id: string) => (event: DragEvent<HTMLElement>) => {
    setDragId(id);
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", id);
  };
  const onDragEnd = () => {
    setDragId(null);
    setOverId(null);
  };
  const onDragOver = (id: string) => (event: DragEvent<HTMLElement>) => {
    if (dragId === null) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    if (overId !== id) setOverId(id);
  };
  const onDrop = (id: string) => (event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    const from = dragId;
    setDragId(null);
    setOverId(null);
    if (from !== null) moveTo(from, id);
  };

  const onMoveKey = (id: string) => (direction: -1 | 1) => {
    const at = shown.findIndex((w) => w.id === id);
    const neighbour = shown[at + direction];
    if (neighbour) moveTo(id, neighbour.id);
  };

  const onResizeStart = (id: string) => (event: PointerEvent<HTMLElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const grid = gridRef.current;
    const start = layout.find((w) => w.id === id);
    if (!grid || !start) return;
    cleanup.current?.();
    const column = columnWidth(grid.clientWidth);
    const originX = event.clientX;
    const originY = event.clientY;
    const sizeAt = (e: { clientX: number; clientY: number }): Preview => ({
      id,
      w: resizedSpan(start.w, e.clientX - originX, column),
      h: resizedHeight(start.h, e.clientY - originY),
    });
    const move = (e: globalThis.PointerEvent) => setPreview(sizeAt(e));
    const stop = () => {
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", up);
      document.removeEventListener("pointercancel", cancel);
      cleanup.current = null;
      setPreview(null);
    };
    const up = (e: globalThis.PointerEvent) => {
      const size = sizeAt(e);
      stop();
      if (size.w !== start.w || size.h !== start.h) commit(layout.map((w) => (w.id === id ? { ...w, w: size.w, h: size.h } : w)));
    };
    const cancel = () => stop();
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", up);
    document.addEventListener("pointercancel", cancel);
    cleanup.current = stop;
    setPreview({ id, w: start.w, h: start.h });
  };

  const onResizeKey = (id: string) => (columns: number, height: number) => {
    const current = layout.find((w) => w.id === id);
    if (!current) return;
    const w = Math.min(HOME_COLUMNS, Math.max(1, current.w + columns));
    const h = resizedHeight(current.h, height * HOME_HEIGHT_STEP);
    if (w !== current.w || h !== current.h) commit(layout.map((item) => (item.id === id ? { ...item, w, h } : item)));
  };

  return (
    <>
      <div className="erp-home__top">
        {heading}
        <button type="button" className="erp-btn" onClick={() => commit(defaultLayout.map((w) => ({ ...w })))}>
          {t("reset")}
        </button>
      </div>
      <p className="erp-home__hint">{t("hint")}</p>
      <div className="erp-dash" data-testid="dashboard-grid" ref={gridRef}>
        {shown.map((item) => {
          const size = preview?.id === item.id ? preview : item;
          const widget = widgetOf(item.id);
          return (
            <Widget
              key={item.id}
              title={widget.title}
              meta={widget.meta}
              columns={size.w}
              height={size.h}
              dragging={dragId === item.id}
              over={overId === item.id && dragId !== item.id}
              resizing={preview?.id === item.id}
              onDragStart={onDragStart(item.id)}
              onDragEnd={onDragEnd}
              onDragOver={onDragOver(item.id)}
              onDragLeave={() => setOverId((current) => (current === item.id ? null : current))}
              onDrop={onDrop(item.id)}
              onMoveKey={onMoveKey(item.id)}
              onResizeStart={onResizeStart(item.id)}
              onResizeKey={onResizeKey(item.id)}
            >
              {widget.content}
            </Widget>
          );
        })}
      </div>
    </>
  );
}
