export { classifyAdminSearchQuery, escapeIlikePattern, nameMatchesQuery, phoneDigitsMatch, globalSearchPlan } from "./classify.ts";
export { flattenSearchHits } from "./present.ts";
export { GLOBAL_SEARCH_DEBOUNCE_MS, GLOBAL_SEARCH_GROUP_LIMIT, GLOBAL_SEARCH_NAME_MIN_CHARS } from "./constants.ts";
export type { ClassifiedAdminQuery, GlobalSearchResult, GlobalSearchHit, GlobalSearchGroup } from "./types.ts";
