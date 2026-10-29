"use client";

import { useLocale, useTranslations } from "next-intl";
import { useCellTimeZone } from "../grid/cell-format";
import { clockTime } from "./format";

/**
 * When a snapshot was read ("Actualizado 10:42"), in the company's zone: the home's widgets are a server snapshot, and
 * after a long shift the reader needs to know how old the numbers are (UI density audit M11).
 */
export function UpdatedAt({ at, seconds = false, className = "erp-wg__asof" }: { at: string; seconds?: boolean; className?: string }) {
  const t = useTranslations("common.live");
  const locale = useLocale();
  const timeZone = useCellTimeZone();
  return (
    <time className={className} dateTime={at}>
      {t("updated", { time: clockTime(locale, at, timeZone, seconds) })}
    </time>
  );
}
