"use client";

import { useEffect, useRef, useState, type DragEvent, type FocusEvent, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import { useTranslations } from "next-intl";

// One card of the home dashboard (prototype `.wg`): a header to drag it by, the content, and a corner to resize it from.
// Presentational: the dashboard owns the layout and tells the widget what to show. The header is a real button: Enter or
// Space opens the "Mover" mode (arrows move the card, Shift + arrows resize it, Esc leaves), for readers without a mouse.

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
const MOVE_SHORTCUTS = "Alt+ArrowLeft Alt+ArrowRight Alt+ArrowUp Alt+ArrowDown";

export function Widget({ title, meta, columns, height, dragging, over, resizing, children, onDragStart, onDragEnd, onDragOver, onDragLeave, onDrop, onMoveKey, onResizeStart, onResizeKey }: WidgetProps) {
  const t = useTranslations("home.dashboard");
  // "Mover" mode: on while the header has the caret after Enter or Space.
  const [moving, setMoving] = useState(false);
  const header = useRef<HTMLButtonElement>(null);
  // Moving the card reorders its DOM node, which may drop the caret; the mode keeps it on the header.
  useEffect(() => {
    if (moving && document.activeElement === document.body) header.current?.focus({ preventScroll: true });
  });
  const headerKey = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      setMoving((on) => !on);
      return;
    }
    if (event.key === "Escape" && moving) {
      event.preventDefault();
      setMoving(false);
      return;
    }
    if (event.ctrlKey || event.metaKey) return;
    if (moving && event.shiftKey && !event.altKey) {
      const step = RESIZE_KEYS[event.key];
      if (!step) return;
      event.preventDefault();
      onResizeKey(step[0], step[1]);
      return;
    }
    const direction = MOVE_KEYS[event.key];
    if (direction === undefined || !(event.altKey || moving)) return;
    event.preventDefault();
    onMoveKey(direction);
  };
  // The caret moving to another control ends the mode; the card being moved under it (blur without a target) does not.
  const headerBlur = (event: FocusEvent<HTMLElement>) => {
    if (event.relatedTarget !== null && event.relatedTarget !== event.currentTarget) setMoving(false);
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
      data-moving={moving ? "true" : undefined}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <button
        ref={header}
        type="button"
        className="erp-wg__hd"
        draggable
        aria-pressed={moving}
        aria-keyshortcuts={MOVE_SHORTCUTS}
        aria-label={t("move", { title })}
        title={t("move_hint")}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
        onKeyDown={headerKey}
        onBlur={headerBlur}
      >
        <span className="erp-wg__grip" aria-hidden="true">⋮⋮</span>
        <span className="erp-wg__title">{title}</span>
        <span className="erp-grow" />
        {meta}
        {/* Only while the card is resized, moved or has the caret (CSS): nobody needs the number otherwise. */}
        <span className="erp-hint erp-wg__size" aria-hidden="true">
          {t("size", { columns, height })}
        </span>
      </button>
      <div className="erp-wg__mode" role="status">
        {moving ? t("mode_hint") : null}
      </div>
      <div className="erp-wg__bd">{children}</div>
      <button type="button" className="erp-wg__rs" aria-label={t("resize", { title })} title={t("resize", { title })} onPointerDown={onResizeStart} onKeyDown={cornerKey} />
    </section>
  );
}
