import type { ReactNode } from "react";
import { getTranslations } from "next-intl/server";
import { BalancesTab, DimensionBalancesTab, linesOf, MovementsTab, PeriodCloseTab, PeriodEntriesTab, PeriodSummaryTab, RuleHistoryTab, type PeriodLite, type RecordTab } from "@erp/ui";
import type { AccountingTabs } from "@/lib/accounting/record-tabs";
import { RuleLinesPanel, RuleTestPanel, SecurityPanel } from "./accounting-tabs";

// The tabs of an accounting master besides Datos (accounting design §8, Task 28), drawn from what `loadAccountingTabs` read as the
// caller. A tab the caller may not have (Seguridad, for anyone but the admin) is simply not there.

type Content = Record<string, Omit<RecordTab, "id">>;

const lite = (p: { id: string; number: number; year: number; startsOn: string }): PeriodLite => ({ id: p.id, number: p.number, year: p.year, startsOn: p.startsOn });

export async function accountingContent(entityId: string, record: Record<string, unknown> & { id: string }, tabs: AccountingTabs, canEdit: boolean): Promise<Content> {
  const t = await getTranslations();
  const out: Content = {};
  const grid = (g: Extract<AccountingTabs, { grid: unknown }>["grid"], extra: Partial<Parameters<typeof MovementsTab>[0]> = {}): ReactNode =>
    g ? (
      <MovementsTab entity={g.entity} title={g.title} columns={g.columns} filters={g.filters} {...extra} />
    ) : (
      <MovementsTab entity="" title="" columns={[]} filters={[]} allowed={false} />
    );

  if (tabs.kind === "account") {
    out.saldos = { content: <BalancesTab periods={(tabs.balances?.periods ?? []).map(lite)} rows={tabs.balances?.rows ?? null} /> };
    out.movimientos = { content: grid(tabs.grid, { sort: [{ field: "date", dir: "asc" }, { field: "number", dir: "asc" }, { field: "line_no", dir: "asc" }] }) };
    if (tabs.security) {
      out.seguridad = { content: <SecurityPanel accountId={record.id} stored={tabs.security.stored} effective={tabs.security.effective} inheritedFrom={tabs.security.inheritedFrom} subjects={tabs.security.subjects} /> };
    }
  } else if (tabs.kind === "dimension") {
    const results = tabs.dimension === "cost_center";
    out[results ? "resultados" : "saldos"] = {
      ...(results ? {} : { label: t("accounting.record.balances_by_account") }),
      content: (
        <DimensionBalancesTab
          mode={results ? "results" : "accounts"}
          periods={(tabs.figures?.periods ?? []).map(lite)}
          accounts={tabs.figures?.accounts ?? []}
          results={tabs.figures?.results ?? []}
          allowed={tabs.figures !== null}
        />
      ),
    };
    out.movimientos = { content: grid(tabs.grid, { sort: [{ field: "date", dir: "asc" }, { field: "number", dir: "asc" }, { field: "line_no", dir: "asc" }] }) };
  } else if (tabs.kind === "period") {
    out.resumen = { content: <PeriodSummaryTab rows={tabs.summary} /> };
    out.comprobantes = {
      content: tabs.grid ? <PeriodEntriesTab entity={tabs.grid.entity} title={tabs.grid.title} columns={tabs.grid.columns} filters={tabs.grid.filters} sort={[{ field: "date", dir: "asc" }]} /> : <PeriodEntriesTab entity="" title="" columns={[]} filters={[]} allowed={false} />,
    };
    out.cierre = {
      count: tabs.checks.length || undefined,
      content: (
        <PeriodCloseTab
          status={String(record.status)}
          closedAt={tabs.closedAt}
          closedBy={tabs.closedBy}
          reopenedCount={Number(record.reopened_count ?? 0)}
          reopenedFor={typeof record.reopened_for === "string" ? record.reopened_for : null}
          checks={tabs.checks}
          history={tabs.history}
        />
      ),
    };
  } else if (tabs.kind === "rule") {
    const template = (record.template as Record<string, unknown> | null) ?? {};
    const lines = linesOf(template);
    out.lineas = { count: lines.length, content: <RuleLinesPanel ruleId={record.id} template={template} lines={lines} roles={tabs.roles} canSave={canEdit} /> };
    out.probar = { content: <RuleTestPanel ruleId={record.id} events={tabs.events} canTest={tabs.canTest} /> };
    out.historial = { content: <RuleHistoryTab changes={tabs.history} /> };
  }
  void entityId;
  return out;
}
