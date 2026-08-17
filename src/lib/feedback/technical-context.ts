// Extrai um "slug de evento" plausivel de rotas conhecidas (contact-first: o
// backend nunca aceita um event_id direto do client -- so este slug, que o
// RPC submit_user_feedback resolve para um id real e existente, ou ignora).
const EVENT_SLUG_ROUTE_PATTERNS = [
  /^\/eventos\/([^/]+)/,
  /^\/inscricao\/([^/]+)/,
  /^\/minha-conta\/comprar\/([^/]+)/,
];

export function extractEventSlugFromPath(pathname: string): string | null {
  const path = (pathname ?? '').trim();
  for (const pattern of EVENT_SLUG_ROUTE_PATTERNS) {
    const match = path.match(pattern);
    if (match?.[1]) return decodeURIComponent(match[1]);
  }
  return null;
}

export type FeedbackTechnicalContext = {
  url: string;
  userAgent: string;
  viewport: { width: number; height: number };
  timezoneOffsetMinutes: number;
  language: string;
};

export function buildFeedbackTechnicalContext(): FeedbackTechnicalContext {
  return {
    url: window.location.href,
    userAgent: navigator.userAgent,
    viewport: { width: window.innerWidth, height: window.innerHeight },
    timezoneOffsetMinutes: new Date().getTimezoneOffset(),
    language: navigator.language,
  };
}
