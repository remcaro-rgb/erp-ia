"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Star } from "lucide-react";
import { usePopover } from "./use-popover";
import type { SavedGridState, SavedViewItem } from "./saved-views";

export interface SavedViewsMenuProps {
  views: readonly SavedViewItem[];
  /** The grid's current state, to store under a name. */
  current: () => SavedGridState;
  onSave: (name: string, isDefault: boolean, state: SavedGridState) => Promise<void>;
  onDelete?: (id: string) => Promise<void>;
  onApply: (view: SavedViewItem) => void;
}

/** "Guardar vista" (prototype `saveView`): name the current filters, sort and columns; apply or delete the saved ones. */
export function SavedViewsMenu({ views, current, onSave, onDelete, onApply }: SavedViewsMenuProps) {
  const t = useTranslations();
  const { open, setOpen, close, ref } = usePopover();
  const [name, setName] = useState("");
  const [isDefault, setIsDefault] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // ✕ asks first, in place: the "¿Eliminar {name}?" button deletes; it goes back to the ✕ by itself after 4 s.
  const [arming, setArming] = useState<string | null>(null);
  const [refocus, setRefocus] = useState<string | null>(null);
  useEffect(() => {
    if (!arming) return;
    const timer = setTimeout(() => {
      // The caret was on the question: it goes back to that view's ✕ instead of being lost with the button.
      if (ref.current?.querySelector(`[data-view-confirm="${arming}"]`) === document.activeElement) setRefocus(arming);
      setArming(null);
    }, 4000);
    return () => clearTimeout(timer);
  }, [arming, ref]);
  useEffect(() => {
    if (!open) setArming(null);
  }, [open]);
  useEffect(() => {
    if (refocus === null) return;
    ref.current?.querySelector<HTMLElement>(`[data-view-remove="${refocus}"]`)?.focus();
    setRefocus(null);
  }, [refocus, ref]);

  const save = async () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    setBusy(true);
    try {
      await onSave(trimmed, isDefault, current());
      setStatus(t("grid.views.saved", { name: trimmed }));
      setName("");
      setIsDefault(false);
    } catch {
      setStatus(t("grid.views.failed"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="erp-pop" ref={ref}>
      <button type="button" className="erp-btn" aria-expanded={open} onClick={() => setOpen(!open)}>
        {t("grid.views.save")}
      </button>
      {open && (
        <div className="erp-pop__panel erp-pop__panel--wide" role="group" aria-label={t("grid.views.title")}>
          <div className="erp-pop__head">{t("grid.views.title")}</div>
          {views.length === 0 && <div className="erp-small erp-muted">{t("grid.views.none")}</div>}
          <ul className="erp-pop__list">
            {views.map((view) => (
              <li key={view.id} className="erp-row">
                <button type="button" className="erp-btn erp-btn--ghost erp-btn--sm erp-grow" aria-label={t("grid.views.apply", { name: view.name })} onClick={() => (onApply(view), close())}>
                  {view.isDefault && <Star aria-hidden="true" className="erp-icon" />}
                  {view.name}
                  {view.isDefault && <span className="erp-hint"> · {t("grid.views.is_default")}</span>}
                </button>
                {onDelete &&
                  (arming === view.id ? (
                    <button
                      key="confirm"
                      type="button"
                      className="erp-btn erp-btn--sm"
                      style={{ color: "var(--danger)", borderColor: "var(--danger)" }}
                      autoFocus
                      data-view-confirm={view.id}
                      onClick={() => {
                        setArming(null);
                        void onDelete(view.id);
                        // The question goes away with the view: the caret moves to the name field instead of the page.
                        ref.current?.querySelector<HTMLElement>(".erp-pop__panel input")?.focus();
                      }}
                    >
                      {t("grid.views.confirm_remove", { name: view.name })}
                    </button>
                  ) : (
                    <button key="remove" type="button" className="erp-btn erp-btn--ghost erp-btn--sm" aria-label={t("grid.views.remove", { name: view.name })} data-view-remove={view.id} onClick={() => setArming(view.id)}>
                      ✕
                    </button>
                  ))}
              </li>
            ))}
          </ul>
          <label className="erp-field">
            <span>{t("grid.views.name")}</span>
            <input value={name} maxLength={80} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void save()} />
          </label>
          <label className="erp-pop__check">
            <input type="checkbox" checked={isDefault} onChange={(e) => setIsDefault(e.target.checked)} />
            {t("grid.views.make_default")}
          </label>
          <div className="erp-row">
            <span className="erp-small erp-muted erp-grow" role="status">
              {status}
            </span>
            <button type="button" className="erp-btn erp-btn--primary erp-btn--sm" disabled={busy || name.trim() === ""} onClick={() => void save()}>
              {t("common.save")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
