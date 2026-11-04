"use client";

import { useEffect, useId, useState } from "react";
import { useTranslations } from "next-intl";
import { useTabs } from "@erp/ui";
import { Dialog, DialogContent, DialogTitle } from "@erp/ui/components/ui/dialog";
import { NEW_RECORD_ID } from "@/lib/records/entities";
import { listTemplatesAction, type TemplateOption } from "@/lib/accounting/entry-actions";

// "Nuevo desde plantilla" (accounting design §4.10, §8): pick a plantilla and the new-comprobante page opens in its own tab, filled
// with the plantilla's Fuente, description and lines. Nothing is saved until the user saves it there.

export function FromTemplateButton() {
  const t = useTranslations("accounting.entry.grid");
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="erp-btn" onClick={() => setOpen(true)}>
        {t("from_template")}
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent showCloseButton={false} className="erp-dialog" aria-describedby={undefined} style={{ maxWidth: 520 }}>
          {open && <Body onClose={() => setOpen(false)} />}
        </DialogContent>
      </Dialog>
    </>
  );
}

function Body({ onClose }: { onClose: () => void }) {
  const t = useTranslations("accounting.entry.grid");
  const tc = useTranslations();
  const open = useTabs((s) => s.open);
  const ids = { template: useId() };
  const [templates, setTemplates] = useState<TemplateOption[] | null>(null);
  const [templateId, setTemplateId] = useState("");

  useEffect(() => {
    let live = true;
    void listTemplatesAction().then((list) => live && setTemplates(list));
    return () => {
      live = false;
    };
  }, []);

  const chosen = templates?.find((tpl) => tpl.id === templateId) ?? null;
  const go = () => {
    if (!chosen) return;
    open({ title: tc("grid.record_title.new", { entity: tc("nav.create.accounting.entry") }), href: `/r/accounting.entry/${NEW_RECORD_ID}?template=${chosen.id}`, kind: "record" });
    onClose();
  };

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        go();
      }}
    >
      <div className="erp-dialog__head">
        <DialogTitle className="erp-dialog__title">{t("from_template")}</DialogTitle>
      </div>
      <div className="erp-dialog__body erp-form">
        {templates !== null && templates.length === 0 ? (
          <p className="erp-muted">{t("template_none")}</p>
        ) : (
          <>
            <div className="erp-field">
              <label htmlFor={ids.template}>{t("template")}</label>
              <select id={ids.template} value={templateId} onChange={(e) => setTemplateId(e.target.value)}>
                <option value="">{t("template_pick")}</option>
                {(templates ?? []).map((tpl) => (
                  <option key={tpl.id} value={tpl.id}>
                    {tpl.name}
                  </option>
                ))}
              </select>
            </div>
            {chosen?.note && <p className="erp-small erp-muted">{chosen.note}</p>}
          </>
        )}
      </div>
      <div className="erp-dialog__foot erp-row">
        <button type="button" className="erp-btn" onClick={onClose}>
          {tc("common.cancel")}
        </button>
        <button type="submit" className="erp-btn erp-btn--primary" disabled={!chosen}>
          {t("template_open")}
        </button>
      </div>
    </form>
  );
}
