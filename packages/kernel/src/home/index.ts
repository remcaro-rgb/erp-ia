import { homeKpis } from "./kpis";
import { homeRecent } from "./recent";
import { recommendationDecide, recommendationList } from "./recommendations";

export { activeUsersKpi, aiTokensChart, aiTokensKpi, auditActivityChart, auditActivityKpi, catalogItemSchema, catalogKey, chartSchema, HOME_FEATURE, HOME_HIDDEN_PREF, homeKpis, KERNEL_CHART_PROVIDERS, KERNEL_KPI_PROVIDERS, kpiSchema } from "./kpis";
export type { CatalogItem } from "./kpis";
export { dailyPoints, dailySeries, SERIES_DAYS } from "./series";
export { homeRecent } from "./recent";
export { kpiGridHref } from "./links";
export type { KpiFilter } from "./links";
export { recommendationDecide, recommendationList, suggestedAction } from "./recommendations";
export type { SuggestedAction } from "./recommendations";

/** The processes behind the home screen, all of the feature `kernel.home`. */
export const HOME_PROCESSES = [homeKpis, homeRecent, recommendationList, recommendationDecide];
