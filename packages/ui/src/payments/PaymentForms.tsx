"use client";

import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { useRecordBridge } from "../record/record-bridge";
import { RecordForm, SAVE_SHORTCUTS, Section, SelectField, TextField, Field, failureMessages, useErrorText } from "../forms/form-parts";
import { ProcessId } from "../forms/ProcessId";
import type { CodeOption, RequestStepUp, SaveRecord } from "../forms/save-model";
import { StepUpPrompt } from "../forms/StepUpPrompt";
import { useSaveFlow } from "../forms/use-save";
import { gridFetcher } from "../grid/fetch-grid";
import type { GridRow } from "../grid/types";
import { EntityLookup } from "../lookup/EntityLookup";
import { formatMoney } from "../money/format";
import { recordHref } from "../record/record-model";
import type { LookupSource } from "../inventory/StockForms";
import {
  addWithholding,
  receiptDraft,
  receiptInput,
  receiptMissing,
  receiptTotals,
  removeWithholding,
  setApplied,
  setWithholding,
  type ReceiptDraft,
  type WithholdingKindDraft,
} from "./receipt-form-model";

// The Datos tab of the payments records (plan 2B Task 24b, prototype 2B «Recibos de caja»): the medio de pago and the caja (maestros saved
// through their create and update processes, the record bar's Guardar) and «Registrar pago», the new recibo de caja: the customer (a lookup
// that shows who is not ready to invoice and why, rule 10), the medio de pago and, for cash, the caja, the date (today or earlier), the money
// received, the customer's open invoices (only the ones the DIAN accepted take an amount: the others say why), what to apply to each with
// the withholdings the customer practised (kind, code, rate, base, value = base × rate) and the live totals: cash applied, withholdings and
// the advance (what is not applied). It saves through payments.payment.receive (the entity's create process) with one idempotency key per
// form: the receipt is numbered and posted in that same action.

const METHOD_KINDS = ["cash", "transfer", "card", "check", "other"] as const;
const WITHHOLDING_KINDS = ["income", "vat", "ica"] as const;

export interface PaymentMasterFormProps {
  kind: "method" | "cash_box";
  record: (Record<string, unknown> & { id: string }) | null;
  initial?: Readonly<Record<string, unknown>> | null;
  readOnly?: boolean;
  /** The DIAN payment means of the country pack, named (a method's «Código DIAN»). */
  meansCodes?: readonly CodeOption[];
  processes: { create: string; update: string };
  save: SaveRecord;
  requestStepUp?: RequestStepUp;
  onSaved?: (id: string, created: boolean) => void;
}

interface MasterDraft {
  code: string;
  name: string;
  kind: string;
  meansCode: string;
  description: string;
  isActive: boolean;
}

function masterDraft(source: Readonly<Record<string, unknown>> | null): MasterDraft {
  const s = (v: unknown) => (typeof v === "string" ? v : "");
  return { code: s(source?.code), name: s(source?.name), kind: s(source?.kind) || "transfer", meansCode: s(source?.means_code), description: s(source?.description), isActive: source?.is_active !== false };
}

export function PaymentMasterForm({ kind, record, initial: copy, readOnly = false, meansCodes = [], processes, save, requestStepUp, onSaved }: PaymentMasterFormProps) {
  const t = useTranslations("payments.form");
  const tv = useTranslations("payments.values");
  const tf = useTranslations("common.forms");
  const tc = useTranslations("common");
  const errorText = useErrorText();
  const bridge = useRecordBridge();
  const isNew = record === null;
  const recordKey = record ? `${record.id}:${String(record.updated_at ?? "")}` : "new";
  const [seen, setSeen] = useState(recordKey);
  const [initial, setInitial] = useState(() => masterDraft(record ?? copy ?? null));
  const [draft, setDraft] = useState(initial);
  if (seen !== recordKey) {
    const next = masterDraft(record ?? copy ?? null);
    setSeen(recordKey);
    setInitial(next);
    setDraft(next);
  }
  const flow = useSaveFlow(save, requestStepUp, (id) => onSaved?.(id, isNew));
  const failed = failureMessages(flow.failure, ["code", "name", "kind", "meansCode", "description"], errorText);
  const missing = draft.code.trim() === "" || draft.name.trim() === "";
  const dirty = JSON.stringify(draft) !== JSON.stringify(initial);
  const input = (): Record<string, unknown> => {
    const common = { code: draft.code.trim(), name: draft.name.trim(), isActive: draft.isActive };
    if (kind === "cash_box") return { ...(record ? { id: record.id } : {}), ...common, ...(draft.description.trim() ? { description: draft.description.trim() } : {}) };
    const means = draft.meansCode ? { meansCode: draft.meansCode } : record ? { meansCode: null } : {};
    return { ...(record ? { id: record.id } : {}), ...common, kind: draft.kind, ...means };
  };
  const send = () => flow.submit(input());
  const submit = () => void send();
  const set = <K extends keyof MasterDraft>(key: K) => (value: MasterDraft[K]) => setDraft((d) => ({ ...d, [key]: value }));
  return (
    <RecordForm canSave={!readOnly && !missing && !flow.saving && !flow.stepUp && (dirty || isNew)} onSave={submit} dirty={dirty} save={async () => (await send())?.ok === true} failure={flow.failure} {...(isNew ? {} : { onDiscard: () => setDraft(initial) })}>
      <Section title={t(`section.${kind}`)}>
        <div className="erp-form2">
          <TextField label={`${t("code")} *`} value={draft.code} mono maxLength={20} disabled={readOnly} error={failed.field("code")} onChange={set("code")} />
          <TextField label={`${t("name")} *`} value={draft.name} maxLength={120} disabled={readOnly} error={failed.field("name")} onChange={set("name")} />
          {kind === "method" && (
            <>
              <SelectField label={`${t("kind")} *`} value={draft.kind} options={METHOD_KINDS.map((k) => ({ code: k, name: tv(`method_kind.${k}`) }))} showCode={false} disabled={readOnly} error={failed.field("kind")} onChange={set("kind")} />
              <SelectField label={t("means_code")} hint={t("means_code_hint")} value={draft.meansCode} options={meansCodes.map((m) => ({ code: m.code, name: `${m.code} · ${m.name}` }))} showCode={false} empty="—" disabled={readOnly} error={failed.field("meansCode")} onChange={set("meansCode")} />
            </>
          )}
          {kind === "cash_box" && <TextField label={t("description")} value={draft.description} maxLength={300} disabled={readOnly} error={failed.field("description")} onChange={set("description")} />}
        </div>
        <div className="erp-flags" role="group" aria-label={t(`section.${kind}`)}>
          <button type="button" role="switch" aria-checked={draft.isActive} disabled={readOnly} className={draft.isActive ? "erp-flag is-on" : "erp-flag"} onClick={() => !readOnly && set("isActive")(!draft.isActive)}>
            <i aria-hidden="true" className="erp-flag__dot" />
            {t("active")} <span className="erp-flag__state">{draft.isActive ? tc("yes") : tc("no")}</span>
          </button>
        </div>
        {kind === "method" && <p className="erp-small erp-muted">{t("kind_hint")}</p>}
      </Section>
      {failed.panel.length > 0 && (
        <div className="erp-dian erp-dian--bad" role="alert" tabIndex={-1} data-error-summary="">
          <b>{failed.panel.join(" · ")}</b>
        </div>
      )}
      {!readOnly && (
        <div className="erp-form__actions">
          {flow.stepUp && <StepUpPrompt onConfirm={(code) => void flow.confirmStepUp(code)} onCancel={flow.cancelStepUp} error={flow.stepUpError} busy={flow.saving} />}
          <div className="erp-row">
            <span className="erp-small erp-muted erp-grow" role="status">
              {flow.saving ? tf("saving") : missing ? t("missing_master") : ""} <kbd className="erp-mono">{tf("save_hint")}</kbd> · <ProcessId id={isNew ? processes.create : processes.update} />
            </span>
            {/* In a record frame its header carries «Descartar cambios» (owner 2026-11-05). */}
            {dirty && !isNew && !bridge?.registered && (
              <button type="button" className="erp-btn" onClick={() => setDraft(initial)} disabled={flow.saving}>
                {tf("discard")}
              </button>
            )}
            {!bridge?.registered && (
              <button type="button" className="erp-btn erp-btn--primary" aria-keyshortcuts={SAVE_SHORTCUTS} onClick={submit} disabled={missing || flow.saving || flow.stepUp || (!dirty && !isNew)}>
                {isNew ? tf("create") : tc("save")}
              </button>
            )}
          </div>
        </div>
      )}
    </RecordForm>
  );
}

/** A medio de pago as «Registrar pago» offers it: its kind says whether a caja goes with it. */
export interface MethodOption {
  id: string;
  name: string;
  kind: string;
}

/** An open invoice of the customer (payments.payment.open_invoices). */
export interface OpenInvoice {
  id: string;
  number: string | null;
  issueDate: string;
  dueDate: string | null;
  currency: string;
  total: number;
  open: number;
  payable: boolean;
  reasonCode: string | null;
  reason: string | null;
}

export type LoadOpenInvoices = (partyId: string, date: string) => Promise<{ ok: true; invoices: OpenInvoice[] } | { ok: false; code: string; messages: string[] }>;

export interface ReceiptFormProps {
  /** Today in the company's time zone (the default date, and the latest a receipt may have). */
  today: string;
  methods: readonly MethodOption[];
  /** The cajas, as `code · name`, by id. */
  cashBoxes: readonly CodeOption[];
  party: LookupSource;
  /** The caller may open invoices (rule 21): each invoice links to its page. */
  invoicesLinkable?: boolean;
  /** A copy («Duplicar»): the customer, the method and the caja. */
  initial?: Readonly<Record<string, unknown>> | null;
  /** How the copy's references read (`party_id`). */
  labels?: Readonly<Record<string, string>>;
  readOnly?: boolean;
  loadInvoices: LoadOpenInvoices;
  /** The entity's create process (payments.payment.receive), shown under the form. */
  process: string;
  save: SaveRecord;
  requestStepUp?: RequestStepUp;
  onSaved?: (id: string, created: boolean) => void;
}

const partyRow = (row: GridRow) => ({ label: String(row.legal_name ?? row.id), sub: [row.document_number, row.municipality_code].filter(Boolean).join(" · ") });
const day = (iso: string | null) => (iso ? iso.slice(0, 10).replaceAll("-", "/") : "—");

export function ReceiptForm({ today, methods, cashBoxes, party, invoicesLinkable = false, initial: copy, labels = {}, readOnly = false, loadInvoices, process, save, requestStepUp, onSaved }: ReceiptFormProps) {
  const t = useTranslations("payments.form");
  const tv = useTranslations("payments.values");
  const errorText = useErrorText();
  const [draft, setDraft] = useState<ReceiptDraft>(() => receiptDraft(today, copy ?? null, labels));
  // One «Registrar pago» per form: a retry (a double click, a lost answer) answers the first receipt (kernel idempotency).
  const [key] = useState(() => crypto.randomUUID());
  const [invoices, setInvoices] = useState<OpenInvoice[] | null>(null);
  const [loadFailure, setLoadFailure] = useState<string | null>(null);
  const flow = useSaveFlow(save, requestStepUp, (id) => onSaved?.(id, true));
  const failed = failureMessages(flow.failure, ["partyId", "methodId", "cashBoxId", "date", "amount", "reference", "notes"], errorText);
  const errorTextRef = useRef(errorText);
  useEffect(() => {
    errorTextRef.current = errorText;
  });

  // The customer's open invoices, read again when the customer or the date changes (the date decides «posterior al recibo»).
  const { partyId, date } = draft;
  useEffect(() => {
    if (!partyId) return;
    let live = true;
    void loadInvoices(partyId, date).then((answer) => {
      if (!live) return;
      if (answer.ok) {
        setInvoices(answer.invoices);
        setLoadFailure(null);
      } else {
        setInvoices([]);
        setLoadFailure(answer.messages.length > 0 ? answer.messages.join(" · ") : errorTextRef.current(answer.code));
      }
    });
    return () => {
      live = false;
    };
  }, [partyId, date, loadInvoices]);

  const rows = partyId ? (invoices ?? []) : [];
  const method = methods.find((m) => m.id === draft.methodId) ?? null;
  const totals = receiptTotals(draft, rows);
  const missing = receiptMissing(draft, rows);
  const dirty = draft.partyId !== "" || draft.amount !== "" || Object.keys(draft.allocations).length > 0;
  const send = () => flow.submit(receiptInput(draft, rows, key));
  const submit = () => void send();
  const canSave = !readOnly && missing.length === 0 && !flow.saving && !flow.stepUp;
  const set = <K extends keyof ReceiptDraft>(name: K) => (value: ReceiptDraft[K]) => setDraft((d) => ({ ...d, [name]: value }));
  const name = (inv: OpenInvoice) => inv.number ?? inv.id.slice(0, 8);

  return (
    <RecordForm canSave={canSave} onSave={submit} dirty={dirty} save={async () => (await send())?.ok === true} failure={flow.failure}>
      <Section title={t("section.receipt")}>
        <div className="erp-form2">
          <Field label={`${t("customer")} *`} hint={t("customer_hint")} error={failed.field("partyId")} className="erp-span3">
            {(id) => (
              <EntityLookup
                id={id}
                aria-label={t("customer")}
                entityLabel={party.entityLabel}
                fetcher={gridFetcher("core.party")}
                fields={party.fields}
                baseFilters={[{ field: "kind", op: "eq", value: "customer" }]}
                forInvoice
                disabled={readOnly}
                value={draft.partyId ? { id: draft.partyId, label: draft.partyLabel } : null}
                href={party.linkable && draft.partyId ? recordHref("core.party", draft.partyId) : null}
                describe={partyRow}
                onPick={(row) => {
                  setInvoices(null);
                  setDraft((d) => ({ ...d, partyId: row?.id ?? "", partyLabel: row ? String(row.legal_name ?? row.id) : "", allocations: {} }));
                }}
              />
            )}
          </Field>
          <SelectField
            label={`${t("method")} *`}
            value={draft.methodId}
            options={methods.map((m) => ({ code: m.id, name: m.name }))}
            showCode={false}
            empty="—"
            disabled={readOnly}
            error={failed.field("methodId")}
            onChange={(v) => setDraft((d) => ({ ...d, methodId: v, cashBoxId: methods.find((m) => m.id === v)?.kind === "cash" ? d.cashBoxId : "" }))}
          />
          {method?.kind === "cash" && (
            <SelectField label={t("cash_box")} hint={t("cash_box_hint")} value={draft.cashBoxId} options={cashBoxes} showCode={false} empty="—" disabled={readOnly} error={failed.field("cashBoxId")} onChange={set("cashBoxId")} />
          )}
          <Field label={`${t("date")} *`} hint={t("date_hint")} error={failed.field("date")}>
            {(id) => <input id={id} type="date" value={draft.date} max={today} disabled={readOnly} onChange={(e) => set("date")(e.target.value || today)} />}
          </Field>
          <TextField label={`${t("amount")} *`} value={draft.amount} inputMode="decimal" mono disabled={readOnly} error={failed.field("amount")} onChange={set("amount")} />
          <TextField label={t("reference")} hint={t("reference_hint")} value={draft.reference} maxLength={100} disabled={readOnly} error={failed.field("reference")} onChange={set("reference")} />
          <TextField label={t("notes")} value={draft.notes} maxLength={2000} disabled={readOnly} error={failed.field("notes")} onChange={set("notes")} className="erp-span3" />
        </div>
      </Section>

      <Section title={t("invoices")}>
        {!draft.partyId ? (
          <p className="erp-small erp-muted">{t("invoices_pick_customer")}</p>
        ) : invoices === null ? (
          <p className="erp-small erp-muted" role="status">
            {t("invoices_loading")}
          </p>
        ) : (
          <>
            {loadFailure && (
              <div className="erp-dian erp-dian--bad" role="alert">
                {loadFailure}
              </div>
            )}
            {rows.length === 0 ? (
              <p className="erp-small erp-muted">{t("invoices_none")}</p>
            ) : (
              <div className="erp-lines__scroll">
                <table className="erp-lines__table" aria-label={t("invoices")}>
                  <thead>
                    <tr>
                      <th scope="col">{t("invoice")}</th>
                      <th scope="col">{t("issue_date")}</th>
                      <th scope="col">{t("due_date")}</th>
                      <th scope="col" className="erp-num">
                        {t("open")}
                      </th>
                      <th scope="col" className="erp-num">
                        {t("apply")}
                      </th>
                      <th scope="col">{t("withholdings")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((inv) => {
                      const a = draft.allocations[inv.id];
                      const over = totals.over.includes(inv.id);
                      return (
                        <tr key={inv.id}>
                          <td className="erp-mono">{invoicesLinkable ? <a href={recordHref("invoicing.invoice", inv.id)}>{name(inv)}</a> : name(inv)}</td>
                          <td className="erp-mono">{day(inv.issueDate)}</td>
                          <td className="erp-mono">{day(inv.dueDate)}</td>
                          <td className="erp-num erp-mono">{formatMoney(inv.open, inv.currency)}</td>
                          {inv.payable ? (
                            <>
                              <td className="erp-num">
                                <span className="erp-row">
                                  <input
                                    aria-label={t("apply_to", { invoice: name(inv) })}
                                    className={over ? "erp-num erp-mono erp-input--bad" : "erp-num erp-mono"}
                                    inputMode="decimal"
                                    value={a?.amount ?? ""}
                                    disabled={readOnly}
                                    aria-invalid={over ? true : undefined}
                                    onChange={(e) => setDraft((d) => setApplied(d, inv.id, e.target.value))}
                                  />
                                  <button type="button" className="erp-btn erp-btn--sm" disabled={readOnly} title={t("apply_open_hint")} onClick={() => setDraft((d) => setApplied(d, inv.id, String(inv.open).replace(".", ",")))}>
                                    {t("apply_open")}
                                  </button>
                                </span>
                                {over && <span className="erp-field__error">{t("over_open", { open: formatMoney(inv.open, inv.currency) })}</span>}
                              </td>
                              <td>
                                <button type="button" className="erp-btn erp-btn--sm" aria-label={t("add_withholding_to", { invoice: name(inv) })} disabled={readOnly} onClick={() => setDraft((d) => addWithholding(d, inv.id))}>
                                  {t("add_withholding")}
                                </button>
                              </td>
                            </>
                          ) : (
                            <td colSpan={2} className="erp-small">
                              <span className="erp-pill erp-pill--warn">{t("not_payable")}</span> {inv.reason}
                            </td>
                          )}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
            {rows
              .filter((inv) => inv.payable && (draft.allocations[inv.id]?.withholdings.length ?? 0) > 0)
              .flatMap((inv) =>
                draft.allocations[inv.id]!.withholdings.map((w, i) => (
                  <fieldset key={w.key} className="erp-field erp-withholding" aria-label={t("withholding_of", { n: i + 1, invoice: name(inv) })}>
                    <legend>{t("withholding_of", { n: i + 1, invoice: name(inv) })}</legend>
                    <div className="erp-form2">
                      <label className="erp-field">
                        <span>{t("w_kind")}</span>
                        <select value={w.kind} disabled={readOnly} onChange={(e) => setDraft((d) => setWithholding(d, inv.id, i, { kind: e.target.value as WithholdingKindDraft }))}>
                          {WITHHOLDING_KINDS.map((k) => (
                            <option key={k} value={k}>
                              {tv(`withholding_kind.${k}`)}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className="erp-field">
                        <span>{t("w_code")}</span>
                        <input className="erp-mono" value={w.code} maxLength={40} disabled={readOnly} onChange={(e) => setDraft((d) => setWithholding(d, inv.id, i, { code: e.target.value }))} />
                      </label>
                      <label className="erp-field">
                        <span>{t("w_rate")}</span>
                        <input className="erp-num erp-mono" inputMode="decimal" value={w.rate} disabled={readOnly} onChange={(e) => setDraft((d) => setWithholding(d, inv.id, i, { rate: e.target.value }))} />
                      </label>
                      <label className="erp-field">
                        <span>{t("w_base")}</span>
                        <input className="erp-num erp-mono" inputMode="decimal" value={w.base} disabled={readOnly} onChange={(e) => setDraft((d) => setWithholding(d, inv.id, i, { base: e.target.value }))} />
                      </label>
                      <label className="erp-field">
                        <span>{t("w_amount")}</span>
                        <input className="erp-num erp-mono" inputMode="decimal" value={w.amount} disabled={readOnly} onChange={(e) => setDraft((d) => setWithholding(d, inv.id, i, { amount: e.target.value }))} />
                      </label>
                    </div>
                    <p className="erp-small erp-muted">
                      {t("w_hint")}{" "}
                      <button type="button" className="erp-btn erp-btn--sm" disabled={readOnly} onClick={() => setDraft((d) => removeWithholding(d, inv.id, i))}>
                        {t("w_remove")}
                      </button>
                    </p>
                  </fieldset>
                )),
              )}
          </>
        )}
      </Section>

      <Section title={t("totals")}>
        <dl className="erp-totals">
          <div>
            <dt>{t("total_applied")}</dt>
            <dd className="erp-num erp-mono" data-testid="payment-applied">
              {formatMoney(totals.applied)}
            </dd>
          </div>
          <div>
            <dt>{t("total_withholdings")}</dt>
            <dd className="erp-num erp-mono" data-testid="payment-withholdings">
              {formatMoney(totals.withholdings)}
            </dd>
          </div>
          <div>
            <dt>{t("total_cash")}</dt>
            <dd className="erp-num erp-mono" data-testid="payment-cash">
              {formatMoney(totals.cash)}
            </dd>
          </div>
          <div>
            <dt>
              <b>{t("total_advance")}</b>
            </dt>
            <dd className="erp-num erp-mono" data-testid="payment-advance">
              <b>{formatMoney(totals.advance)}</b>
            </dd>
          </div>
        </dl>
        {totals.short && <div className="erp-dian erp-dian--warn">{t("cash_short", { received: formatMoney(totals.received), cash: formatMoney(totals.cash) })}</div>}
        {!totals.short && totals.advance > 0 && <div className="erp-dian erp-dian--info">{t("advance_note", { advance: formatMoney(totals.advance) })}</div>}
      </Section>

      {(failed.panel.length > 0 || flow.failure) && (
        <div className="erp-dian erp-dian--bad" role="alert" tabIndex={-1} data-error-summary="">
          <b>{failed.panel.length > 0 ? failed.panel.join(" · ") : errorText(flow.failure!.code)}</b>
        </div>
      )}
      {!readOnly && (
        <div className="erp-form__actions">
          {flow.stepUp && <StepUpPrompt onConfirm={(code) => void flow.confirmStepUp(code)} onCancel={flow.cancelStepUp} error={flow.stepUpError} busy={flow.saving} />}
          <div className="erp-row">
            <span className="erp-small erp-muted erp-grow" role="status">
              {flow.saving ? t("receiving") : missing.length > 0 ? `${t("missing")}: ${missing.map((m) => t(`missing_field.${m}`)).join(", ")}` : t("receive_hint")} · <ProcessId id={process} />
            </span>
            <button type="button" className="erp-btn erp-btn--primary" aria-keyshortcuts={SAVE_SHORTCUTS} onClick={submit} disabled={!canSave}>
              {t("receive")}
            </button>
          </div>
        </div>
      )}
    </RecordForm>
  );
}
