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
import type { RecommendationItem } from "../home/RecommendationCard";
import { recommendationText } from "../home/recommendation-text";
import { MobileMenu } from "./MobileMenu";
import { ThemeToggle } from "./ThemeToggle";
import { nextTheme } from "./theme";
import type { ShellCompany, ShellModule, ShellUser, ThemeMode } from "./types";

export interface TopBarProps {
  company: ShellCompany;
  companies: ShellCompany[];
  user: ShellUser;
  /** Modules the company is entitled to that have items for the caller. */
  modules: ShellModule[];
  activeModuleId: string | undefined;
  /** The «Menú» sheet below 1024 px picks a module (shell v7: the side menu's names). */
  onSelectModule: (moduleId: string) => void;
  theme: ThemeMode;
  onThemeChange: (mode: ThemeMode) => void;
  onOpenPalette: () => void;
  /** The assistant drawer is showing (the toggle's expanded state). */
  assistantOpen?: boolean;
  /** Unread notifications; the dot shows only above zero. Ignored when `notifications` is given (its total counts). */
  notificationCount?: number;
  /**
   * The caller's open recommendations (plan 2B Task 38): `total` on the dot, the newest `items` (five) in the menu, each opening its record
   * (`href`) or Inicio when it has none the caller may open.
   */
  notifications?: { total: number; items: RecommendationItem[] };
  /** Opens a notification's page. */
  onOpenNotification?: (href: string) => void;
  onToggleAssistant: () => void;
  onSwitchCompany?: (companyId: string) => void;
  /** Server action of the sign-out form. */
  signOutAction?: () => void | Promise<void>;
  /** Whether the user's second step is on (design §22.19); with `onOpenMfa`, the user menu offers its dialog. */
  mfaEnrolled?: boolean;
  /** Opens "Verificación en dos pasos". */
  onOpenMfa?: () => void;
  /** With it, the user menu offers "Cambiar contraseña" (kernel.user.password.change). */
  onOpenPassword?: () => void;
}

const menuClass = "min-w-[240px] rounded-lg border border-line bg-surface p-1.5 text-text shadow-[0_10px_30px_var(--shadow)]";
const itemClass = "flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-[13px] text-text focus:bg-head data-[disabled]:opacity-70";
const headClass = "px-2.5 pt-1.5 pb-0.5 text-[11px] font-semibold tracking-[.04em] text-text-muted uppercase";
const TOUCH = "max-md:min-h-11 [@media(pointer:coarse)]:min-h-11";
const barButton = `${TOUCH} rounded-md px-2.5 py-1.5 text-[13px] whitespace-nowrap focus-visible:outline-2 focus-visible:outline-focus`;

export const initialsOf = (name: string): string =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]!.toUpperCase())
    .join("");

/**
 * The navy top bar (design §19a, shell v7 §22.24, prototype `<header class="bar">`): brand, company switcher, the «Menú» sheet below
 * 1024 px, the ⌘K box, theme, notifications, Asistente and the user menu. The modules live in the side menu and the active module's
 * sections in the items bar under this one.
 */
export function TopBar(props: TopBarProps) {
  const { company, companies, user, modules, activeModuleId } = props;
  const t = useTranslations();
  const s = (key: string, values?: Record<string, string | number>) => t(`nav.shell.${key}`, values);
  const active = modules.find((m) => m.id === activeModuleId) ?? modules[0];
  const count = props.notifications ? props.notifications.total : (props.notificationCount ?? 0);
  const notices = props.notifications?.items ?? [];
  const themeName = s(`theme_${props.theme}`).toLowerCase();

  return (
    <header data-bar className="relative z-10 flex h-(--erp-bar-h) shrink-0 items-center gap-1.5 bg-bar px-3 text-bar-text sm:gap-2.5 sm:px-4">
      <div className="mr-1.5 flex shrink-0 items-center gap-2 text-[15px] font-bold whitespace-nowrap text-white">
        {/* The Goliatt wordmark (white on the navy bar); the name stays for assistive technology. */}
        <img src="/goliatt-logo-white.png" alt={s("brand")} className="h-[22px] w-auto" />
      </div>

      <DropdownMenu>
        <DropdownMenuTrigger className={cn(barButton, "flex min-w-[44px] max-w-[96px] items-center bg-bar-ctl text-white sm:max-w-[200px]")} title={company.name}>
          <span className="truncate">{company.name}</span>
          <span aria-hidden="true" className="ml-1 shrink-0">▾</span>
        </DropdownMenuTrigger>
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

      <MobileMenu modules={modules} activeModuleId={active?.id} onSelectModule={props.onSelectModule} />

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
        className="w-[52px] min-w-0 shrink-0 sm:w-[120px] max-md:min-h-11 [@media(pointer:coarse)]:min-h-11 cursor-pointer lg:w-[200px] rounded-md border border-bar-line bg-bar-ctl px-3 py-[7px] text-[13px] whitespace-pre text-white placeholder:text-bar-text focus-visible:outline-2 focus-visible:outline-focus"
      />

      {/* Under 640 px the theme and the notifications live in the user menu (labelled), so the bar keeps the actions that fit. */}
      <div className="hidden sm:contents">
        <ThemeToggle mode={props.theme} onChange={props.onThemeChange} />
      </div>

      <DropdownMenu>
        <DropdownMenuTrigger
          aria-label={s("notifications")}
          className="relative hidden size-[34px] max-md:size-11 [@media(pointer:coarse)]:size-11 shrink-0 place-items-center rounded-md border sm:grid border-bar-line bg-transparent text-bar-text hover:bg-bar-ctl focus-visible:outline-2 focus-visible:outline-focus"
        >
          <Bell aria-hidden="true" className="size-[18px]" />
          {count > 0 && (
            <span aria-hidden="true" className="absolute -top-1 -right-1 grid h-4 min-w-4 place-items-center rounded-full bg-alert px-1 text-[10px] font-bold text-bar tabular-nums">
              {count > 9 ? "9+" : count}
            </span>
          )}
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className={cn(menuClass, "max-w-[360px]")}>
          <DropdownMenuLabel className={headClass}>{s("notifications")}</DropdownMenuLabel>
          {notices.length === 0 ? (
            <DropdownMenuItem disabled className={itemClass}>
              {s("notifications_empty")}
            </DropdownMenuItem>
          ) : (
            <>
              {notices.map((item) => {
                const text = recommendationText(t, item);
                return (
                  <DropdownMenuItem key={item.id} className={cn(itemClass, "flex-col items-start gap-0.5")} onSelect={() => props.onOpenNotification?.(item.href ?? "/")}>
                    <span className="font-semibold">{text.title}</span>
                    <span className="line-clamp-2 text-xs text-text-muted">{text.body}</span>
                  </DropdownMenuItem>
                );
              })}
              <DropdownMenuSeparator className="my-1 bg-line-2" />
              <DropdownMenuItem className={itemClass} onSelect={() => props.onOpenNotification?.("/")}>
                {s("notifications_more")}
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      <button
        type="button"
        onClick={props.onToggleAssistant}
        aria-expanded={props.assistantOpen ?? true}
        id="erp-assistant-toggle"
        aria-controls="erp-assistant"
        aria-keyshortcuts="Control+/ Meta+/"
        title={s("assistant_toggle_title")}
        className={cn(barButton, "bg-white font-semibold text-bar")}
      >
        {s("assistant")}
      </button>

      <DropdownMenu>
        <DropdownMenuTrigger
          aria-label={s("user_menu")}
          className="grid size-[30px] shrink-0 place-items-center overflow-hidden rounded-full max-md:size-11 [@media(pointer:coarse)]:size-11 bg-focus text-xs font-bold text-bar focus-visible:outline-2 focus-visible:outline-white"
        >
          {initialsOf(user.name)}
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className={menuClass}>
          <DropdownMenuLabel className={headClass}>{user.name}</DropdownMenuLabel>
          <DropdownMenuItem disabled className={itemClass}>
            {[user.email, user.roles.join(", ")].filter(Boolean).join(" · ")}
          </DropdownMenuItem>
          <DropdownMenuItem disabled className={cn(itemClass, "sm:hidden")}>
            {s("notifications")}
            <span className="ml-auto text-xs text-text-muted">{count > 0 ? count : s("notifications_empty")}</span>
          </DropdownMenuItem>
          {props.onOpenMfa && (
            <DropdownMenuItem className={itemClass} onSelect={props.onOpenMfa}>
              {s("mfa.menu")}
              <span className="ml-auto text-xs text-text-muted">{props.mfaEnrolled ? s("mfa.menu_on") : s("mfa.menu_off")}</span>
            </DropdownMenuItem>
          )}
          {props.onOpenPassword && (
            <DropdownMenuItem className={itemClass} onSelect={props.onOpenPassword}>
              {s("password.menu")}
            </DropdownMenuItem>
          )}
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
