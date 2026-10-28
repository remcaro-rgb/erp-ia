"use client";

import { useTranslations } from "next-intl";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@erp/ui/components/ui/sheet";
import { TicketView } from "./ticket-view";

export interface TicketSheetProps {
  /** The ticket to show; null keeps the sheet closed. */
  id: string | null;
  onClose: () => void;
  /** A reply or a closing changed the ticket: the grid reads again. */
  onChanged: () => void;
}

/** A ticket in a side sheet: the record frame with Datos, Mensajes, Datos adicionales and Archivos (design §5.16, §8). */
export function TicketSheet({ id, onClose, onChanged }: TicketSheetProps) {
  const t = useTranslations();
  return (
    <Sheet open={id !== null} onOpenChange={(open) => !open && onClose()}>
      <SheetContent side="right" showCloseButton={false} className="erp-sheet" aria-describedby={undefined}>
        <SheetTitle className="sr-only">{t("entity.support.ticket")}</SheetTitle>
        <SheetDescription className="sr-only">{t("feature.support.tickets")}</SheetDescription>
        <button type="button" className="erp-btn erp-btn--ghost erp-sheet__close" aria-label={t("common.close")} onClick={onClose}>
          ✕
        </button>
        {id !== null && <TicketView key={id} id={id} onChanged={onChanged} />}
      </SheetContent>
    </Sheet>
  );
}
