"use client";

import { useId, useState, type KeyboardEvent, type ReactNode } from "react";
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
  /** Appended to the root's `erp-record` class. Parts are `erp-record__*`. */
  className?: string;
}

/**
 * The frame every record opens in (design §5.16): header with title, N.º, UUID and the open-in-a-new-tab
 * link, the tabs the entity needs, and the status footer. Panels stay mounted when hidden, so a form that is
 * half filled or an upload that is staged survives a change of tab.
 */
export function RecordFrame({ title, seq, uuid, deepLinkHref, tabs, status, footer, initialTab, onTabChange, labels: overrides, className }: RecordFrameProps) {
  const labels: RecordLabels = { ...DEFAULT_RECORD_LABELS, ...overrides, tabs: { ...DEFAULT_RECORD_LABELS.tabs, ...overrides?.tabs } };
  const base = useId();
  const first = tabs[0]?.id;
  const [selected, setSelected] = useState<RecordTabId | undefined>(initialTab ?? first);
  const active = tabs.some((t) => t.id === selected) ? selected : first;

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
    <section className={["erp-record", className].filter(Boolean).join(" ")}>
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
              {tab.label ?? labels.tabs[tab.id]}
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
