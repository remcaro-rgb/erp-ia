import { homeKpis } from "./kpis";
import { homeRecent } from "./recent";
import { recommendationDecide, recommendationList } from "./recommendations";

export { aiTokensKpi, HOME_FEATURE, homeKpis, KERNEL_KPI_PROVIDERS, kpiSchema } from "./kpis";
export { dailySeries, SERIES_DAYS } from "./series";
export { homeRecent } from "./recent";
export { kpiGridHref } from "./links";
export type { KpiFilter } from "./links";
export { recommendationDecide, recommendationList, suggestedAction } from "./recommendations";
export type { SuggestedAction } from "./recommendations";

/** The processes behind the home screen, all of the feature `kernel.home`. */
export const HOME_PROCESSES = [homeKpis, homeRecent, recommendationList, recommendationDecide];
