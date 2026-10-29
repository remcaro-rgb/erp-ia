"use client";

import type { ReactNode } from "react";
import { useTranslations } from "next-intl";
import { Bell, Check } from "lucide-react";
import { cn } from "@erp/ui/lib/utils";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@erp/ui/components/ui/dropdown-menu";
import { ModuleBar } from "./ModuleBar";
import { ThemeToggle } from "./ThemeToggle";
import { nextTheme } from "./theme";
import type { NavItem, ShellCompany, ShellModule, ShellUser, ThemeMode } from "./types";

export interface TopBarProps {
  company: ShellCompany;
  companies: ShellCompany[];
  user: ShellUser;
  /** Modules the company is entitled to that have items for the caller. */
  modules: ShellModule[];
  /** Items per module id. */
  itemsByModule: Record<string, NavItem[]>;
  activeModuleId: string | undefined;
  onSelectModule: (moduleId: string) => void;
  activeHref: string;
  onNavigate: (target: { href: string; title: string; kind: "home" | "grid" }) => void;
  theme: ThemeMode;
  onThemeChange: (mode: ThemeMode) => void;
  onOpenPalette: () => void;
  onToggleAssistant: () => void;
  onSwitchCompany?: (companyId: string) => void;
  /** Server action of the sign-out form. */
  signOutAction?: () => void | Promise<void>;
}

const menuClass = "min-w-[240px] rounded-lg border border-line bg-surface p-1.5 text-text shadow-[0_10px_30px_var(--shadow)]";
const itemClass = "flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-[13px] text-text focus:bg-head data-[disabled]:opacity-70";
const headClass = "px-2.5 pt-1.5 pb-0.5 text-[11px] font-semibold tracking-[.04em] text-text-muted uppercase";
const barButton = "rounded-md px-2.5 py-1.5 text-[13px] whitespace-nowrap focus-visible:outline-2 focus-visible:outline-focus";

export const initialsOf = (name: string): string =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]!.toUpperCase())
    .join("");

/**
 * The navy top bar (design §19a, prototype `<header class="bar">`): brand, company switcher, Módulos menu with
 * the active module's items next to it, the ⌘K box, theme, notifications, Asistente and the user menu.
 */
export function TopBar(props: TopBarProps) {
  const { company, companies, user, modules, itemsByModule, activeModuleId, activeHref } = props;
  const t = useTranslations();
  const s = (key: string, values?: Record<string, string | number>) => t(`nav.shell.${key}`, values);
  const active = modules.find((m) => m.id === activeModuleId) ?? modules[0];
  const themeName = s(`theme_${props.theme}`).toLowerCase();

  return (
    <header data-bar className="relative z-10 flex h-12 shrink-0 items-center gap-2.5 bg-bar px-4 text-bar-text">
      <div className="mr-1.5 flex items-center gap-2 text-[15px] font-bold whitespace-nowrap text-white">
        <i aria-hidden="true" className="inline-block size-[22px] rounded-md bg-focus" />
        {s("brand")}
      </div>

      <DropdownMenu>
        <DropdownMenuTrigger className={cn(barButton, "bg-bar-ctl text-white")}>{company.name} ▾</DropdownMenuTrigger>
        <DropdownMenuContent align="start" className={menuClass}>
          <DropdownMenuLabel className={headClass}>{s("active_company")}</DropdownMenuLabel>
          {companies.map((c) => (
            <DropdownMenuItem
              key={c.id}
              className={itemClass}
              onSelect={() => c.id !== company.id && props.onSwitchCompany?.(c.id)}
              disabled={c.id !== company.id && !props.onSwitchCompany}
            >
              <span className="inline-flex w-4 justify-center">{c.id === company.id && <Check className="size-4" aria-hidden="true" />}</span>
              {c.name}
              {c.taxId && <span className="ml-auto text-xs text-text-muted">{s("tax_id", { id: c.taxId })}</span>}
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator className="my-1 bg-line-2" />
          <DropdownMenuItem disabled className={itemClass}>
            {s("add_company")}
            <span className="ml-auto text-xs text-text-muted">{s("add_company_later")}</span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <DropdownMenu>
        <DropdownMenuTrigger className={cn(barButton, "border border-bar-line bg-transparent text-bar-text")} title={s("modules")}>
          {active ? t(active.label) : s("modules")} ▾
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className={menuClass}>
          <DropdownMenuLabel className={headClass}>{s("modules_title")}</DropdownMenuLabel>
          {modules.map((m) => (
            <DropdownMenuItem key={m.id} className={itemClass} onSelect={() => props.onSelectModule(m.id)}>
              <span className="inline-flex w-4 justify-center">{m.id === active?.id && <Check className="size-4" aria-hidden="true" />}</span>
              {t(m.label)}
              <span className="ml-auto text-xs text-text-muted">{s("module_options", { count: itemsByModule[m.id]?.length ?? 0 })}</span>
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>

      {active && (
        <ModuleBar
          items={(itemsByModule[active.id] ?? []).filter((item) => item.menu !== false)}
          showHome={active.id === modules[0]?.id}
          activeHref={activeHref}
          onNavigate={props.onNavigate}
        />
      )}

      <div className="grow" />

      <label htmlFor="erp-cmd" className="sr-only">
        {s("command_label")}
      </label>
      <input
        id="erp-cmd"
        type="text"
        readOnly
        placeholder={s("command_placeholder")}
        onClick={props.onOpenPalette}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") props.onOpenPalette();
        }}
        className="w-[200px] cursor-pointer rounded-md border border-bar-line bg-bar-ctl px-3 py-[7px] text-[13px] whitespace-pre text-white placeholder:text-bar-text focus-visible:outline-2 focus-visible:outline-focus"
      />

      <ThemeToggle mode={props.theme} onChange={props.onThemeChange} />

      <DropdownMenu>
        <DropdownMenuTrigger
          aria-label={s("notifications")}
          className="relative grid size-[34px] shrink-0 place-items-center rounded-md border border-bar-line bg-transparent text-bar-text hover:bg-bar-ctl focus-visible:outline-2 focus-visible:outline-focus"
        >
          <Bell aria-hidden="true" className="size-[18px]" />
          <span aria-hidden="true" className="absolute top-[5px] right-[5px] size-2 rounded-full bg-alert" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className={menuClass}>
          <DropdownMenuLabel className={headClass}>{s("notifications")}</DropdownMenuLabel>
          <DropdownMenuItem disabled className={itemClass}>
            {s("notifications_empty")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <button type="button" onClick={props.onToggleAssistant} className={cn(barButton, "bg-white font-semibold text-bar")}>
        {s("assistant")}
      </button>

      <DropdownMenu>
        <DropdownMenuTrigger
          aria-label={s("user_menu")}
          className="grid size-[30px] shrink-0 place-items-center overflow-hidden rounded-full bg-focus text-xs font-bold text-bar focus-visible:outline-2 focus-visible:outline-white"
        >
          {initialsOf(user.name)}
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className={menuClass}>
          <DropdownMenuLabel className={headClass}>{user.name}</DropdownMenuLabel>
          <DropdownMenuItem disabled className={itemClass}>
            {[user.email, user.roles.join(", ")].filter(Boolean).join(" · ")}
          </DropdownMenuItem>
          <DropdownMenuItem
            className={itemClass}
            onSelect={(event) => {
              event.preventDefault();
              props.onThemeChange(nextTheme(props.theme));
            }}
          >
            {s("theme_menu", { mode: themeName })}
            <span className="ml-auto text-xs text-text-muted">{s("theme_change")}</span>
          </DropdownMenuItem>
          <DropdownMenuSeparator className="my-1 bg-line-2" />
          <SignOutItem action={props.signOutAction}>{s("sign_out")}</SignOutItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </header>
  );
}

function SignOutItem({ action, children }: { action?: () => void | Promise<void>; children: ReactNode }) {
  if (!action) return null;
  return (
    <form action={action}>
      <DropdownMenuItem asChild className={itemClass}>
        <button type="submit">{children}</button>
      </DropdownMenuItem>
    </form>
  );
}
