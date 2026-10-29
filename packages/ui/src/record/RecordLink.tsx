"use client";

import type { MouseEvent } from "react";
import { useTranslations } from "next-intl";
import { cn } from "@erp/ui/lib/utils";
import { recordHref } from "./record-model";

/**
 * A link to a record's page (rule 21, design §22.15), as grids, result tables and forms show a reference: the record's
 * name (or its short id when the viewer has no name for it) opening the page `recordHref` names, in the same browser tab
 * (Ctrl/⌘-click opens a new one, natively). Inside a grid row it opens its own page, not the row.
 */
export function RecordLink({ entity, id, label, mono = false }: { entity: string; id: string; label: string; mono?: boolean }) {
  const t = useTranslations();
  return (
    <a className={cn("erp-link erp-link--inline", mono && "erp-mono")} href={recordHref(entity, id)} title={t("grid.open_record", { label })} onClick={(event: MouseEvent) => event.stopPropagation()}>
      {label}
    </a>
  );
}
