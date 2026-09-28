const SAFE_SEARCH_ERROR = "Não foi possível realizar a busca. Tente novamente.";

export function sanitizeSearchError(error: unknown) {
  if (error instanceof Error) {
    console.error("[admin-global-search]", error.name);
  } else {
    console.error("[admin-global-search]", "unknown");
  }
  return SAFE_SEARCH_ERROR;
}
