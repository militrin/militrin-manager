import { sanitizeInternalNextPath } from '../utils/safe-navigation';
import { inviteIdFromInternalPath } from '../account/first-access-invite-url';

// Allowlist explicita de destinos pos-verificacao de link de e-mail --
// nunca abrir pra qualquer path (sanitizeInternalNextPath so evita open-
// redirect pra fora do site, nao decide se o destino faz sentido aqui).
// Compartilhada entre /auth/callback (cliente, fallback legado) e
// /auth/confirm (servidor, caminho oficial recomendado pelo Supabase para
// SSR) -- uma unica fonte de verdade, nunca duas listas divergentes.
export const ALLOWED_AUTH_DESTINATION_PREFIXES = ['/primeiro-acesso', '/redefinir-senha'];

const AUTH_WRAPPER_PATHS = new Set(['/auth/callback', '/auth/confirm', '/auth/confirmar']);

function isAllowedAppHost(hostname: string) {
  const host = hostname.toLowerCase();
  return host === 'localhost'
    || host === '127.0.0.1'
    || host === 'www.militrin.com.br'
    || host === 'militrin.com.br';
}

function decodeUntilStable(value: string) {
  let current = value;
  for (let index = 0; index < 3; index += 1) {
    try {
      const decoded = decodeURIComponent(current);
      if (decoded === current) break;
      current = decoded;
    } catch {
      break;
    }
  }
  return current;
}

export function unwrapAuthDestination(value: string | null | undefined): string | null {
  const raw = decodeUntilStable(String(value ?? '').trim());
  if (!raw) return null;

  let pathWithSearch = raw;
  if (/^https?:\/\//i.test(raw)) {
    try {
      const absolute = new URL(raw);
      if (!isAllowedAppHost(absolute.hostname)) return null;
      pathWithSearch = `${absolute.pathname}${absolute.search}${absolute.hash}`;
    } catch {
      return null;
    }
  }
  if (!pathWithSearch.startsWith('/') || pathWithSearch.startsWith('//')) return null;

  try {
    const parsed = new URL(pathWithSearch, 'http://localhost');
    if (AUTH_WRAPPER_PATHS.has(parsed.pathname)) {
      const inner = parsed.searchParams.get('next');
      if (inner) return unwrapAuthDestination(inner);
    }
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return pathWithSearch;
  }
}

export function safeAuthDestination(value: string | null | undefined, fallback = '/primeiro-acesso') {
  const unwrapped = unwrapAuthDestination(value) ?? String(value ?? '');
  const safe = sanitizeInternalNextPath(unwrapped, fallback);
  const isAllowed = ALLOWED_AUTH_DESTINATION_PREFIXES.some(
    (prefix) => safe === prefix || safe.startsWith(`${prefix}?`),
  );
  return isAllowed ? safe : fallback;
}

export function inviteIdFromAuthDestination(value: string | null | undefined) {
  return inviteIdFromInternalPath(safeAuthDestination(value, '/primeiro-acesso'));
}
