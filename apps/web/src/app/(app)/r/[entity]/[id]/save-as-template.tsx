"use client";

import { useId, useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { useTabs } from "@erp/ui";
import { Dialog, DialogContent, DialogTitle } from "@erp/ui/components/ui/dialog";
import { saveAsTemplateAction } from "@/lib/accounting/entry-actions";

// "Guardar como plantilla" (accounting design §4.10), opened from the action bar next to Revertir: keeps the stored comprobante's Fuente, description and lines as a plantilla de
// comprobante, which then opens in its own tab. "Dejar los valores en blanco" asks for the amounts each time it is used.

export function SaveAsTemplateDialog({ entryId, open, onClose }: { entryId: string; open: boolean; onClose: () => void }) {
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent showCloseButton={false} className="erp-dialog" aria-describedby={undefined} style={{ maxWidth: 480 }}>
        {open && <Body entryId={entryId} onClose={onClose} />}
      </DialogContent>
    </Dialog>
  );
}

function Body({ entryId, onClose }: { entryId: string; onClose: () => void }) {
  const t = useTranslations("accounting.entry.save_template");
  const tc = useTranslations();
  const openTab = useTabs((s) => s.open);
  const ids = { name: useId(), blank: useId() };
  const [name, setName] = useState("");
  const [blank, setBlank] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const save = () =>
    start(async () => {
      const result = await saveAsTemplateAction({ entryId, name: name.trim(), blankAmounts: blank });
      if (result.ok) {
        openTab({ title: name.trim(), href: `/r/accounting.entry_template/${result.id}`, kind: "record" });
        onClose();
      } else {
        const reason = result.messages[0] ?? (result.code === "template_lines" ? t("lines_refused") : tc(`errors.${tc.has(`errors.${result.code}`) ? result.code : "unknown"}`));
        setError(t("failed", { reason }));
      }
    });

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (name.trim()) save();
      }}
    >
      <div className="erp-dialog__head">
        <DialogTitle className="erp-dialog__title">{t("button")}</DialogTitle>
      </div>
      <div className="erp-dialog__body erp-form">
        <div className="erp-field">
          <label htmlFor={ids.name}>{t("name")}</label>
          <input id={ids.name} value={name} maxLength={120} autoFocus onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="erp-field">
          <label htmlFor={ids.blank}>
            <input id={ids.blank} type="checkbox" checked={blank} onChange={(e) => setBlank(e.target.checked)} /> {t("blank")}
          </label>
        </div>
        {error && (
          <div role="alert" className="erp-dian erp-dian--bad">
            {error}
          </div>
        )}
      </div>
      <div className="erp-dialog__foot erp-row">
        <button type="button" className="erp-btn" onClick={onClose}>
          {tc("common.cancel")}
        </button>
        <button type="submit" className="erp-btn erp-btn--primary" disabled={!name.trim() || pending}>
          {t("save")}
        </button>
      </div>
    </form>
  );
}
