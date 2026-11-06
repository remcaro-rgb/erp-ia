"use client";

import { useId, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { convertDraft, convertInput, DataGrid, Pill, RecordLink, StepUpPrompt, useTabs, type CodeOption, type ConvertDraft } from "@erp/ui";
import { useStepRunner } from "@/lib/records/use-step-runner";
import { runSalesStepAction } from "@/lib/sales/actions";
import type { SalesView } from "@/lib/sales/record";

// The Datos tab of a stored cotización, pedido, entrega, devolución, oportunidad or actividad, and the header of a prospecto (plan 2B
// Task 14b, prototype 2B): its facts (references link to their records, rule 21), its commercial stage, its totals in the money format
// (rule 23), its lines in the universal grid (rule 20), the documents that came from it, and the steps of its process the caller may run
// now: Enviar al cliente, Aceptar cotización, Marcar vencida and Crear pedido (a cotización); Confirmar pedido, Crear entrega and Cancelar
// pedido (a pedido); Despachar and Crear devolución (an entrega); Recibir (a devolución); Convertir en cliente (a prospecto); Mover de
// etapa (an oportunidad). Grabar, Aprobar, No aprobar and Anular are the bar's. A refusal shows the process's reasons (the readiness gate
// names what the customer or the product lacks, rule 10); a sensitive step asks for the code (rule 15).

function Section({ title, extra, children }: { title: string; extra?: ReactNode; children: ReactNode }) {
  return (
    <section className="erp-sec">
      <h3>
        {title}
        {extra && <> {extra}</>}
      </h3>
      {children}
    </section>
  );
}

/** A labelled box of a step (the label names the control: getByLabel, screen readers). */
function Labelled({ label, children }: { label: string; children: (id: string) => ReactNode }) {
  const id = useId();
  return (
    <div className="erp-field">
      <label htmlFor={id}>{label}</label>
      {children(id)}
    </div>
  );
}

const STAGE_TONE: Record<string, "ok" | "warn" | "danger" | "info" | "gray"> = {
  open: "info",
  sent: "warn",
  accepted: "ok",
  expired: "gray",
  confirmed: "ok",
  partially_delivered: "warn",
  delivered: "ok",
  cancelled: "gray",
  shipped: "ok",
  received: "ok",
  new: "info",
  contacted: "warn",
  qualified: "ok",
  converted: "ok",
  discarded: "gray",
  won: "ok",
  lost: "danger",
};

/** The testid of a record's stage pill. */
const STAGE_ID: Record<string, string> = {
  "crm.quote": "quote-stage",
  "sales.order": "order-stage",
  "sales.delivery": "delivery-stage",
  "sales.return": "return-stage",
  "crm.lead": "lead-stage",
  "crm.opportunity": "opportunity-outcome",
};

export interface SalesRecordViewProps {
  entity: string;
  recordId: string;
  view: SalesView;
  /** A pedido's bodegas (Crear pedido picks one). */
  warehouses?: readonly CodeOption[];
  /** The form a stored cotización or pedido still open edits with (Editar shows it in place of the facts). */
  editForm?: ReactNode;
  /** A prospecto: its form (hidden while it converts), its document types and the record the conversion starts from. */
  lead?: { form: ReactNode; record: Record<string, unknown>; documentTypes: readonly CodeOption[] } | null;
}

export function SalesRecordView({ entity, recordId, view, warehouses = [], editForm, lead }: SalesRecordViewProps) {
  const t = useTranslations("sales.view");
  const te = useTranslations("errors");
  const router = useRouter();
  const openTab = useTabs((s) => s.open);
  const [editing, setEditing] = useState(false);
  const [converting, setConverting] = useState(false);
  const step = useStepRunner((step: string, input, token) => runSalesStepAction(entity, step, recordId, input, token), (outcome) => {
    if (outcome.created) {
      // The document the step created opens in its own tab (Crear pedido, Crear entrega, Crear devolución).
      const href = `/r/${outcome.created.entity}/${outcome.created.id}`;
      openTab({ title: outcome.created.number ?? t(`created.${outcome.created.entity.slice(outcome.created.entity.indexOf(".") + 1)}`), href, kind: "record" });
      router.push(href);
    } else {
      setConverting(false);
      router.refresh();
    }
  }, { clickKey: true });
  const [orderWarehouse, setOrderWarehouse] = useState(warehouses[0]?.code ?? "");
  const [returnReason, setReturnReason] = useState("");
  const [cancelReason, setCancelReason] = useState("");
  const [stageId, setStageId] = useState(view.stageId ?? "");
  const [lostReason, setLostReason] = useState("");
  const has = (s: string) => view.steps.includes(s);
  const failureText = step.failure ? (step.failure.messages.length > 0 ? step.failure.messages.join(" · ") : te.has(step.failure.code) ? te(step.failure.code) : te("unknown")) : null;
  const stagePill = view.stage ? (
    <span data-testid={STAGE_ID[entity]}>
      <Pill tone={STAGE_TONE[view.stage] ?? "gray"}>{view.stageLabel ?? view.stage}</Pill>
    </span>
  ) : undefined;
  const targetStage = view.stages.find((s) => s.code === stageId);

  if (editing && editForm) {
    return (
      <div className="erp-form">
        <div className="erp-row">
          <span className="erp-grow" />
          <button type="button" className="erp-btn" onClick={() => setEditing(false)}>
            {t("stop_editing")}
          </button>
        </div>
        {editForm}
      </div>
    );
  }

  return (
    <div className="erp-form">
      <Section
        title={t("facts")}
        extra={
          <>
            {stagePill}
            {editForm && (
              <button type="button" className="erp-btn erp-btn--ghost" onClick={() => setEditing(true)}>
                {t("edit")}
              </button>
            )}
          </>
        }
      >
        <div className="erp-form2">
          {view.facts.map((f) => (
            <div key={f.label} className="erp-field" {...(f.testId ? { "data-testid": f.testId } : {})}>
              <span className="erp-field__label">{f.label}</span>
              {f.link ? <RecordLink entity={f.link.entity} id={f.link.id} label={f.value} {...(f.mono ? { mono: true } : {})} /> : <span className={f.mono ? "erp-mono" : undefined}>{f.value}</span>}
            </div>
          ))}
          {view.related && (
            <div className="erp-field">
              <span className="erp-field__label">{view.related.label}</span>
              <span className="erp-row">
                {view.related.items.map((r) => (
                  <RecordLink key={r.id} entity={r.entity} id={r.id} label={r.number} mono />
                ))}
              </span>
            </div>
          )}
        </div>
      </Section>

      {view.totals && (
        <Section title={t("totals")}>
          <dl className="erp-totals">
            <div>
              <dt>{t("subtotal")}</dt>
              <dd className="erp-num erp-mono">{view.totals.subtotal}</dd>
            </div>
            <div>
              <dt>{t("discount")}</dt>
              <dd className="erp-num erp-mono">{view.totals.discount}</dd>
            </div>
            <div>
              <dt>{t("taxes")}</dt>
              <dd className="erp-num erp-mono">{view.totals.tax}</dd>
            </div>
            <div>
              <dt>
                <b>{t("total")}</b>
              </dt>
              <dd className="erp-num erp-mono" data-testid="sales-total">
                <b>{view.totals.total}</b>
              </dd>
            </div>
          </dl>
        </Section>
      )}

      {view.linesGrid && (
        <DataGrid entity={view.linesGrid.entity} title={view.linesGrid.title} columns={view.linesGrid.columns} baseFilters={view.linesGrid.filters} initialState={{ sort: [{ field: "line_no", dir: "asc" }] }} />
      )}

      {lead && converting && <ConvertPanel record={lead.record} documentTypes={lead.documentTypes} busy={step.busy} onCancel={() => setConverting(false)} onConvert={(draft) => step.run("convert", convertInput(recordId, draft))} />}
      {lead && !converting && lead.form}

      {failureText && (
        <div className="erp-dian erp-dian--bad" role="alert">
          <b>{failureText}</b>
        </div>
      )}
      {step.stepUp && <StepUpPrompt onConfirm={(code) => void step.confirm(code)} onCancel={step.cancel} error={step.stepUpError} busy={step.busy} />}
      {view.steps.length > 0 && !converting && (
        <div className="erp-form__actions">
          {has("to_order") && (
            <div className="erp-form2">
              <Labelled label={t("order_warehouse")}>
                {(id) => (
                  <select id={id} value={orderWarehouse} onChange={(e) => setOrderWarehouse(e.target.value)}>
                    <option value="">—</option>
                    {warehouses.map((w) => (
                      <option key={w.code} value={w.code}>
                        {w.name}
                      </option>
                    ))}
                  </select>
                )}
              </Labelled>
            </div>
          )}
          {has("to_return") && (
            <div className="erp-form2">
              <Labelled label={t("return_reason")}>{(id) => <input id={id} value={returnReason} maxLength={500} onChange={(e) => setReturnReason(e.target.value)} />}</Labelled>
            </div>
          )}
          {has("cancel") && (
            <div className="erp-form2">
              <Labelled label={t("cancel_reason")}>{(id) => <input id={id} value={cancelReason} maxLength={500} onChange={(e) => setCancelReason(e.target.value)} />}</Labelled>
            </div>
          )}
          {has("stage_move") && (
            <div className="erp-form2">
              <Labelled label={t("stage")}>
                {(id) => (
                  <select id={id} value={stageId} onChange={(e) => setStageId(e.target.value)}>
                    {view.stages.map((s) => (
                      <option key={s.code} value={s.code}>
                        {s.name}
                      </option>
                    ))}
                  </select>
                )}
              </Labelled>
              {targetStage?.kind === "lost" && <Labelled label={t("lost_reason")}>{(id) => <input id={id} value={lostReason} maxLength={500} onChange={(e) => setLostReason(e.target.value)} />}</Labelled>}
            </div>
          )}
          <div className="erp-row">
            <span className="erp-small erp-muted erp-grow" role="status">
              {step.busy ? t("working") : ""}
            </span>
            {has("send") && (
              <button type="button" className="erp-btn" disabled={step.busy} onClick={() => step.run("send")}>
                {t("send")}
              </button>
            )}
            {has("accept") && (
              <button type="button" className="erp-btn erp-btn--primary" disabled={step.busy} onClick={() => step.run("accept")}>
                {t("accept")}
              </button>
            )}
            {has("expire") && (
              <button type="button" className="erp-btn" disabled={step.busy} onClick={() => step.run("expire")}>
                {t("expire")}
              </button>
            )}
            {has("to_order") && (
              <button type="button" className="erp-btn erp-btn--primary" disabled={step.busy} onClick={() => step.run("to_order", orderWarehouse ? { warehouseId: orderWarehouse } : {})}>
                {t("to_order")}
              </button>
            )}
            {has("confirm") && (
              <button type="button" className="erp-btn erp-btn--primary" disabled={step.busy} onClick={() => step.run("confirm")}>
                {t("confirm")}
              </button>
            )}
            {has("cancel") && (
              <button type="button" className="erp-btn" disabled={step.busy || cancelReason.trim() === ""} onClick={() => step.run("cancel", { reason: cancelReason })}>
                {t("cancel")}
              </button>
            )}
            {has("to_delivery") && (
              <button type="button" className="erp-btn erp-btn--primary" disabled={step.busy} onClick={() => step.run("to_delivery")}>
                {t("to_delivery")}
              </button>
            )}
            {has("ship") && (
              <button type="button" className="erp-btn erp-btn--primary" disabled={step.busy} onClick={() => step.run("ship")}>
                {t("ship")}
              </button>
            )}
            {has("to_return") && (
              <button type="button" className="erp-btn" disabled={step.busy || returnReason.trim() === ""} onClick={() => step.run("to_return", { reason: returnReason })}>
                {t("to_return")}
              </button>
            )}
            {has("receive") && (
              <button type="button" className="erp-btn erp-btn--primary" disabled={step.busy} onClick={() => step.run("receive")}>
                {t("receive")}
              </button>
            )}
            {has("convert") && (
              <button type="button" className="erp-btn erp-btn--primary" disabled={step.busy} onClick={() => setConverting(true)}>
                {t("convert")}
              </button>
            )}
            {has("stage_move") && (
              <button type="button" className="erp-btn erp-btn--primary" disabled={step.busy || !stageId || stageId === view.stageId || (targetStage?.kind === "lost" && lostReason.trim() === "")} onClick={() => step.run("stage_move", { stageId, ...(lostReason.trim() ? { lostReason } : {}) })}>
                {t("stage_move")}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/** Convertir en cliente: the document data the prospecto lacks (a natural person's names) and the oportunidad it opens. */
function ConvertPanel({ record, documentTypes, busy, onCancel, onConvert }: { record: Record<string, unknown>; documentTypes: readonly CodeOption[]; busy: boolean; onCancel: () => void; onConvert: (draft: ConvertDraft) => void }) {
  const tp = useTranslations("sales.view.convert_panel");
  const tf = useTranslations("crm.form");
  const [draft, setDraft] = useState<ConvertDraft>(() => convertDraft({ id: "", ...record }));
  const set = <K extends keyof ConvertDraft>(k: K) => (value: string) => setDraft((d) => ({ ...d, [k]: value }));
  const natural = draft.personType === "2";
  const ready = draft.personType !== "" && draft.documentType !== "" && draft.documentNumber.trim() !== "" && (!natural || (draft.firstName.trim() !== "" && draft.firstSurname.trim() !== ""));
  return (
    <Section title={tp("title")}>
      <p className="erp-small erp-muted">{tp("hint")}</p>
      <div className="erp-form2">
        <Labelled label={tf("person_type")}>
          {(id) => (
            <select id={id} value={draft.personType} onChange={(e) => set("personType")(e.target.value)}>
              <option value="">—</option>
              <option value="1">{tf("person_type_1")}</option>
              <option value="2">{tf("person_type_2")}</option>
            </select>
          )}
        </Labelled>
        <Labelled label={tf("document_type")}>
          {(id) => (
            <select id={id} value={draft.documentType} onChange={(e) => set("documentType")(e.target.value)}>
              <option value="">—</option>
              {documentTypes.map((d) => (
                <option key={d.code} value={d.code}>
                  {d.name}
                </option>
              ))}
            </select>
          )}
        </Labelled>
        <Labelled label={tf("document_number")}>{(id) => <input id={id} className="erp-mono" value={draft.documentNumber} maxLength={20} onChange={(e) => set("documentNumber")(e.target.value)} />}</Labelled>
        {natural && (
          <>
            <Labelled label={tp("first_name")}>{(id) => <input id={id} value={draft.firstName} maxLength={60} onChange={(e) => set("firstName")(e.target.value)} />}</Labelled>
            <Labelled label={tp("first_surname")}>{(id) => <input id={id} value={draft.firstSurname} maxLength={60} onChange={(e) => set("firstSurname")(e.target.value)} />}</Labelled>
          </>
        )}
        <Labelled label={tp("opportunity_title")}>{(id) => <input id={id} value={draft.opportunityTitle} maxLength={160} onChange={(e) => set("opportunityTitle")(e.target.value)} />}</Labelled>
        <Labelled label={tp("amount")}>{(id) => <input id={id} className="erp-num erp-mono" inputMode="decimal" value={draft.amount} onChange={(e) => set("amount")(e.target.value)} />}</Labelled>
        <Labelled label={tp("expected_close")}>{(id) => <input id={id} type="date" value={draft.expectedClose} onChange={(e) => set("expectedClose")(e.target.value)} />}</Labelled>
      </div>
      <div className="erp-row">
        <span className="erp-grow" />
        <button type="button" className="erp-btn" disabled={busy} onClick={onCancel}>
          {tp("cancel")}
        </button>
        <button type="button" className="erp-btn erp-btn--primary" disabled={busy || !ready} onClick={() => onConvert(draft)}>
          {tp("convert")}
        </button>
      </div>
    </Section>
  );
}
