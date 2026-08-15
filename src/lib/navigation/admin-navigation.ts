export type BreadcrumbItem = {
  label: string;
  href?: string;
};

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function safeInternalHref(value: string | null | undefined, fallback: string) {
  const candidate = value?.trim();
  if (!candidate || !candidate.startsWith("/") || candidate.startsWith("//") || candidate.includes("\\") || /[\u0000-\u001f]/.test(candidate)) return fallback;
  return candidate;
}

export function isSafeContextUuid(value: string | null | undefined): value is string {
  return Boolean(value && uuidPattern.test(value));
}

export function appendNavigationContext(href: string, context: { from?: string; contactId?: string }) {
  if (context.from !== "cadastro" || !isSafeContextUuid(context.contactId)) return href;
  const separator = href.includes("?") ? "&" : "?";
  return `${href}${separator}from=cadastro&contactId=${encodeURIComponent(context.contactId)}`;
}
