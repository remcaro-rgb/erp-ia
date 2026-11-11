"use client";

import { useTranslations } from "next-intl";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@erp/ui/components/ui/dialog";

/** One KPI or chart the user can switch: the kernel's catalogue entry (keys for its name and its one-line description). */
export interface CustomizeItem {
  id: string;
  kind: "kpi" | "chart";
  module: string;
  label: string;
  description: string;
}

export interface CustomizeDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  items: CustomizeItem[];
  /** Ids switched off. */
  hidden: readonly string[];
  /** The new list of switched-off ids. */
  onChange: (hidden: string[]) => void;
  /** The save of the last change failed. */
  error?: boolean;
}

/**
 * "Personalizar página de inicio": every indicator and chart the user could see on this page with a short description and an
 * on/off switch. Items are grouped by module (when the page spans several) and by kind. New items start on: the stored list is
 * the ones switched off.
 */
export function CustomizeDialog({ open, onOpenChange, items, hidden, onChange, error = false }: CustomizeDialogProps) {
  const t = useTranslations();
  const d = (key: string, values?: Record<string, string | number>) => t(`home.dashboard.${key}`, values);
  const off = new Set(hidden);
  const set = (next: Set<string>) => onChange([...next].sort());
  const toggle = (id: string) => {
    const next = new Set(off);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    set(next);
  };
  const modules = [...new Set(items.map((i) => i.module))];
  const on = items.filter((i) => !off.has(i.id)).length;

  const row = (item: CustomizeItem) => {
    const checked = !off.has(item.id);
    const label = t(item.label);
    return (
      <li key={item.id} className="erp-custom__item" data-item={item.id}>
        <div className="erp-custom__text">
          <span className="erp-custom__name">{label}</span>
          <span className="erp-muted erp-small erp-custom__desc">{t(item.description)}</span>
        </div>
        <button type="button" role="switch" aria-checked={checked} aria-label={d("customize_toggle", { label })} className={checked ? "erp-toggle is-on" : "erp-toggle"} onClick={() => toggle(item.id)} />
      </li>
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="erp-custom flex max-h-[86vh] flex-col gap-3 sm:max-w-xl" data-testid="customize-dialog">
        <DialogTitle>{d("customize")}</DialogTitle>
        <DialogDescription>{d("customize_intro")}</DialogDescription>
        {items.length === 0 ? (
          <p className="erp-muted erp-small">{d("customize_empty")}</p>
        ) : (
          <>
            <div className="erp-custom__bar">
              <span className="erp-muted erp-small" aria-live="polite">
                {d("customize_count", { on, total: items.length })}
              </span>
              <span className="erp-row">
                <button type="button" className="erp-btn" onClick={() => set(new Set())}>
                  {d("customize_all_on")}
                </button>
                <button type="button" className="erp-btn" onClick={() => set(new Set(items.map((i) => i.id)))}>
                  {d("customize_all_off")}
                </button>
              </span>
            </div>
            <div className="erp-custom__list min-h-0 flex-1 overflow-y-auto">
              {modules.map((module) => (
                <section key={module} aria-label={modules.length > 1 ? t(`nav.modules.${module}`) : undefined}>
                  {modules.length > 1 ? <h3 className="erp-custom__module">{t(`nav.modules.${module}`)}</h3> : null}
                  {(["kpi", "chart"] as const).map((kind) => {
                    const rows = items.filter((i) => i.module === module && i.kind === kind);
                    return rows.length === 0 ? null : (
                      <div key={kind}>
                        <h4 className="erp-custom__kind">{d(kind === "kpi" ? "customize_kpis" : "customize_charts")}</h4>
                        <ul>{rows.map(row)}</ul>
                      </div>
                    );
                  })}
                </section>
              ))}
            </div>
          </>
        )}
        {error ? (
          <div role="alert" className="erp-grid__error">
            {d("customize_error")}
          </div>
        ) : null}
        <div className="erp-custom__foot">
          <button type="button" className="erp-btn erp-btn--primary" onClick={() => onOpenChange(false)}>
            {d("customize_done")}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
