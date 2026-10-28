"use client";

import type { ReactNode } from "react";
import { useTranslations } from "next-intl";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@erp/ui/components/ui/dialog";

/** The administration's dialogs: a title, the form, the step-up prompt inside (a modal hides what is outside) and the buttons. */
export function AdminDialog(props: { title: string; open: boolean; onClose: () => void; children: ReactNode; footer: ReactNode; wide?: boolean }) {
  const t = useTranslations();
  return (
    <Dialog open={props.open} onOpenChange={(open) => !open && props.onClose()}>
      <DialogContent showCloseButton={false} className="erp-dialog" style={{ maxWidth: props.wide ? 760 : 560 }} aria-describedby={undefined}>
        <div className="erp-dialog__head">
          <DialogTitle className="erp-dialog__title">{props.title}</DialogTitle>
          <DialogDescription className="sr-only">{props.title}</DialogDescription>
          <button type="button" className="erp-btn erp-btn--ghost" aria-label={t("common.close")} onClick={props.onClose}>
            ✕
          </button>
        </div>
        <div className="erp-dialog__body">{props.children}</div>
        <div className="erp-dialog__foot">{props.footer}</div>
      </DialogContent>
    </Dialog>
  );
}
