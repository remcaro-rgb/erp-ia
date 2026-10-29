"use client";

import type { MouseEvent } from "react";
import { useTranslations } from "next-intl";
import { cn } from "@erp/ui/lib/utils";
import { useNavigate } from "../shell/navigate";
import { recordHref } from "./record-model";

/**
 * A link to a record's page (rule 21, design §22.15), as grids, result tables and forms show a reference: the record's
 * name (or its short id when the viewer has no name for it) opening the page `recordHref` names. Inside the shell a plain
 * click moves client-side (no page reload); Ctrl/⌘/Shift-click and the middle button open a new browser tab natively.
 * `inRow`: inside a grid or result-table row it opens its own page, not the row, and stays out of the tab order (the row
 * is the one tab stop and Enter opens it; the record's page has the links).
 */
export function RecordLink({ entity, id, label, mono = false, inRow = false }: { entity: string; id: string; label: string; mono?: boolean; inRow?: boolean }) {
  const t = useTranslations();
  const navigate = useNavigate();
  const href = recordHref(entity, id);
  const onClick = (event: MouseEvent<HTMLAnchorElement>) => {
    event.stopPropagation();
    // The leave guard (capture phase) may have stopped it already; a modified click is the browser's.
    if (!navigate || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    navigate(href);
  };
  return (
    <a className={cn("erp-link erp-link--inline", mono && "erp-mono")} href={href} title={t("grid.open_record", { label })} tabIndex={inRow ? -1 : undefined} onClick={onClick}>
      {label}
    </a>
  );
}
