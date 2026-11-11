import { homeKpis } from "./kpis";
import { homeRecent } from "./recent";
import { recommendationDecide, recommendationList } from "./recommendations";

export { activeUsersKpi, aiTokensChart, aiTokensKpi, auditActivityChart, auditActivityKpi, catalogItemSchema, catalogKey, chartSchema, HOME_FEATURE, HOME_HIDDEN_PREF, homeKpis, KERNEL_CHART_PROVIDERS, KERNEL_KPI_PROVIDERS, kpiSchema } from "./kpis";
export type { CatalogItem } from "./kpis";
export { dailyPoints, dailySeries, SERIES_DAYS } from "./series";
export { homeRecent } from "./recent";
export { kpiGridHref } from "./links";
export type { KpiFilter } from "./links";
export { composeMessage, openRecommendations, recommendationDecide, recommendationList, suggestedAction } from "./recommendations";
export type { RecommendationOut } from "./recommendations";
export { makeRecommendations, paramValues, reasonKeyOf, recommendationCloseInput, recommendationParam, recommendationRaiseInput, RECOMMENDATION_PARAMS_MAX } from "./recommend";
export type { RecommendationClose, RecommendationParam, RecommendationRaise, RecommendationsApi } from "./recommend";
export type { SuggestedAction } from "./recommendations";

/** The processes behind the home screen, all of the feature `kernel.home`. */
export const HOME_PROCESSES = [homeKpis, homeRecent, recommendationList, recommendationDecide];
