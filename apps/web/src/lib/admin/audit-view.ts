import { valueText, type AuditEntryDetail, type LabelledField, type ValueLabels } from "@erp/kernel";
import { actorHref, auditRecordHref } from "./audit-links";

export { actorHref, auditRecordHref, SYSTEM_ACTOR } from "./audit-links";

// The audit viewer's detail of one entry as the sheet shows it (design §22.14, rule 16): every changed field as
// `label · antes → después`, a creation's or a refusal's input as `label · valor`, with the field's label from the
// catalogue (or the admin's own label of an admin-defined field), values as the forms show them through the kernel's
// shared label helper (option and code labels, money, dates in the company's zone), a dash for nothing and •••••• for a
// field the viewer sees masked (the kernel already left its values out). Server side: it reads the catalogue and the pack.

/** What a masked field shows in every channel (rule 14). */
const MASK = "••••••";
const NOTHING = "—";

export interface AuditDetailView {
  id: string;
  occurredAt: string;
  origin: string;
  action: string;
  process: { id: string; description: string | null } | null;
  /** The entity's name from the catalogue, or null for a platform table without one (the raw name stands in). */
  entityLabel: string | null;
  entity: string;
  rowId: string | null;
  rowTitle: string | null;
  rowHref: string | null;
  /** The record this one was cloned from (rule 37). */
  source: { id: string; title: string | null; href: string | null } | null;
  actor: { userId: string | null; email: string | null; href: string | null };
  chainId: string;
  /** False for an entry on a platform table: no field is described (the sheet says "sin detalle de campos"). */
  described: boolean;
  changes: { field: string; label: string; before: string; after: string; masked: boolean }[];
  input: { key: string; label: string; value: string; masked: boolean }[] | null;
}

type Described = { labelKey: string | null; labelText?: string; type: string | null; valuesKey?: string; codes?: string; masked: boolean };

const fieldOf = (d: Described): LabelledField => ({
  type: d.type,
  ...(d.valuesKey ? { valuesKey: d.valuesKey } : {}),
  ...(d.codes ? { codes: d.codes as LabelledField["codes"] } : {}),
});

/** The detail of `detail` as text in the viewer's language. */
export function presentAuditDetail(detail: AuditEntryDetail, labels: ValueLabels): AuditDetailView {
  const { entry } = detail;
  const labelOf = (d: Described, fallback: string) => (d.labelKey ? labels.t(d.labelKey) : undefined) ?? d.labelText ?? fallback;
  const text = (d: Described, value: unknown) => (d.masked ? MASK : valueText(fieldOf(d), value, labels) || NOTHING);
  return {
    id: entry.id,
    occurredAt: valueText({ type: "datetime" }, entry.occurredAt, labels),
    origin: entry.origin,
    action: entry.action,
    process: entry.processId ? { id: entry.processId, description: entry.processDescription } : null,
    entityLabel: entry.entityLabel ? (labels.t(entry.entityLabel) ?? null) : null,
    entity: entry.entity,
    rowId: entry.rowId,
    rowTitle: entry.rowTitle,
    rowHref: auditRecordHref(entry.entityId, entry.rowId),
    source: entry.sourceRowId ? { id: entry.sourceRowId, title: entry.sourceTitle, href: auditRecordHref(entry.entityId, entry.sourceRowId) } : null,
    actor: { userId: entry.actorUserId, email: entry.actor, href: actorHref(entry.actorUserId) },
    chainId: entry.chainId,
    described: detail.described,
    changes: detail.changes
      .map((c) => ({ field: c.field, label: labelOf(c, c.field), before: text(c, c.before), after: text(c, c.after), masked: c.masked }))
      // Stored differently but read the same (no value and an empty list): nothing a person would call a change.
      .filter((c) => c.masked || c.before !== c.after),
    input:
      detail.input?.map((i) => {
        // A refusal records why and which process: said in words.
        if (i.field === null && i.key === "code") {
          return { key: i.key, label: labels.t("common.admin.audit.detail.code") ?? i.key, value: labels.t(`errors.${String(i.value)}`) ?? String(i.value), masked: false };
        }
        if (i.field === null && i.key === "process_id") return { key: i.key, label: labels.t("field.kernel.audit.process_id") ?? i.key, value: String(i.value), masked: false };
        return { key: i.key, label: labelOf(i, i.key), value: text(i, i.value), masked: i.masked };
      }) ?? null,
  };
}
