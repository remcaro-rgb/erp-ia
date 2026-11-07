import "server-only";
import { getTranslations } from "next-intl/server";
import { countryPack, gridPageAccess, inlinePostingProcesses, ProcessError, runnableProcesses, runProcess, withClaims, type Caller } from "@erp/kernel";
import type { GridColumn } from "@erp/ui";
import { gridEntity } from "@/lib/grid/access";
import { buildColumns } from "@/lib/grid/columns";
import { presentationOf } from "@/lib/grid/presentation";
import { processDeps } from "@/lib/server/runtime";
import { postingModeData, type PostingModeData } from "./posting-mode";

export type { PostingMode, PostingModeData } from "./posting-mode";

// What the Reglas contables page needs (accounting design §5.5, §5.9, §8), read as the caller: the tab strip with the pending count,
// and for the chosen tab the stored role mappings, the exógena concepts, the inbox of events that could not post and the settings.

export const POSTING_TABS = ["rules", "mapping", "concepts", "pending", "settings"] as const;
export type PostingTab = (typeof POSTING_TABS)[number];
export const isPostingTab = (tab: string | undefined): tab is PostingTab => (POSTING_TABS as readonly string[]).includes(tab ?? "");

/** What an account lookup box needs (the grid of `accounting.account` with the caller's field modes). */
export interface AccountLookup {
  columns: GridColumn[];
  entityLabel: string;
}

export interface MappingRow {
  role: string;
  dimension: string | null;
  account: { id: string; label: string } | null;
}

export interface FailureRow {
  id: string;
  event: string;
  eventDate: string | null;
  createdAt: string;
  ruleName: string | null;
  code: string;
  detail: string | null;
  attempts: number;
  /** The closed period holding the event's date, when the failure is `closed_period` and the period is still closed. */
  period: { id: string; startsOn: string; endsOn: string } | null;
}

export interface SettingsData {
  ledgerStartsOn: string | null;
  roundingTolerance: number;
  manualJournalId: string | null;
  requireAttachmentOnManual: boolean;
  requireApprovalOnManual: boolean;
  niifGroup: "1" | "2" | "3";
  useOpenAuxiliaries: boolean;
  useItems: boolean;
  useBusinessUnits: boolean;
  /** Days without a matching event after which a rule with a `when` shows «Sin coincidencias en N días». */
  ruleStaleDays: number;
  /** Events acknowledged without posting because they predate the start of the ledger. */
  skippedEvents: number;
  journals: { id: string; label: string }[];
}

export interface ConceptsData {
  format: string;
  year: number;
  formats: string[];
  concepts: { code: string; label: string; accounts: { id: string; code: string; name: string; isActive: boolean }[] }[];
  unmapped: { accountId: string; code: string; name: string; movement: number }[];
}

export interface PostingPageData {
  tab: PostingTab;
  pending: number;
  can: { reopenPeriod: boolean; retry: boolean; dismiss: boolean; mapping: boolean; concepts: boolean; settings: boolean; postingMode: boolean };
  /** The tabs the caller's roles can open. */
  tabs: PostingTab[];
  lookup: AccountLookup | null;
  mapping?: MappingRow[];
  unmapped?: string[];
  /** The posting mode card of the mapping tab (Task 33, R33-9): the mode, what awaits the ledger and the documentos it applies to. */
  postingMode?: PostingModeData;
  concepts?: ConceptsData | null;
  failures?: FailureRow[];
  settings?: SettingsData | null;
}

const refused = (error: unknown) => error instanceof ProcessError && ["forbidden", "not_entitled", "not_found"].includes(error.code);

/** The grid of `accounting.account` as a lookup box needs it; null when the caller may not read the chart. */
async function accountLookup(caller: Caller): Promise<AccountLookup | null> {
  const deps = processDeps();
  const entity = gridEntity(deps.registry, "accounting.account");
  if (!entity) return null;
  const [access, t] = await Promise.all([gridPageAccess(deps.sql, caller.claims, entity), getTranslations()]);
  return { columns: buildColumns(entity, access, presentationOf(entity.id), (key) => t(key as never)), entityLabel: t(entity.label as never) };
}

/**
 * The mode card's facts (Task 33, R33-9), for whoever reads the mapping: the mode from `accounting.v_posting_mode` (the one column, not
 * sensitive; no other setting is unmasked), the documents awaiting their entry from `v_pending_postings` (queued or dead-lettered, as the consult
 * counts them) and the failures of the retry queue (a number, no row). All read as the caller under RLS (rule 14).
 */
async function postingModeOf(caller: Caller, processIds: readonly string[]): Promise<PostingModeData> {
  const deps = processDeps();
  const companyId = caller.claims.active_company_id;
  const [facts] = await withClaims(deps.sql, caller.claims, (tx) =>
    tx<{ posting_mode: string | null; documents: number; failures: number }[]>`
      select (select posting_mode from accounting.v_posting_mode where company_id = ${companyId}) as posting_mode,
             (select count(distinct source_id)::int from accounting.v_pending_postings where state in ('queued', 'dead')) as documents,
             (select count(*)::int from accounting.v_posting_failures where company_id = ${companyId} and status = 'pending') as failures`,
  );
  return postingModeData({ postingMode: facts?.posting_mode, pendingDocuments: facts?.documents, pendingFailures: facts?.failures }, processIds);
}

export async function loadPostingPage(caller: Caller, requested: PostingTab, query: { format?: string; year?: number } = {}): Promise<PostingPageData> {
  const deps = processDeps();
  const companyId = caller.claims.active_company_id;
  const runnable = await runnableProcesses(deps.sql, deps.registry, caller.claims, [
    "accounting.posting_rule.consult", "accounting.account_role_mapping.consult", "accounting.fiscal_concept_mapping.consult", "accounting.posting_failure.consult",
    "accounting.settings.consult", "accounting.period.reopen", "accounting.posting.retry", "accounting.posting_failure.dismiss",
    "accounting.account_role_mapping.update", "accounting.fiscal_concept_mapping.update", "accounting.settings.update", "accounting.posting_mode.set",
  ]);
  const tabs = POSTING_TABS.filter((tab) => {
    const need = { rules: "accounting.posting_rule.consult", mapping: "accounting.account_role_mapping.consult", concepts: "accounting.fiscal_concept_mapping.consult", pending: "accounting.posting_failure.consult", settings: "accounting.settings.consult" }[tab];
    return runnable.has(need);
  });
  const tab = tabs.includes(requested) ? requested : (tabs[0] ?? requested);
  const pending = runnable.has("accounting.posting_failure.consult")
    ? (await withClaims(deps.sql, caller.claims, (tx) => tx<{ n: number }[]>`select count(*)::int as n from accounting.v_posting_failures where company_id = ${companyId} and status = 'pending'`))[0]!.n
    : 0;
  const data: PostingPageData = {
    tab,
    pending,
    tabs,
    lookup: null,
    can: {
      reopenPeriod: runnable.has("accounting.period.reopen"),
      retry: runnable.has("accounting.posting.retry"),
      dismiss: runnable.has("accounting.posting_failure.dismiss"),
      mapping: runnable.has("accounting.account_role_mapping.update"),
      concepts: runnable.has("accounting.fiscal_concept_mapping.update"),
      settings: runnable.has("accounting.settings.update"),
      postingMode: runnable.has("accounting.posting_mode.set"),
    },
  };

  if (tab === "mapping" || tab === "concepts") data.lookup = await accountLookup(caller);

  if (tab === "mapping") {
    try {
      const out = (await runProcess(deps, caller, "accounting.account_role_mapping.consult", {})) as {
        mappings: { role: string; dimension: string | null; accountId: string; accountCode: string | null; accountName: string | null }[];
        unmapped: string[];
      };
      data.mapping = out.mappings.map((m) => ({
        role: m.role,
        dimension: m.dimension,
        account: { id: m.accountId, label: m.accountCode ? `${m.accountCode} — ${m.accountName ?? ""}`.trim() : m.accountId },
      }));
      data.unmapped = out.unmapped;
    } catch (error) {
      if (!refused(error)) throw error;
      data.mapping = [];
      data.unmapped = [];
    }
    data.postingMode = await postingModeOf(caller, inlinePostingProcesses(deps.registry));
  }

  if (tab === "concepts") {
    const year = query.year ?? new Date().getFullYear();
    const country = (await withClaims(deps.sql, caller.claims, (tx) => tx<{ country_code: string }[]>`select country_code from kernel.companies where id = ${companyId}`))[0]!.country_code;
    let formats: string[] = [];
    try {
      formats = countryPack(country).accounting.exogenaFormats(year).map((f) => f.format);
    } catch {
      formats = [];
    }
    const format = query.format && formats.includes(query.format) ? query.format : formats[0];
    data.concepts = null;
    if (format) {
      try {
        const out = (await runProcess(deps, caller, "accounting.fiscal_concept_mapping.consult", { format, year })) as Omit<ConceptsData, "formats">;
        data.concepts = { ...out, formats };
      } catch (error) {
        if (!refused(error)) throw error;
      }
    }
  }

  if (tab === "pending") {
    const rows = await withClaims(deps.sql, caller.claims, (tx) =>
      tx<{ id: string; event: string; event_date: string | null; created_at: string; rule_name: string | null; error_code: string; error_detail: string | null; attempts: number; period_id: string | null; starts_on: string | null; ends_on: string | null }[]>`
        select f.id, f.event, f.event_date::text, f.created_at::text, r.name as rule_name, f.error_code, f.error_detail, f.attempts,
               p.id as period_id, p.starts_on::text, p.ends_on::text
        from accounting.v_posting_failures f
        left join accounting.v_posting_rules r on r.id = f.posting_rule_id
        left join accounting.v_periods p on p.company_id = f.company_id and p.status = 'closed' and f.error_code = 'closed_period'
                                          and coalesce(f.event_date, f.created_at::date) between p.starts_on and p.ends_on
        where f.company_id = ${companyId} and f.status = 'pending'
        order by f.created_at desc limit 200`,
    );
    data.failures = rows.map((r) => ({
      id: r.id, event: r.event, eventDate: r.event_date, createdAt: r.created_at, ruleName: r.rule_name, code: r.error_code, detail: r.error_detail, attempts: r.attempts,
      period: r.period_id ? { id: r.period_id, startsOn: r.starts_on!, endsOn: r.ends_on! } : null,
    }));
  }

  if (tab === "settings") {
    try {
      const out = (await runProcess(deps, caller, "accounting.settings.consult", {})) as SettingsData & { configured: boolean; skippedEvents: number };
      const journals = await withClaims(deps.sql, caller.claims, (tx) =>
        tx<{ id: string; code: string; name: string }[]>`select id, code, name from accounting.v_journals where company_id = ${companyId} and is_active and manual_entries order by code`,
      );
      data.settings = out.configured
        ? {
            ledgerStartsOn: out.ledgerStartsOn, roundingTolerance: out.roundingTolerance, manualJournalId: out.manualJournalId, requireAttachmentOnManual: out.requireAttachmentOnManual,
            requireApprovalOnManual: out.requireApprovalOnManual, niifGroup: out.niifGroup, useOpenAuxiliaries: out.useOpenAuxiliaries, useItems: out.useItems, useBusinessUnits: out.useBusinessUnits, ruleStaleDays: out.ruleStaleDays ?? 30,
            skippedEvents: out.skippedEvents, journals: journals.map((j) => ({ id: j.id, label: `${j.code} · ${j.name}` })),
          }
        : null;
    } catch (error) {
      if (!refused(error)) throw error;
      data.settings = null;
    }
  }
  return data;
}
