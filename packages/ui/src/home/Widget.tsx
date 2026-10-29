"use client";

import type { DragEvent, KeyboardEvent, PointerEvent, ReactNode } from "react";
import { useTranslations } from "next-intl";

// One card of the home dashboard (prototype `.wg`): a header to drag it by, the content, and a corner to resize it from.
// Presentational: the dashboard owns the layout and tells the widget what to show.

export interface WidgetProps {
  title: string;
  /** Right of the title: when the data was read and the like. */
  meta?: ReactNode;
  /** Columns spanned and minimum height, as laid out. */
  columns: number;
  height: number;
  dragging: boolean;
  over: boolean;
  resizing: boolean;
  children: ReactNode;
  onDragStart: (event: DragEvent<HTMLElement>) => void;
  onDragEnd: () => void;
  onDragOver: (event: DragEvent<HTMLElement>) => void;
  onDragLeave: () => void;
  onDrop: (event: DragEvent<HTMLElement>) => void;
  /** Alt + arrow on the header: -1 earlier, +1 later. */
  onMoveKey: (direction: -1 | 1) => void;
  onResizeStart: (event: PointerEvent<HTMLElement>) => void;
  /** Arrow on the corner: columns and px to add. */
  onResizeKey: (columns: number, height: number) => void;
}

const MOVE_KEYS: Record<string, -1 | 1> = { ArrowLeft: -1, ArrowUp: -1, ArrowRight: 1, ArrowDown: 1 };
const RESIZE_KEYS: Record<string, [number, number]> = { ArrowRight: [1, 0], ArrowLeft: [-1, 0], ArrowDown: [0, 1], ArrowUp: [0, -1] };

export function Widget({ title, meta, columns, height, dragging, over, resizing, children, onDragStart, onDragEnd, onDragOver, onDragLeave, onDrop, onMoveKey, onResizeStart, onResizeKey }: WidgetProps) {
  const t = useTranslations("home.dashboard");
  const headerKey = (event: KeyboardEvent<HTMLElement>) => {
    const direction = MOVE_KEYS[event.key];
    if (!event.altKey || direction === undefined) return;
    event.preventDefault();
    onMoveKey(direction);
  };
  const cornerKey = (event: KeyboardEvent<HTMLElement>) => {
    const step = RESIZE_KEYS[event.key];
    if (!step) return;
    event.preventDefault();
    onResizeKey(step[0], step[1]);
  };
  return (
    <section
      role="region"
      aria-label={title}
      className="erp-wg"
      style={{ gridColumn: `span ${columns}`, minHeight: `${height}px` }}
      data-dragging={dragging ? "true" : undefined}
      data-over={over ? "true" : undefined}
      data-resizing={resizing ? "true" : undefined}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <div
        className="erp-wg__hd"
        draggable
        tabIndex={0}
        role="button"
        aria-label={t("move", { title })}
        title={t("move_hint")}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
        onKeyDown={headerKey}
      >
        <span className="erp-wg__grip" aria-hidden="true">⋮⋮</span>
        <span className="erp-wg__title">{title}</span>
        <span className="erp-grow" />
        {meta}
        {/* Only while the card is resized or has the caret (CSS): nobody needs the number otherwise. */}
        <span className="erp-hint erp-wg__size" aria-hidden="true">
          {t("size", { columns, height })}
        </span>
      </div>
      <div className="erp-wg__bd">{children}</div>
      <button type="button" className="erp-wg__rs" aria-label={t("resize", { title })} title={t("resize", { title })} onPointerDown={onResizeStart} onKeyDown={cornerKey} />
    </section>
  );
}
