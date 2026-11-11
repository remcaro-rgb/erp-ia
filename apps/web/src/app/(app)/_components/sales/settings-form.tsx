"use client";

import { useId, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { EntityLookup, gridFetcher, parseMoney, recordHref, StepUpPrompt, type CodeOption, type LookupSource } from "@erp/ui";
import { requestStepUp } from "@/lib/auth/step-up-client";
import { saveSalesSettingsAction } from "@/lib/sales/actions";

// The parámetros pages of CRM and Ventas and a customer's condiciones comerciales (plan 2B Task 14b): a few boxes saved by one process each
// (crm.settings.update, sales.settings.update, sales.customer_terms.set); the server action picks the process from the page's kind. A
// refusal shows the process's reasons; a step-up asks for the code (rule 15).

export interface SettingsBox {
  /** The process input's key. */
  key: string;
  label: string;
  hint?: string;
  kind: "percent" | "days" | "money" | "select" | "text";
  /** Empty means null (no threshold, no list, no limit); a `days` box is never empty. */
  nullable?: boolean;
  /** A select with no empty choice (a setting that always has a value, as the commission basis). */
  required?: boolean;
  options?: readonly CodeOption[];
  value: string;
}

/** A number as typed (`10`, `12,5`, `1.500.000`): money through the money parser (rule 23), the rest with a decimal comma or point. */
const numberOf = (kind: SettingsBox["kind"], text: string): number => (kind === "money" ? (parseMoney(text) ?? Number.NaN) : Number(text.trim().replace(",", ".")));

function Box({ box, value, disabled, onChange }: { box: SettingsBox; value: string; disabled: boolean; onChange: (value: string) => void }) {
  const id = useId();
  return (
    <div className={box.kind === "text" ? "erp-field erp-span3" : "erp-field"}>
      <label htmlFor={id}>
        {box.label}
        {box.hint && <span className="erp-field__hint"> {box.hint}</span>}
      </label>
      {box.kind === "select" ? (
        <select id={id} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
          {!box.required && <option value="">—</option>}
          {(box.options ?? []).map((o) => (
            <option key={o.code} value={o.code}>
              {o.name}
            </option>
          ))}
        </select>
      ) : (
        <input id={id} value={value} disabled={disabled} inputMode={box.kind === "text" ? "text" : "decimal"} maxLength={box.kind === "text" ? 500 : 20} className={box.kind === "text" ? undefined : "erp-num erp-mono"} onChange={(e) => onChange(e.target.value)} />
      )}
    </div>
  );
}

/** What the boxes send: each typed number as a number, an empty nullable box as null, an empty other box left out. */
function inputOf(boxes: readonly SettingsBox[], values: Record<string, string>): { input: Record<string, unknown>; bad: string[] } {
  const input: Record<string, unknown> = {};
  const bad: string[] = [];
  for (const box of boxes) {
    const text = (values[box.key] ?? "").trim();
    if (text === "") {
      if (box.nullable) input[box.key] = null;
      continue;
    }
    if (box.kind === "select" || box.kind === "text") {
      input[box.key] = text;
      continue;
    }
    const n = numberOf(box.kind, text);
    if (!Number.isFinite(n) || n < 0 || (box.kind === "percent" && n > 100) || (box.kind === "days" && !Number.isInteger(n))) bad.push(box.label);
    else input[box.key] = n;
  }
  return { input, bad };
}

/** Parámetros de CRM / de ventas: the company's boxes, one Guardar. */
export function SalesSettingsForm({ kind, title, hint, boxes, canSave }: { kind: "crm" | "sales"; title: string; hint: string; boxes: readonly SettingsBox[]; canSave: boolean }) {
  const t = useTranslations("sales.settings_page");
  const router = useRouter();
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(boxes.map((b) => [b.key, b.value])));
  const save = useSave(kind, () => router.refresh());
  const { input, bad } = inputOf(boxes, values);
  return (
    <div className="erp-form mx-auto w-full max-w-3xl">
      <section className="erp-sec">
        <h3>{title}</h3>
        <p className="erp-small erp-muted">{hint}</p>
        <div className="erp-form2">
          {boxes.map((box) => (
            <Box key={box.key} box={box} value={values[box.key] ?? ""} disabled={!canSave || save.busy} onChange={(v) => (save.clear(), setValues((s) => ({ ...s, [box.key]: v })))} />
          ))}
        </div>
      </section>
      {bad.length > 0 && <p className="erp-small erp-field__error">{t("bad_number", { fields: bad.join(", ") })}</p>}
      {save.message && (
        <div className={save.message.ok ? "erp-dian erp-dian--ok" : "erp-dian erp-dian--bad"} role={save.message.ok ? "status" : "alert"}>
          {save.message.text}
        </div>
      )}
      {canSave && (
        <div className="erp-form__actions">
          {save.stepUp && <StepUpPrompt onConfirm={(code) => void save.confirm(code, t("saved"))} onCancel={save.cancel} error={save.stepUpError} busy={save.busy} />}
          <div className="erp-row">
            <span className="erp-grow" />
            <button type="button" className="erp-btn erp-btn--primary" disabled={save.busy || save.stepUp || bad.length > 0} onClick={() => void save.run(input, t("saved"))}>
              {t("save")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Condiciones comerciales de un cliente: the customer (a lookup), then their price list, standing discount, credit limit and notes; saving
 * through sales.customer_terms.set writes them or changes the ones they had. The grid above lists the customers that have some.
 */
export function CustomerTermsForm({ party, priceLists, canSave }: { party: LookupSource; priceLists: readonly CodeOption[]; canSave: boolean }) {
  const tc = useTranslations("sales.customer_terms_page");
  const ts = useTranslations("sales.settings_page");
  const router = useRouter();
  const [customer, setCustomer] = useState<{ id: string; label: string } | null>(null);
  const boxes: SettingsBox[] = [
    { key: "priceListId", label: tc("price_list"), kind: "select", nullable: true, options: priceLists, value: "" },
    { key: "discountPct", label: tc("discount_pct"), kind: "percent", value: "" },
    { key: "creditLimit", label: tc("credit_limit"), hint: tc("credit_limit_hint"), kind: "money", nullable: true, value: "" },
    { key: "notes", label: tc("notes"), kind: "text", value: "" },
  ];
  const [values, setValues] = useState<Record<string, string>>({});
  const save = useSave("customer_terms", () => router.refresh());
  const { input, bad } = inputOf(boxes, values);
  const id = useId();
  return (
    <div className="erp-form">
      <section className="erp-sec">
        <h3>{tc("form_title")}</h3>
        <p className="erp-small erp-muted">{tc("form_hint")}</p>
        <div className="erp-form2">
          <div className="erp-field erp-span3">
            <label htmlFor={id}>{tc("customer")}</label>
            <EntityLookup
              id={id}
              aria-label={tc("customer")}
              entityLabel={party.entityLabel}
              fetcher={gridFetcher("core.party")}
              fields={party.fields}
              baseFilters={[{ field: "kind", op: "eq", value: "customer" }]}
              disabled={!canSave || save.busy}
              value={customer}
              href={party.linkable && customer ? recordHref("core.party", customer.id) : null}
              describe={(row) => ({ label: String(row.legal_name ?? row.id), sub: String(row.document_number ?? "") })}
              onPick={(row) => (save.clear(), setCustomer(row ? { id: row.id, label: String(row.legal_name ?? row.id) } : null))}
            />
          </div>
          {boxes.map((box) => (
            <Box key={box.key} box={box} value={values[box.key] ?? ""} disabled={!canSave || save.busy || !customer} onChange={(v) => (save.clear(), setValues((s) => ({ ...s, [box.key]: v })))} />
          ))}
        </div>
      </section>
      {bad.length > 0 && <p className="erp-small erp-field__error">{ts("bad_number", { fields: bad.join(", ") })}</p>}
      {save.message && (
        <div className={save.message.ok ? "erp-dian erp-dian--ok" : "erp-dian erp-dian--bad"} role={save.message.ok ? "status" : "alert"}>
          {save.message.text}
        </div>
      )}
      {canSave && (
        <div className="erp-form__actions">
          {save.stepUp && <StepUpPrompt onConfirm={(code) => void save.confirm(code, ts("saved"))} onCancel={save.cancel} error={save.stepUpError} busy={save.busy} />}
          <div className="erp-row">
            <span className="erp-grow" />
            <button type="button" className="erp-btn erp-btn--primary" disabled={!customer || save.busy || save.stepUp || bad.length > 0} onClick={() => customer && void save.run({ ...input, partyId: customer.id }, ts("saved"))}>
              {ts("save")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function useSave(kind: string, onSaved: () => void) {
  const te = useTranslations("errors");
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<Record<string, unknown> | null>(null);
  const [stepUpError, setStepUpError] = useState<string | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const run = async (input: Record<string, unknown>, okText: string, token?: string) => {
    setBusy(true);
    try {
      const outcome = await saveSalesSettingsAction(kind, input, token);
      if (outcome.ok) {
        setPending(null);
        setMessage({ ok: true, text: okText });
        onSaved();
      } else if (outcome.code === "step_up_required") setPending(input);
      else {
        setPending(null);
        setMessage({ ok: false, text: outcome.messages.length > 0 ? outcome.messages.join(" · ") : te.has(outcome.code) ? te(outcome.code) : te("unknown") });
      }
    } finally {
      setBusy(false);
    }
  };
  return {
    busy,
    message,
    stepUp: pending !== null,
    stepUpError,
    run,
    async confirm(code: string, okText: string) {
      if (!pending) return;
      setStepUpError(null);
      const answer = await requestStepUp(code);
      if ("error" in answer) setStepUpError(answer.error);
      else await run(pending, okText, answer.token);
    },
    cancel: () => setPending(null),
    clear: () => setMessage(null),
  };
}
