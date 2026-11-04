"use client";

import { PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { useTranslations } from "next-intl";
import { NavIcon } from "./nav-icons";
import type { ShellModule } from "./types";

export interface SideMenuProps {
  /** Modules the caller has at least one menu item in, in load order (manifests decide them; the shell never names one, rule 4). */
  modules: ShellModule[];
  activeModuleId: string | undefined;
  onSelectModule: (moduleId: string) => void;
  /** True or false once chosen (or resolved from the viewport after mount); null renders the CSS-first `auto` state. */
  collapsed: boolean | null;
  onToggle: () => void;
}

/** The module's mark in the 60 px rail when its manifest gives no icon: its name's first letter (the name is the accessible label). */
const markOf = (label: string): string => label.trim().charAt(0).toUpperCase();

/**
 * Shell v7 (owner 2026-11-02, design §22.24, rule 19; prototype `.rail`): the left side menu lists the module names only, never
 * their items or sections. It collapses to a 60 px rail («Contraer menú» / «Expandir menú»), remembered per viewer; with nothing
 * saved it is collapsed below 1440 px. Below 1024 px it gives way to the «Menú» sheet.
 */
export function SideMenu({ modules, activeModuleId, onSelectModule, collapsed, onToggle }: SideMenuProps) {
  const t = useTranslations();
  const s = (key: string) => t(`nav.shell.${key}`);
  const shut = collapsed === true;
  // Unresolved (server render, hydration): CSS decides by the viewport, so the toggle states no expanded state yet.
  const toggleLabel = collapsed === null ? s("toggle_menu") : shut ? s("expand_menu") : s("collapse_menu");
  return (
    <aside
      id="erp-side-menu"
      aria-label={s("side_menu")}
      className="erp-side"
      {...(collapsed === null ? { "data-side": "auto" } : { "data-collapsed": String(collapsed) })}
    >
      <div className="erp-side-head">
        <span className="erp-side-title">{s("modules_heading")}</span>
        <button type="button" className="erp-side-toggle" aria-controls="erp-side-nav" {...(collapsed === null ? {} : { "aria-expanded": !shut })} aria-label={toggleLabel} title={toggleLabel} onClick={onToggle}>
          {shut ? <PanelLeftOpen className="size-[18px]" aria-hidden="true" /> : <PanelLeftClose className="size-[18px]" aria-hidden="true" />}
        </button>
      </div>
      <nav id="erp-side-nav" aria-label={s("modules_heading")} className="erp-side-nav">
        {modules.map((m) => {
          const name = t(m.label);
          return (
            <button
              key={m.id}
              type="button"
              aria-label={name}
              title={name}
              aria-current={m.id === activeModuleId ? "true" : undefined}
              className="erp-side-item"
              onClick={() => onSelectModule(m.id)}
            >
              <span className="erp-side-mark" aria-hidden="true">
                {m.icon ? <NavIcon name={m.icon} /> : markOf(name)}
              </span>
              <span className="erp-side-label" aria-hidden="true">
                {name}
              </span>
            </button>
          );
        })}
      </nav>
    </aside>
  );
}
