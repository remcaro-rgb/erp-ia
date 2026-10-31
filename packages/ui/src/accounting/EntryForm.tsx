"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Pill } from "../grid/GridCell";
import { Field, FormActions, RecordForm, Section, SelectField, TextField, failureMessages, useErrorText } from "../forms/form-parts";
import type { CodeOption, RequestStepUp, SaveRecord } from "../forms/save-model";
import { useSaveFlow } from "../forms/use-save";
import { LinesEditor, LookupCell, type LineLookup } from "./LinesEditor";
import { EntryStatusBar, type ActionOutcome } from "./EntryStatusBar";
import { allowedActions, blankLine, entryDraftOf, entryInput, lineTotals, visibleColumns, type Chosen, type EditorLine, type EntryAction, type EntryHeader, type EntrySettings } from "./entry-model";

// The Datos tab of a comprobante (accounting design §4.6, §4.7, §8): the header (Fuente, fecha, descripción, unidad de negocio
// and the automatic reversal date), the keyboard-first lines editor and the status buttons. Only a draft is edited; a pending,
// posted, reversed or voided comprobante shows read-only and acts through its buttons.

/** The input fields a refusal's message is shown under. */
const HEADER_FIELDS = ["date", "description", "journalId", "reverseOn", "businessUnitId"];

export interface EntryFormProps {
  /** The stored comprobante as `accounting.entry.consult` returns it (header and lines), or null for a new one. */
  record: (Record<string, unknown> & { id: string }) | null;
  /** A new comprobante started from a copy ("Duplicar", rule 37): the copy's header values by field name. Ignored for a stored record. */
  initial?: Readonly<Record<string, unknown>> | null;
  /** How the linked records of the comprobante read (party, dimensions), by id, for the viewer. */
  labels: Readonly<Record<string, string>>;
  settings: EntrySettings;
  /** The Fuentes that accept manual entries: code is the id. */
  journals: readonly CodeOption[];
  defaultJournalId: string | null;
  /** The viewer: the approval of an entry they created is theirs to leave to another person. */
  userId: string;
  lookup: LineLookup;
  /** The viewer may run the create (new) or update (stored) process. */
  canSave: boolean;
  /** The processes behind each button the viewer may run. */
  can: Readonly<Record<EntryAction, boolean>>;
  save: SaveRecord;
  requestStepUp?: RequestStepUp;
  /** Runs a status button's process for the comprobante (a server action). */
  runAction: (action: EntryAction, id: string, input: { reason?: string }, stepUp?: string) => Promise<ActionOutcome>;
  onSaved?: (id: string, created: boolean) => void;
  /** An action ran: the page reloads the record. */
  onActed?: () => void;
}

export function EntryForm(props: EntryFormProps) {
  const { record, initial: copy, labels, settings, journals, defaultJournalId, userId, lookup, canSave, can, save, requestStepUp, runAction, onSaved, onActed } = props;
  const t = useTranslations("common.entry");
  const tf = useTranslations("common.forms");
  const tv = useTranslations("grid.values.entry_status");
  const errorText = useErrorText();
  const isNew = record === null;

  const fresh = () => {
    const source = record ?? copy ?? null;
    const draft = entryDraftOf(source, labels);
    const header: EntryHeader = { ...draft.header, journalId: draft.header.journalId || defaultJournalId || journals[0]?.code || "", date: draft.header.date || today() };
    return { header, lines: record ? draft.lines : [blankLine()] };
  };
  const recordKey = record ? `${record.id}:${String(record.updated_at ?? "")}:${String(record.status ?? "")}` : "new";
  const [seen, setSeen] = useState(recordKey);
  const [initial, setInitial] = useState(() => fresh());
  const [header, setHeader] = useState(initial.header);
  const [lines, setLines] = useState<EditorLine[]>(initial.lines.length > 0 ? initial.lines : [blankLine()]);
  if (seen !== recordKey) {
    const next = fresh();
    setSeen(recordKey);
    setInitial(next);
    setHeader(next.header);
    setLines(next.lines.length > 0 ? next.lines : [blankLine()]);
  }

  const status = typeof record?.status === "string" ? record.status : "draft";
  const restricted = lines.some((l) => l.restricted);
  const editable = canSave && status === "draft" && !restricted;
  const dis = !editable;
  const flow = useSaveFlow(save, requestStepUp, (id) => onSaved?.(id, isNew));
  const set =
    <K extends keyof EntryHeader>(key: K) =>
    (value: EntryHeader[K]) =>
      setHeader((h) => ({ ...h, [key]: value }));
  const failed = failureMessages(flow.failure, HEADER_FIELDS, errorText);
  const fe = failed.field;
  const totals = lineTotals(lines);
  const dirty = JSON.stringify([header, lines.map(contentOf)]) !== JSON.stringify([initial.header, initial.lines.map(contentOf)]);
  const missing = header.description.trim() === "" || header.date === "";

  const submit = () =>
    void flow.submit({
      ...(record ? { id: record.id } : {}),
      ...entryInput({ journalId: header.journalId, date: header.date, description: header.description, businessUnitId: header.businessUnit?.id ?? null, reverseOn: header.reverseOn }, lines),
    });

  const facts = record
    ? { status, origin: String(record.origin ?? "manual"), createdBy: typeof record.created_by === "string" ? record.created_by : null, isClosing: record.is_closing === true, reversalOfId: typeof record.reversal_of_id === "string" ? record.reversal_of_id : null }
    : null;
  const buttons = facts ? allowedActions(facts, settings, userId, { canReturn: can.return }) : [];
  const run = (action: EntryAction, input: { reason?: string }, stepUp?: string) => runAction(action, record!.id, input, stepUp).then((outcome) => {
    if (outcome.ok) onActed?.();
    return outcome;
  });

  const journalOptions = journals.some((j) => j.code === header.journalId) || !header.journalId ? journals : [...journals, { code: header.journalId, name: String(record?.journal_id ?? header.journalId) }];

  return (
    <RecordForm canSave={editable && !missing && !flow.saving && !flow.stepUp && (dirty || isNew)} onSave={submit} failure={flow.failure}>
      {record && (
        <div className="erp-row">
          <Pill tone={STATUS_TONE[status] ?? "gray"}>{tv(status)}</Pill>
          <span className="erp-mono">{typeof record.number === "string" && record.number ? record.number : t("none_yet")}</span>
        </div>
      )}
      {record && facts && (
        <EntryStatusBar actions={buttons} can={can} onRun={run} {...(requestStepUp ? { requestStepUp } : {})} />
      )}
      {!canSave && <div className="erp-dian erp-dian--info">{tf("read_only")}</div>}
      {canSave && !isNew && status !== "draft" && <div className="erp-dian erp-dian--info">{t("read_only")}</div>}
      {restricted && <div className="erp-dian erp-dian--warn">{t("restricted_note")}</div>}
      {isNew && copy && <div className="erp-dian erp-dian--info">{t("clone_note")}</div>}
      <Section title={t("header")}>
        <div className="erp-form3">
          <SelectField label={t("journal")} value={header.journalId} options={journalOptions} showCode={false} disabled={dis} error={fe("journalId")} onChange={set("journalId")} />
          <Field label={t("date")} error={fe("date")}>
            {(id, describedBy) => <input id={id} type="date" value={header.date} disabled={dis} aria-invalid={fe("date") ? true : undefined} aria-describedby={describedBy} onChange={(e) => set("date")(e.target.value)} />}
          </Field>
          <Field label={t("reverse_on")} hint={t("reverse_on_hint")} error={fe("reverseOn")}>
            {(id, describedBy) => <input id={id} type="date" value={header.reverseOn} disabled={dis} aria-invalid={fe("reverseOn") ? true : undefined} aria-describedby={describedBy} onChange={(e) => set("reverseOn")(e.target.value)} />}
          </Field>
          <TextField label={t("description")} value={header.description} maxLength={500} disabled={dis} error={fe("description")} className="erp-span2" onChange={set("description")} />
          {settings.useBusinessUnits && (
            <div className="erp-field" role="group" aria-label={t("business_unit")}>
              <span className="erp-field__label">
                {t("business_unit")} <span className="erp-field__hint">{t("business_unit_header_hint")}</span>
              </span>
              <LookupCell
                cell=""
                label={t("business_unit")}
                kind="businessUnit"
                value={header.businessUnit}
                placeholder={undefined}
                inherit={false}
                disabled={dis}
                lookup={lookup}
                debounceMs={150}
                onPick={(picked: Chosen | null) => set("businessUnit")(picked)}
              />
              {fe("businessUnitId") && <span className="erp-field__error">{fe("businessUnitId")}</span>}
            </div>
          )}
        </div>
      </Section>
      <Section title={t("lines")}>
        <LinesEditor
          lines={lines}
          onChange={setLines}
          columns={visibleColumns(settings)}
          lookup={lookup}
          headerBusinessUnit={header.businessUnit?.label ?? null}
          readOnly={dis}
          knownTotals={restricted && record ? { debit: Number(record.total_debit ?? 0), credit: Number(record.total_credit ?? 0) } : null}
        />
      </Section>
      {failed.panel.length > 0 && (
        <div role="alert" tabIndex={-1} data-error-summary="" className="erp-dian erp-dian--bad">
          <b>{failed.panel.join(" · ")}</b>
        </div>
      )}
      {editable && (
        <FormActions
          flow={flow}
          isNew={isNew}
          dirty={dirty}
          blocked={missing || totals.partial}
          pendingCount={null}
          onSave={submit}
          onDiscard={() => {
            setHeader(initial.header);
            setLines(initial.lines.length > 0 ? initial.lines : [blankLine()]);
          }}
          process={isNew ? "accounting.entry.create" : "accounting.entry.update"}
        />
      )}
    </RecordForm>
  );
}

/** A row without its browser identity: what makes two states of the editor the same. */
const contentOf = (l: EditorLine) => [l.account, l.party, l.costCenter, l.openAuxiliary, l.item, l.businessUnit, l.description, l.debit, l.credit, l.restricted];

const STATUS_TONE: Record<string, "ok" | "warn" | "danger" | "info" | "gray"> = { draft: "gray", pending: "warn", posted: "ok", reversed: "info", voided: "danger" };

/** Today in the browser's calendar, as the date input holds it. */
function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
