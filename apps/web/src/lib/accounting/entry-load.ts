import "server-only";
import { getTranslations } from "next-intl/server";
import { callerProfile, ProcessError, recordTitles, runnableProcesses, runProcess, withClaims, type Caller, type ResolvedEntityDef } from "@erp/kernel";
import { formatDayTime, type CodeOption, type EntryAction, type EntrySettings, type OriginLink, type TimelineItem } from "@erp/ui";
import { gridEntity } from "@/lib/grid/access";
import { recordEntity } from "@/lib/records/entities";
import { processDeps } from "@/lib/server/runtime";

// What the comprobante's record page needs besides the entry itself (accounting design §8), read as the caller: the company
// settings, the Fuentes that take manual entries, how the linked records read, which buttons they may run and the Origen tab.

export interface OriginData {
  origin: string;
  source: OriginLink | null;
  event: string | null;
  rule: OriginLink | null;
  reversalOf: OriginLink | null;
  reversedBy: OriginLink | null;
  chainId: string | null;
  timeline: TimelineItem[] | null;
}

export interface EntryFormData {
  settings: EntrySettings;
  journals: CodeOption[];
  defaultJournalId: string | null;
  userId: string;
  labels: Record<string, string>;
  can: Record<EntryAction, boolean>;
  origin: OriginData | null;
}

const DEFAULT_SETTINGS: EntrySettings = { requireApprovalOnManual: false, useOpenAuxiliaries: false, useItems: false, useBusinessUnits: false };

const PROCESS_OF: Record<EntryAction, string> = {
  post: "accounting.entry.save",
  submit: "accounting.entry.submit",
  approve: "accounting.entry.approve",
  return: "accounting.entry.reject",
  reverse: "accounting.entry.reverse",
  void: "accounting.entry.void",
  delete: "accounting.entry.delete",
};

/** True when a refusal only says the caller may not read this (the page then shows less, not an error). */
const denied = (error: unknown): boolean => error instanceof ProcessError && (error.code === "forbidden" || error.code === "not_entitled");

type EntryRow = Record<string, unknown> & { id: string };

/** The ids of the linked records the lines and the header name, by the view that resolves them. */
function linkedIds(entry: EntryRow | null) {
  const lines = Array.isArray(entry?.lines) ? (entry.lines as Record<string, unknown>[]) : [];
  const pick = (field: string) => [...new Set(lines.map((l) => l[field]).filter((v): v is string => typeof v === "string"))];
  const header = typeof entry?.business_unit_id === "string" ? [entry.business_unit_id] : [];
  return {
    party: pick("party_id"),
    costCenter: pick("cost_center_id"),
    openAuxiliary: pick("open_auxiliary_id"),
    item: pick("item_id"),
    businessUnit: [...new Set([...pick("business_unit_id"), ...header])],
  };
}

/** `code · name` of the records the entry links, read through the published views as the caller (masks and RLS apply). */
async function labelsOf(caller: Caller, entry: EntryRow | null): Promise<Record<string, string>> {
  const ids = linkedIds(entry);
  if (Object.values(ids).every((list) => list.length === 0)) return {};
  const labels: Record<string, string> = {};
  const add = (rows: { id: string; code: string | null; name: string | null }[]) => {
    for (const r of rows) labels[r.id] = [r.code, r.name].filter(Boolean).join(" · ");
  };
  await withClaims(processDeps().sql, caller.claims, async (tx) => {
    type Rows = { id: string; code: string | null; name: string | null }[];
    if (ids.party.length) add(await tx<Rows>`select id, document_number as code, coalesce(legal_name, trade_name) as name from core.v_parties where id = any(${ids.party}::uuid[])`);
    if (ids.costCenter.length) add(await tx<Rows>`select id, code, name from accounting.v_cost_centers where id = any(${ids.costCenter}::uuid[])`);
    if (ids.openAuxiliary.length) add(await tx<Rows>`select id, code, name from accounting.v_open_auxiliaries where id = any(${ids.openAuxiliary}::uuid[])`);
    if (ids.item.length) add(await tx<Rows>`select id, code, name from accounting.v_items where id = any(${ids.item}::uuid[])`);
    if (ids.businessUnit.length) add(await tx<Rows>`select id, code, name from accounting.v_business_units where id = any(${ids.businessUnit}::uuid[])`);
  });
  return labels;
}

/** A link to a record, with its title as the viewer sees it; a page only where the entity has one that opens. */
async function linkTo(caller: Caller, entityId: string | null, id: string | null, fallback: string): Promise<OriginLink | null> {
  if (!entityId || !id) return null;
  const deps = processDeps();
  const entity: ResolvedEntityDef | null = gridEntity(deps.registry, entityId);
  const t = await getTranslations();
  const kind = entity ? t(entity.label) : entityId;
  let title: string | null = null;
  if (entity) {
    const titles = await withClaims(deps.sql, caller.claims, (tx) => recordTitles(tx, deps.registry, [{ entity, id }]));
    title = titles.get(`${entity.id}:${id}`) ?? null;
  }
  return { label: `${kind} · ${title ?? fallback}`, record: entity && recordEntity(entity.id) ? { entity: entity.id, id } : null };
}

/** The audit entries of the run that made the entry, oldest first; null when the viewer's role cannot read the audit. */
async function timelineOf(caller: Caller, entry: EntryRow, timeZone: string | undefined, labels: { process: (id: string) => string; action: (a: string) => string }): Promise<TimelineItem[] | null> {
  // An automatic entry belongs to the chain of the run that posted it; any other is followed by its own record.
  const filters = typeof entry.chain_id === "string" ? [{ field: "chain_id", op: "eq", value: entry.chain_id }] : [{ field: "row_id", op: "eq", value: entry.id }];
  try {
    const page = (await runProcess(processDeps(), caller, "kernel.audit.consult", { filters, sort: [{ field: "occurred_at", dir: "asc" }], page: 1, pageSize: 50 })) as { rows: Record<string, unknown>[] };
    return page.rows.map((r) => ({
      id: String(r.id),
      at: r.occurred_at ? formatDayTime(String(r.occurred_at), timeZone) : "",
      actor: String(r.actor ?? ""),
      process: labels.process(String(r.process_id ?? "")),
      action: labels.action(String(r.action ?? "")),
      origin: String(r.origin ?? ""),
    }));
  } catch (error) {
    if (denied(error)) return null;
    throw error;
  }
}

/** Everything the comprobante form and its Origen tab read besides the entry. */
export async function loadEntryForm(caller: Caller, entry: EntryRow | null): Promise<EntryFormData> {
  const deps = processDeps();
  const t = await getTranslations();
  const [settingsRaw, journalRows, runnable, labels] = await Promise.all([
    runProcess(deps, caller, "accounting.settings.consult", {}).catch((error: unknown) => {
      if (denied(error)) return null;
      throw error;
    }),
    withClaims(deps.sql, caller.claims, (tx) =>
      tx<{ id: string; code: string; name: string }[]>`select id, code, name from accounting.v_journals where manual_entries and is_active order by code`,
    ),
    runnableProcesses(deps.sql, deps.registry, caller.claims, [...new Set(Object.values(PROCESS_OF))]),
    labelsOf(caller, entry),
  ]);
  const raw = settingsRaw as (Partial<EntrySettings> & { manualJournalId?: string | null }) | null;
  const settings: EntrySettings = { ...DEFAULT_SETTINGS, ...(raw ? { requireApprovalOnManual: raw.requireApprovalOnManual === true, useOpenAuxiliaries: raw.useOpenAuxiliaries === true, useItems: raw.useItems === true, useBusinessUnits: raw.useBusinessUnits === true, requireAttachmentOnManual: raw.requireAttachmentOnManual === true } : {}) };
  const can = Object.fromEntries((Object.keys(PROCESS_OF) as EntryAction[]).map((action) => [action, runnable.has(PROCESS_OF[action])])) as Record<EntryAction, boolean>;

  let origin: OriginData | null = null;
  if (entry) {
    const rule = typeof entry.posting_rule_id === "string" ? entry.posting_rule_id : null;
    let event: string | null = null;
    if (rule) {
      const [row] = await withClaims(deps.sql, caller.claims, (tx) => tx<{ event: string | null }[]>`select event from accounting.v_posting_rules where id = ${rule}`);
      event = row?.event ?? null;
    }
    const profile = await callerProfile(deps.sql, caller.claims);
    const timeZone = profile.companies.find((c) => c.id === caller.claims.active_company_id)?.timeZone;
    const [source, ruleLink, reversalOf, reversedBy, timeline] = await Promise.all([
      linkTo(caller, typeof entry.source_entity === "string" ? entry.source_entity : null, typeof entry.source_record_id === "string" ? entry.source_record_id : null, String(entry.source_record_id ?? "").slice(0, 8)),
      linkTo(caller, "accounting.posting_rule", rule, event ?? String(rule ?? "").slice(0, 8)),
      linkTo(caller, "accounting.entry", typeof entry.reversal_of_id === "string" ? entry.reversal_of_id : null, ""),
      linkTo(caller, "accounting.entry", typeof entry.reversed_by_id === "string" ? entry.reversed_by_id : null, ""),
      timelineOf(caller, entry, timeZone, {
        process: (id) => deps.registry.processes().find((p) => p.id === id)?.description ?? id,
        action: (a) => (t.has(`grid.values.audit_action.${a}`) ? t(`grid.values.audit_action.${a}`) : a),
      }),
    ]);
    origin = { origin: String(entry.origin ?? "manual"), source, event, rule: ruleLink, reversalOf, reversedBy, chainId: typeof entry.chain_id === "string" ? entry.chain_id : null, timeline };
  }

  return {
    settings,
    journals: journalRows.map((j) => ({ code: j.id, name: `${j.code} · ${j.name}` })),
    defaultJournalId: raw?.manualJournalId ?? null,
    userId: caller.claims.sub,
    labels,
    can,
    origin,
  };
}
