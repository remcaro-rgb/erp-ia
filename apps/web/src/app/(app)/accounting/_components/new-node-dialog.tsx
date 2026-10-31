"use client";

import { useId, useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { Dialog, DialogContent, DialogTitle } from "@erp/ui/components/ui/dialog";
import { createMasterNodeAction } from "@/lib/accounting/actions";

export interface NodeParent {
  id: string;
  code: string;
  name: string;
}

/**
 * "Nueva cuenta auxiliar" and "Nuevo" of the masters (accounting design §4.1, §4.5, §8): the fields of the entity's create process,
 * the parent being the node the page has selected. An account takes código and descripción (the process derives the rest from the
 * parent subcuenta); an analytic node also its tipo, grupo or hoja. A refusal of the process is shown as it comes.
 */
export function NewNodeDialog({ open, onOpenChange, entity, title, parent, onCreated }: { open: boolean; onOpenChange: (open: boolean) => void; entity: string; title: string; parent: NodeParent | null; onCreated: () => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent showCloseButton={false} className="erp-dialog" aria-describedby={undefined} style={{ maxWidth: 460 }}>
        {open && <NewNodeBody entity={entity} title={title} parent={parent} onClose={() => onOpenChange(false)} onCreated={onCreated} />}
      </DialogContent>
    </Dialog>
  );
}

function NewNodeBody({ entity, title, parent, onClose, onCreated }: { entity: string; title: string; parent: NodeParent | null; onClose: () => void; onCreated: () => void }) {
  const t = useTranslations();
  const ids = { code: useId(), name: useId(), kind: useId() };
  const isAccount = entity === "accounting.account";
  // An auxiliary account's code starts with its parent's.
  const [code, setCode] = useState(isAccount && parent ? parent.code : "");
  const [name, setName] = useState("");
  const [kind, setKind] = useState<"group" | "leaf">("leaf");
  const [active, setActive] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const submit = () =>
    start(async () => {
      const result = await createMasterNodeAction(entity, { code, name, parentId: isAccount ? null : (parent?.id ?? null), kind, isActive: active });
      if (result.ok) {
        onCreated();
        onClose();
      } else {
        setError(t("accounting.master.failed", { reason: result.details[0] ?? t(`errors.${result.code}`) }));
      }
    });

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <div className="erp-dialog__head">
        <DialogTitle className="erp-dialog__title">{title}</DialogTitle>
      </div>
      <div className="erp-dialog__body">
        <p className="erp-small erp-muted">{parent ? t("accounting.master.under", { node: `${parent.code} ${parent.name}` }) : t("accounting.master.top_level")}</p>
        <div className="erp-field">
          <label htmlFor={ids.code}>{t("accounting.master.code")}</label>
          <input id={ids.code} className="erp-mono" value={code} onChange={(e) => { setCode(e.target.value); setError(null); }} autoFocus inputMode={isAccount ? "numeric" : undefined} required />
        </div>
        <div className="erp-field">
          <label htmlFor={ids.name}>{t("accounting.master.name")}</label>
          <input id={ids.name} value={name} onChange={(e) => { setName(e.target.value); setError(null); }} required maxLength={200} />
        </div>
        {!isAccount && (
          <>
            <div className="erp-field">
              <label htmlFor={ids.kind}>{t("accounting.master.kind")}</label>
              <select id={ids.kind} value={kind} onChange={(e) => setKind(e.target.value as "group" | "leaf")}>
                <option value="leaf">{t("accounting.values.dimension_kind.leaf")}</option>
                <option value="group">{t("accounting.values.dimension_kind.group")}</option>
              </select>
            </div>
            <label className="erp-switch">
              <button type="button" role="switch" aria-checked={active} aria-label={t("accounting.master.active")} className={active ? "erp-toggle is-on" : "erp-toggle"} onClick={() => setActive((a) => !a)} />
              {t("accounting.master.active")}
            </label>
          </>
        )}
        {error && (
          <div role="alert" className="erp-dian erp-dian--bad">
            {error}
          </div>
        )}
      </div>
      <div className="erp-dialog__foot">
        <button type="button" className="erp-btn" onClick={onClose}>
          {t("accounting.master.cancel")}
        </button>
        <button type="submit" className="erp-btn erp-btn--primary" disabled={pending || code.trim() === "" || name.trim() === ""}>
          {t("accounting.master.create")}
        </button>
      </div>
    </form>
  );
}
