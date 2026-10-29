"use client";

import { useLocale, useTranslations } from "next-intl";
import { useCellTimeZone } from "../grid/cell-format";
import { clockTime } from "../home/format";

/** `idle`: nothing to follow; `live`: reading on a timer; `paused`: the browser tab is hidden; `error`: the last read failed. */
export type LiveState = "idle" | "live" | "paused" | "error";

/**
 * What a polling surface is doing (UI density audit M1): "En vivo / En pausa / Sin conexión" with the time of the last
 * read, and "Reanudar" when it stopped. The dot is filled when live, a ring when paused, a square when offline: shape,
 * not colour alone. Idle, it only says when it last read.
 */
export function LiveStatus({ state, at, onResume }: { state: LiveState; at: Date | null; onResume?: () => void }) {
  const t = useTranslations("common.live");
  const locale = useLocale();
  const timeZone = useCellTimeZone();
  const time = at ? clockTime(locale, at, timeZone, true) : null;
  if (state === "idle") return time ? <span className="erp-small erp-muted">{t("updated", { time })}</span> : null;
  return (
    <span className="erp-row">
      <span role="status" className={`erp-live${state === "paused" ? " is-paused" : state === "error" ? " is-error" : ""}`}>
        <i aria-hidden="true" />
        {t(state === "live" ? "on" : state === "paused" ? "paused" : "error")}
        {time && <span className="erp-mono">{` · ${time}`}</span>}
      </span>
      {state === "error" && onResume && (
        <button type="button" className="erp-link" onClick={onResume}>
          {t("resume")}
        </button>
      )}
    </span>
  );
}
