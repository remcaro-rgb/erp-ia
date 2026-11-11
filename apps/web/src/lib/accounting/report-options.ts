import "server-only";
import { z } from "zod";
import { countryPack, withClaims, type Caller, type ReportDef, type Tx } from "@erp/kernel";
import { listPeriods } from "@erp/module-accounting";
import { processDeps } from "@/lib/server/runtime";
import type { LoadReportOptions } from "@/lib/reports/load";

// The parameter bar of an accounting report (accounting design §8, §10a.5): the schema says which parameters exist; this says what the
// reference ones can be (periods, accounts, fuentes, the four analytic masters, terceros, exógena formats), which dimension filters the
// company does not use, and where the bar starts (the current period, today). Read as the caller, so a restricted account or a
// hidden master is not offered.

type Option = { value: string; label: string };

/** "Octubre de 2026" for a period starting on `startsOn` (the same words the period screens use). */
function periodName(startsOn: string, locale: string): string {
  const text = new Date(`${startsOn}T00:00:00Z`).toLocaleDateString(locale === "en" ? "en-US" : "es-CO", { month: "long", year: "numeric", timeZone: "UTC" });
  return text.charAt(0).toUpperCase() + text.slice(1);
}

const PERIOD_PARAMS = new Set(["from", "to", "period", "asOfPeriod"]);
/** Parameters that cannot be typed into the bar (a list of accounts). */
const UNOFFERED = new Set(["accountIds", "currencyCode"]);
const DIMENSION_PARAMS: Record<string, { table: string; setting: "use_open_auxiliaries" | "use_items" | "use_business_units" | null }> = {
  costCenterId: { table: "cost_centers", setting: null },
  openAuxiliaryId: { table: "open_auxiliaries", setting: "use_open_auxiliaries" },
  itemId: { table: "items", setting: "use_items" },
  businessUnitId: { table: "business_units", setting: "use_business_units" },
};
const DIMENSION_LABELS = { cost_center: "cost_centers", open_auxiliary: "open_auxiliaries", item: "items", business_unit: "business_units" } as const;

/** Today in the company's calendar. */
const today = async (tx: Tx, companyId: string) =>
  (await tx<{ d: string }[]>`select (now() at time zone coalesce((select timezone from kernel.v_companies where id = ${companyId}), 'America/Bogota'))::date::text as d`)[0]!.d;

export async function accountingReportOptions(caller: Caller, def: ReportDef, locale: string): Promise<LoadReportOptions> {
  const companyId = caller.claims.active_company_id;
  const json = z.toJSONSchema(def.params, { io: "input", unrepresentable: "any" }) as { properties?: Record<string, { format?: string; type?: string }> };
  const names = Object.keys(json.properties ?? {});
  const has = (name: string) => names.includes(name);

  return withClaims(processDeps().sql, caller.claims, async (tx) => {
    const paramOptions: Record<string, Option[]> = {};
    const defaults: Record<string, string | number> = {};
    const hiddenParams = names.filter((n) => UNOFFERED.has(n));

    const periods = await listPeriods(tx, companyId);
    const [now] = await tx<{ id: string | null; starts_on: string | null; ends_on: string | null }[]>`
      select id, starts_on::text, ends_on::text from accounting.v_periods
      where company_id = ${companyId} order by (current_date between starts_on and ends_on) desc, (status = 'open') desc, starts_on desc limit 1`;
    const day = await today(tx, companyId);

    const dates = await tx<{ id: string; starts_on: string; ends_on: string }[]>`select id, starts_on::text, ends_on::text from accounting.v_periods where company_id = ${companyId}`;
    const periodDates = Object.fromEntries(dates.map((d) => [d.id, { from: d.starts_on, to: d.ends_on }]));
    const periodOptions = [...periods].reverse().map((p) => ({ value: p.id, label: periodName(p.startsOn, locale) }));
    for (const name of names) {
      if (PERIOD_PARAMS.has(name) && json.properties![name]!.format === "uuid") {
        paramOptions[name] = periodOptions;
        if (now?.id) defaults[name] = now.id;
      }
    }
    if (has("from") && json.properties!.from!.format === "date" && now?.starts_on) defaults.from = now.starts_on;
    if (has("to") && json.properties!.to!.format === "date" && now?.ends_on) defaults.to = now.ends_on;
    if (has("asOf")) defaults.asOf = day;
    if (has("year")) defaults.year = Number(day.slice(0, 4));

    if (has("accountId")) {
      const accounts = await tx<{ id: string; code: string; name: string }[]>`select id, code, name from accounting.v_accounts where company_id = ${companyId} and is_active order by code`;
      paramOptions.accountId = accounts.map((a) => ({ value: a.id, label: `${a.code} · ${a.name}` }));
    }
    if (has("journalId")) {
      const journals = await tx<{ id: string; code: string; name: string }[]>`select id, code, name from accounting.v_journals where company_id = ${companyId} order by code`;
      paramOptions.journalId = journals.map((j) => ({ value: j.id, label: `${j.code} · ${j.name}` }));
    }
    if (has("partyId")) {
      const parties = await tx<{ id: string; document_number: string; legal_name: string }[]>`select id, document_number, legal_name from core.v_parties order by legal_name limit 1000`;
      paramOptions.partyId = parties.map((p) => ({ value: p.id, label: `${p.legal_name} · ${p.document_number}` }));
    }

    const [settings] = await tx<{ use_open_auxiliaries: boolean; use_items: boolean; use_business_units: boolean }[]>`
      select use_open_auxiliaries, use_items, use_business_units from accounting.v_settings where company_id = ${companyId}`;
    for (const [name, dim] of Object.entries(DIMENSION_PARAMS)) {
      if (!has(name)) continue;
      if (dim.setting && settings?.[dim.setting] !== true) {
        hiddenParams.push(name);
        continue;
      }
      const rows = await tx<{ id: string; code: string; name: string }[]>`select id, code, name from ${tx(`accounting.v_${dim.table}`)} where company_id = ${companyId} and kind = 'leaf' order by code`;
      paramOptions[name] = rows.map((r) => ({ value: r.id, label: `${r.code} · ${r.name}` }));
    }
    // The node of a cost center statement is a centro de costo; the node of a dimension detail is of whichever dimension is chosen (all offered, tagged).
    if (def.id === "accounting.cost_center_statement" && has("nodeId")) paramOptions.nodeId = paramOptions.costCenterId ?? (await nodes(tx, companyId, ["cost_centers"]));
    if (def.id === "accounting.dimension_detail" && has("nodeId")) paramOptions.nodeId = await nodes(tx, companyId, Object.values(DIMENSION_LABELS));

    if (has("format")) {
      const year = Number(day.slice(0, 4));
      const pack = countryPack((await tx<{ country_code: string }[]>`select country_code from kernel.companies where id = ${companyId}`)[0]!.country_code).accounting;
      let formats: { format: string }[] = [];
      try {
        formats = pack.exogenaFormats(year);
      } catch {
        formats = [];
      }
      if (formats.length > 0) {
        paramOptions.format = formats.map((f) => ({ value: f.format, label: f.format }));
        defaults.format = formats[0]!.format;
      }
    }
    if (has("kind")) defaults.kind = "receivable";

    return {
      hiddenParams,
      paramOptions,
      defaults,
      periodDates,
      ...(now?.starts_on && now.ends_on ? { period: { from: now.starts_on, to: now.ends_on } } : {}),
    };
  });
}

async function nodes(tx: Tx, companyId: string, tables: readonly string[]): Promise<Option[]> {
  const out: Option[] = [];
  for (const table of tables) {
    const rows = await tx<{ id: string; code: string; name: string }[]>`select id, code, name from ${tx(`accounting.v_${table}`)} where company_id = ${companyId} order by code`;
    out.push(...rows.map((r) => ({ value: r.id, label: `${r.code} · ${r.name}` })));
  }
  return out;
}
