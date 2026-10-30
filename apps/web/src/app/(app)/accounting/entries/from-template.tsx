"use client";

import { useEffect, useId, useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { formatMoney, MoneyInput, useTabs } from "@erp/ui";
import { Dialog, DialogContent, DialogTitle } from "@erp/ui/components/ui/dialog";
import { fromTemplateAction, listTemplatesAction, templateLinesAction, type TemplateLine, type TemplateOption } from "@/lib/accounting/entry-actions";

// "Nuevo desde plantilla" (accounting design §4.10, §8): pick a plantilla, the date and the values it leaves open, and a draft
// opens in its own tab.

const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

export function FromTemplateButton() {
  const t = useTranslations("common.entry.grid");
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
  const t = useTranslations("common.entry.grid");
  const tc = useTranslations();
  const open = useTabs((s) => s.open);
  const ids = { template: useId(), date: useId() };
  const [templates, setTemplates] = useState<TemplateOption[] | null>(null);
  const [templateId, setTemplateId] = useState("");
  const [lines, setLines] = useState<TemplateLine[]>([]);
  const [amounts, setAmounts] = useState<Record<string, number>>({});
  const [date, setDate] = useState(today());
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  useEffect(() => {
    let live = true;
    void listTemplatesAction().then((list) => live && setTemplates(list));
    return () => {
      live = false;
    };
  }, []);

  const pick = (id: string) => {
    setTemplateId(id);
    setAmounts({});
    setLines([]);
    if (id) void templateLinesAction(id).then(setLines);
  };

  const create = () =>
    start(async () => {
      const result = await fromTemplateAction({ templateId, date, amounts });
      if (result.ok) {
        open({ title: tc("common.entry.draft_title"), href: `/r/accounting.entry/${result.id}`, kind: "record" });
        onClose();
      } else {
        setError(t("template_failed", { reason: result.messages[0] ?? tc(`errors.${tc.has(`errors.${result.code}`) ? result.code : "unknown"}`) }));
      }
    });

  const open_ = lines.filter((l) => l.amount === null);
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (templateId) create();
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
              <select id={ids.template} value={templateId} onChange={(e) => pick(e.target.value)}>
                <option value="">{t("template_pick")}</option>
                {(templates ?? []).map((tpl) => (
                  <option key={tpl.id} value={tpl.id}>
                    {tpl.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="erp-field">
              <label htmlFor={ids.date}>{t("template_date")}</label>
              <input id={ids.date} type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            </div>
            {open_.length > 0 && (
              <fieldset className="erp-field">
                <legend>{t("template_amounts")}</legend>
                {open_.map((l) => (
                  <div key={l.lineNo} className="erp-row">
                    <span className="erp-grow erp-small">
                      {l.lineNo} · {l.account}
                    </span>
                    <MoneyInput aria-label={`${l.account} ${formatMoney(0)}`} value={amounts[String(l.lineNo)] ?? null} onChange={(v) => setAmounts((a) => ({ ...a, [String(l.lineNo)]: v ?? 0 }))} />
                  </div>
                ))}
              </fieldset>
            )}
          </>
        )}
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
        <button type="submit" className="erp-btn erp-btn--primary" disabled={!templateId || pending}>
          {t("template_create")}
        </button>
      </div>
    </form>
  );
}
