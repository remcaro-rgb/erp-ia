"use client";

import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { DEFAULT_RECORD_LABELS, shortId, type RecordLabels, type RecordTab, type RecordTabId } from "./record-model";

export type { RecordLabels, RecordTab, RecordTabId } from "./record-model";

export interface RecordFrameProps {
  title: string;
  /** The record's consecutive number (`N.º`); absent while the record is new. */
  seq?: number | null;
  /** The record's UUID; absent while the record is new. */
  uuid?: string | null;
  /** `/r/<entity>/<id>`: the button that opens the same form as a full page in a new browser tab. Absent while the record is new. */
  deepLinkHref?: string;
  /** Only the tabs passed are rendered, in this order. */
  tabs: readonly RecordTab[];
  /** Left of the footer: the DIAN status and the like. */
  status?: ReactNode;
  /** Right of the footer: save, cancel and the like. */
  footer?: ReactNode;
  initialTab?: RecordTabId;
  onTabChange?: (tab: RecordTabId) => void;
  labels?: Partial<Omit<RecordLabels, "tabs">> & { tabs?: Partial<RecordLabels["tabs"]> };
  /**
   * "Duplicar" (rule 37): given on a stored record the caller may create a copy of, it shows the action in the header
   * and answers Ctrl+D / ⌘+D (the browser's bookmark is prevented) while the frame is mounted. Absent on a new record.
   */
  onDuplicate?: () => void;
  /** A duplicate is under way: the action waits. */
  duplicating?: boolean;
  /** A new record started from a copy: the banner "Copia de <nombre>" names the source, linked when `href` is given. */
  copyOf?: { title: string; href?: string } | null;
  /** Appended to the root's `erp-record` class. Parts are `erp-record__*`. */
  className?: string;
}

/**
 * The frame every record opens in (design §5.16): header with title, N.º, UUID and the open-in-a-new-tab
 * link, the tabs the entity needs, and the status footer. Panels stay mounted when hidden, so a form that is
 * half filled or an upload that is staged survives a change of tab.
 */
export function RecordFrame({ title, seq, uuid, deepLinkHref, tabs, status, footer, initialTab, onTabChange, labels: overrides, className, onDuplicate, duplicating = false, copyOf }: RecordFrameProps) {
  const labels: RecordLabels = { ...DEFAULT_RECORD_LABELS, ...overrides, tabs: { ...DEFAULT_RECORD_LABELS.tabs, ...overrides?.tabs } };
  const base = useId();
  const first = tabs[0]?.id;
  const [selected, setSelected] = useState<RecordTabId | undefined>(initialTab ?? first);
  const active = tabs.some((t) => t.id === selected) ? selected : first;

  // Ctrl+D / ⌘+D on the page while the frame shows a record that can be duplicated; not inside a text box (Ctrl+D is
  // forward delete there on a Mac) and not while a dialog opened over the frame holds the keys.
  const root = useRef<HTMLElement>(null);
  const duplicate = useRef({ onDuplicate, duplicating });
  duplicate.current = { onDuplicate, duplicating };
  const canDuplicate = onDuplicate !== undefined;
  useEffect(() => {
    if (!canDuplicate) return;
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey || event.key.toLowerCase() !== "d") return;
      if (isEditable(event.target) || dialogOver(root.current)) return;
      event.preventDefault();
      const { onDuplicate: run, duplicating: busy } = duplicate.current;
      if (run && !busy && !event.repeat) run();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [canDuplicate]);
  const [copyBefore, copyAfter = ""] = labels.copyOf.split("{name}");

  const select = (id: RecordTabId) => {
    setSelected(id);
    onTabChange?.(id);
  };
  // WAI-ARIA tabs: ← → move (wrapping), Home and End go to the first and last tab.
  const onKeyDown = (event: KeyboardEvent<HTMLElement>, index: number) => {
    if (tabs.length === 0) return;
    const keys: Record<string, number> = { ArrowRight: (index + 1) % tabs.length, ArrowLeft: (index - 1 + tabs.length) % tabs.length, Home: 0, End: tabs.length - 1 };
    const target = keys[event.key];
    if (target === undefined) return;
    event.preventDefault();
    select(tabs[target]!.id);
    document.getElementById(`${base}-tab-${tabs[target]!.id}`)?.focus();
  };

  return (
    <section ref={root} className={["erp-record", className].filter(Boolean).join(" ")}>
      {/* Title and tabs stay in view while a long Datos form scrolls (the shell's <main> is the scroller). */}
      <div className="erp-record__top">
        <header className="erp-record__header">
          <h2>{title}</h2>
          <span className="erp-record__ids">{seq != null && uuid ? `${labels.number} ${seq} · ${labels.uuid} ${shortId(uuid)}…` : labels.assignedOnCreate}</span>
          {deepLinkHref && (
            <a className="erp-record__open" href={deepLinkHref} target="_blank" rel="noopener noreferrer">
              {labels.openInNewTab} ↗
            </a>
          )}
          {onDuplicate && (
            <button type="button" className="erp-btn erp-btn--sm" onClick={onDuplicate} disabled={duplicating} aria-keyshortcuts="Control+D Meta+D">
              {labels.duplicate}
            </button>
          )}
        </header>
        <div role="tablist" className="erp-record__tabs">
          {tabs.map((tab, index) => (
            <button
              key={tab.id}
              id={`${base}-tab-${tab.id}`}
              type="button"
              role="tab"
              data-tab={tab.id}
              aria-selected={tab.id === active}
              aria-controls={`${base}-panel-${tab.id}`}
              tabIndex={tab.id === active ? 0 : -1}
              className={tab.id === active ? "erp-record__tab erp-record__tab--on" : "erp-record__tab"}
              onClick={() => select(tab.id)}
              onKeyDown={(event) => onKeyDown(event, index)}
            >
              {tab.label ?? labels.tabs[tab.id] ?? tab.id}
              {tab.count ? <span className="erp-record__count">{tab.count}</span> : null}
              {tab.warn ? (
                <span className="erp-record__count erp-record__count--warn" title={labels.pending}>
                  {tab.warn}
                </span>
              ) : null}
            </button>
          ))}
        </div>
      </div>
      {copyOf && (
        <div role="status" className="erp-dian erp-dian--info erp-record__copy">
          <strong>
            {copyBefore}
            {copyOf.href ? <a href={copyOf.href}>{copyOf.title}</a> : copyOf.title}
            {copyAfter}
          </strong>{" "}
          {labels.copyNote}
        </div>
      )}
      {tabs.map((tab) => (
        <div key={tab.id} id={`${base}-panel-${tab.id}`} role="tabpanel" aria-labelledby={`${base}-tab-${tab.id}`} hidden={tab.id !== active} className="erp-record__panel">
          {tab.content}
        </div>
      ))}
      <footer className="erp-record__footer">
        <div className="erp-record__status">{status}</div>
        <div className="erp-record__actions">{footer}</div>
      </footer>
    </section>
  );
}

/** A text box, list or editable region: its own keys win over the frame's shortcut. */
function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  if (target.closest("input, textarea, select")) return true;
  const editable = target.closest("[contenteditable]");
  return editable !== null && editable.getAttribute("contenteditable") !== "false";
}

/** An open dialog that does not contain the frame (a frame shown in a sheet still answers its shortcut). */
function dialogOver(frame: HTMLElement | null): boolean {
  return [...document.querySelectorAll('[role="dialog"], [role="alertdialog"], [aria-modal="true"]')].some((dialog) => !frame || !dialog.contains(frame));
}
