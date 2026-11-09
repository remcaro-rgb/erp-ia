"use client";

import { useId, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { noteCopy, noteDraft, noteInput, noteMissing, Pill, RecordLink, StepUpPrompt, useTabs, type NoteDraft, type NoteKind } from "@erp/ui";
import { pendingNote, subscribeNotes, takeNote } from "@/lib/invoicing/note-handoff";
import { runInvoicingStepAction, type InvoicingStepOutcome } from "@/lib/invoicing/step-actions";
import type { InvoicingView } from "@/lib/invoicing/record";
import { useStepRunner } from "@/lib/records/use-step-runner";

// The Datos tab of a stored invoice or note (plan 2B Task 20, prototype 2B «Factura FE-1234»): its stage (Borrador, Emitida, Pagada,
// Anulada) and its DIAN chip, the DIAN trail (Emitida · Enviada a la DIAN · Aceptada), the DIAN's errors of a rejection, its facts
// (references link to their records, rule 21), its totals in the money format (rule 23), the notes of an invoice and «Crear nota crédito /
// débito» (the concept from the country's DIAN tables, the reason and the lines). «Emitir», «Reintentar envío» and «Anular (nota crédito)»
// are the record bar's (invoicing-bar.tsx, fix round 1). A step the DIAN does not allow yet shows disabled with why. A refusal shows the
// process's reasons (the readiness gate's among them). A note's Duplicar lands here: the panel opens started from the source note.

function Section({ title, extra, children, label }: { title: string; extra?: ReactNode; children: ReactNode; label?: string }) {
  return (
    <section className="erp-sec" {...(label ? { "aria-label": label } : {})}>
      <h3>
        {title}
        {extra && <> {extra}</>}
      </h3>
      {children}
    </section>
  );
}

function Labelled({ label, children }: { label: string; children: (id: string) => ReactNode }) {
  const id = useId();
  return (
    <div className="erp-field">
      <label htmlFor={id}>{label}</label>
      {children(id)}
    </div>
  );
}

export interface InvoicingRecordViewProps {
  entity: string;
  recordId: string;
  view: InvoicingView;
  /** A Borrador still open: its edit form (Editar shows it in place of the facts). */
  editForm?: ReactNode;
}

export function InvoicingRecordView({ entity, recordId, view, editForm }: InvoicingRecordViewProps) {
  const t = useTranslations("invoicing.view");
  const te = useTranslations("errors");
  const router = useRouter();
  const openTab = useTabs((s) => s.open);
  const [noting, setNoting] = useState<NoteKind | null>(null);
  // A note's Duplicar (rule 37): the copy handed to this invoice opens «Crear nota» started from it until the panel closes or creates.
  const handed = useSyncExternalStore(subscribeNotes, () => (view.kind === "invoice" ? pendingNote(recordId) : null), () => null);
  const copied = useMemo(() => {
    if (!handed || !view.steps.includes("to_note")) return null;
    const offered = (handed.kind === "credit" ? view.concepts.credit : view.concepts.debit).map((c) => c.code);
    return noteCopy(handed, view.invoiceLines, offered);
  }, [handed, view]);
  const panel = noting ?? copied?.kind ?? null;
  const closePanel = () => {
    setNoting(null);
    takeNote(recordId);
  };
  const step = useStepRunner((name: string, input, token) => runInvoicingStepAction(entity, name, recordId, input, token), (outcome: Extract<InvoicingStepOutcome, { ok: true }>) => {
    if (outcome.created) {
      closePanel();
      // The note the step wrote opens in its own tab (Crear nota crédito / débito).
      const href = `/r/${outcome.created.entity}/${outcome.created.id}`;
      openTab({ title: outcome.created.number ?? t("created_note"), href, kind: "record" });
      router.push(href);
    } else {
      closePanel();
      router.refresh();
    }
  }, { clickKey: true });
  const prefix = view.kind === "invoice" ? "invoice" : "note";
  const failureText = step.failure ? (step.failure.messages.length > 0 ? step.failure.messages.join(" · ") : te.has(step.failure.code) ? te(step.failure.code) : te("unknown")) : null;

  // An editable Borrador (fix round 1): its form is the Datos tab, so the bar's Guardar (saveOnly) and Emitir sit together; the facts keep
  // only what links (its pedidos and entregas) and its stored totals stay under the form.
  const editable = editForm !== undefined && editForm !== null;

  return (
    <div className="erp-form">
      <Section
        title={t("facts")}
        extra={
          <>
            <span data-testid={`${prefix}-stage`}>
              <Pill tone={view.stageTone}>{view.stageLabel}</Pill>
            </span>
            {view.stage !== "draft" && (
              <span data-testid={`${prefix}-dian`} title={t("dian_chip")}>
                <Pill tone={view.dian.tone}>{view.dian.label}</Pill>
              </span>
            )}
          </>
        }
      >
        {view.trail.length > 0 && (
          <ol className="erp-row erp-small" aria-label={t("trail.label")}>
            {view.trail.map((s) => (
              <li key={s.label} className={s.done ? "erp-pill erp-pill--ok" : "erp-pill erp-pill--gray"} data-done={s.done ? "" : undefined}>
                {s.done ? "✓ " : "… "}
                {s.label}
                {s.at ? <span className="erp-muted"> · {s.at}</span> : null}
              </li>
            ))}
          </ol>
        )}
        {view.priceWarning && (
          <div className="erp-dian erp-dian--warn" role="status" data-testid="price-date-warning">
            {view.priceWarning}
          </div>
        )}
        {view.rateWarning && (
          <div className="erp-dian erp-dian--warn" role="status" data-testid="rate-warning">
            {view.rateWarning}
          </div>
        )}
        {view.errors.length > 0 && (
          <div className="erp-dian erp-dian--bad">
            <b>{t("errors_title")}</b>
            <ul aria-label={t("errors_title")}>
              {view.errors.map((e, i) => (
                <li key={i}>{e}</li>
              ))}
            </ul>
            <p className="erp-small">{t(view.errorsPending ? "errors_pending" : "errors_hint")}</p>
          </div>
        )}
        {view.annulment && (
          <div className={view.annulment.accepted ? "erp-dian erp-dian--bad" : "erp-dian erp-dian--warn"} data-testid="invoice-annulment">
            {t.rich(view.annulment.accepted ? "annulment.accepted" : "annulment.sent", {
              note: () => <RecordLink entity="invoicing.note" id={view.annulment!.id} label={view.annulment!.number ?? t("annulment.note")} mono />,
              b: (chunks) => <b>{chunks}</b>,
            })}
          </div>
        )}
        <div className="erp-form2">
          {(editable ? view.facts.filter((f) => f.links && f.links.length > 0) : view.facts).map((f) => (
            <div key={f.label} className="erp-field" {...(f.testId ? { "data-testid": `${f.testId}-field` } : {})}>
              <span className="erp-field__label">{f.label}</span>
              {f.links && f.links.length > 0 ? (
                <span className="erp-row">
                  {f.links.map((l) => (
                    <RecordLink key={l.id} entity={l.entity} id={l.id} label={l.label} mono />
                  ))}
                  {Array.from({ length: f.unavailable ?? 0 }, (_, i) => (
                    <span key={`unavailable-${i}`} className="erp-muted" data-testid="order-unavailable">
                      {t("order_unavailable")}
                    </span>
                  ))}
                </span>
              ) : f.link ? (
                <RecordLink entity={f.link.entity} id={f.link.id} label={f.value} {...(f.mono ? { mono: true } : {})} />
              ) : (
                <span className={f.mono ? "erp-mono" : undefined} {...(f.testId ? { "data-testid": f.testId } : {})} style={f.mono ? { overflowWrap: "anywhere" } : undefined}>
                  {f.value}
                </span>
              )}
            </div>
          ))}
          {view.notes.length > 0 && (
            <div className="erp-field">
              <span className="erp-field__label">{t("notes")}</span>
              <span className="erp-row">
                {view.notes.map((n) => (
                  <RecordLink key={n.id} entity="invoicing.note" id={n.id} label={n.number} mono />
                ))}
              </span>
            </div>
          )}
        </div>
      </Section>

      {editable && editForm}

      <Section title={t("totals")}>
        <dl className="erp-totals">
          <div>
            <dt>{t("subtotal")}</dt>
            <dd className="erp-num erp-mono">{view.totals.subtotal}</dd>
          </div>
          {view.totals.discount !== null && (
            <div>
              <dt>{t("discount")}</dt>
              <dd className="erp-num erp-mono">{view.totals.discount}</dd>
            </div>
          )}
          <div>
            <dt>{t("taxes")}</dt>
            <dd className="erp-num erp-mono">{view.totals.tax}</dd>
          </div>
          <div>
            <dt>
              <b>{t("total")}</b>
            </dt>
            <dd className="erp-num erp-mono" data-testid={`${prefix}-total`}>
              <b>{view.totals.total}</b>
            </dd>
          </div>
        </dl>
      </Section>

      {panel && <NotePanel key={`${panel}:${noting ? "new" : "copy"}`} kind={panel} view={view} initial={noting ? null : copied} busy={step.busy} onCancel={closePanel} onCreate={(draft) => step.run("to_note", noteInput(recordId, draft))} />}

      {failureText && (
        <div className="erp-dian erp-dian--bad" role="alert">
          <b>{failureText}</b>
        </div>
      )}
      {step.stepUp && <StepUpPrompt onConfirm={(code) => void step.confirm(code)} onCancel={step.cancel} error={step.stepUpError} busy={step.busy} />}
      {view.steps.includes("to_note") && !panel && (
        <div className="erp-form__actions">
          <div className="erp-row">
            <span className="erp-small erp-muted erp-grow" role="status">
              {step.busy ? t("working") : (view.noteBlock ?? "")}
            </span>
            <button type="button" className="erp-btn" disabled={step.busy || view.noteBlock !== null} title={view.noteBlock ?? undefined} onClick={() => setNoting("credit")}>
              {t("to_credit")}
            </button>
            <button type="button" className="erp-btn" disabled={step.busy || view.noteBlock !== null} title={view.noteBlock ?? undefined} onClick={() => setNoting("debit")}>
              {t("to_debit")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** «Crear nota crédito / débito»: the concept of the country's DIAN table, the reason and how much of each invoice line it corrects. */
function NotePanel({ kind, view, initial, busy, onCancel, onCreate }: { kind: NoteKind; view: InvoicingView; initial: NoteDraft | null; busy: boolean; onCancel: () => void; onCreate: (draft: NoteDraft) => void }) {
  const t = useTranslations("invoicing.view");
  const [draft, setDraft] = useState<NoteDraft>(() => initial ?? noteDraft(kind, view.invoiceLines));
  const missing = noteMissing(draft);
  const concepts = kind === "credit" ? view.concepts.credit : view.concepts.debit;
  const setLine = (i: number, patch: Partial<NoteDraft["lines"][number]>) => setDraft((d) => ({ ...d, lines: d.lines.map((l, j) => (j === i ? { ...l, ...patch } : l)) }));
  const title = t(kind === "credit" ? "note_panel.title_credit" : "note_panel.title_debit");
  return (
    <Section title={title} label={title}>
      <p className="erp-small erp-muted">{t(kind === "credit" ? "note_panel.hint_credit" : "note_panel.hint_debit")}</p>
      <div className="erp-form2">
        <Labelled label={t("note_panel.concept")}>
          {(id) => (
            <select id={id} value={draft.concept} onChange={(e) => setDraft((d) => ({ ...d, concept: e.target.value }))}>
              <option value="">—</option>
              {concepts.map((c) => (
                <option key={c.code} value={c.code}>
                  {c.name}
                </option>
              ))}
            </select>
          )}
        </Labelled>
        <Labelled label={t("note_panel.reason")}>{(id) => <input id={id} value={draft.reason} maxLength={500} onChange={(e) => setDraft((d) => ({ ...d, reason: e.target.value }))} />}</Labelled>
      </div>
      <div className="erp-lines__scroll">
        <table className="erp-lines__table" aria-label={t("note_panel.lines")}>
          <thead>
            <tr>
              <th scope="col" className="erp-lines__no">
                #
              </th>
              <th scope="col">{t("note_panel.line")}</th>
              <th scope="col" className="erp-num">
                {t("note_panel.invoiced")}
              </th>
              <th scope="col" className="erp-num">
                {t("note_panel.qty")}
              </th>
              <th scope="col" className="erp-num">
                {t("note_panel.unit_price")}
              </th>
            </tr>
          </thead>
          <tbody>
            {draft.lines.map((l, i) => (
              <tr key={l.invoiceLineId}>
                <td className="erp-lines__no erp-muted">{l.lineNo}</td>
                <td>{l.label}</td>
                <td className="erp-num erp-mono">{String(l.invoicedQty).replace(".", ",")}</td>
                <td className="erp-num">
                  <input aria-label={t("note_panel.qty_line", { n: l.lineNo })} className="erp-num erp-mono" inputMode="decimal" value={l.qty} onChange={(e) => setLine(i, { qty: e.target.value })} />
                </td>
                <td className="erp-num">
                  <input aria-label={t("note_panel.unit_price_line", { n: l.lineNo })} className="erp-num erp-mono" inputMode="decimal" placeholder={t("note_panel.from_invoice")} value={l.unitPrice} onChange={(e) => setLine(i, { unitPrice: e.target.value })} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="erp-row">
        <span className="erp-small erp-muted erp-grow" role="status">
          {missing.length > 0 ? `${t("note_panel.missing")}: ${missing.map((m) => t(`note_panel.missing_field.${m}`)).join(", ")}` : ""}
        </span>
        <button type="button" className="erp-btn" disabled={busy} onClick={onCancel}>
          {t("note_panel.cancel")}
        </button>
        <button type="button" className="erp-btn erp-btn--primary" disabled={busy || missing.length > 0} onClick={() => onCreate(draft)}>
          {t("note_panel.create")}
        </button>
      </div>
    </Section>
  );
}
