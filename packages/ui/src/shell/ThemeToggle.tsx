"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Contrast, Moon, Sun } from "lucide-react";
import { cn } from "@erp/ui/lib/utils";
import { applyTheme, nextTheme } from "./theme";
import type { ThemeMode } from "./types";

export interface ThemeToggleProps {
  /** Controlled mode (the shell's); without it the toggle keeps its own, starting at `defaultMode`. */
  mode?: ThemeMode;
  defaultMode?: ThemeMode;
  /** The new mode after a click, to save it (`kernel.user_prefs`, key `theme`). */
  onChange?: (mode: ThemeMode) => void;
  className?: string;
}

const ICON = { auto: Contrast, light: Sun, dark: Moon } as const;

/** The top-bar theme button (prototype `cycleTheme`): auto → light → dark, applied to <html> at once. */
export function ThemeToggle({ mode, defaultMode = "auto", onChange, className }: ThemeToggleProps) {
  const t = useTranslations("nav.shell");
  const [own, setOwn] = useState<ThemeMode>(defaultMode);
  const current = mode ?? own;
  const Icon = ICON[current];

  const cycle = () => {
    const next = nextTheme(current);
    applyTheme(next);
    setOwn(next);
    onChange?.(next);
  };

  return (
    <button
      type="button"
      aria-label={t("theme_toggle")}
      title={t(`theme_title_${current}`)}
      data-mode={current}
      onClick={cycle}
      className={cn(
        "relative grid size-[34px] shrink-0 place-items-center rounded-md border border-bar-line bg-transparent text-[#E6E9ED] hover:bg-bar-ctl focus-visible:outline-2 focus-visible:outline-focus",
        className,
      )}
    >
      <Icon aria-hidden="true" className="size-[18px]" strokeWidth={2} />
    </button>
  );
}
