import { sanitizeInternalNextPath } from '@/lib/utils/safe-navigation';

// Allowlist explicita de destinos pos-verificacao de link de e-mail --
// nunca abrir pra qualquer path (sanitizeInternalNextPath so evita open-
// redirect pra fora do site, nao decide se o destino faz sentido aqui).
// Compartilhada entre /auth/callback (cliente, fallback legado) e
// /auth/confirm (servidor, caminho oficial recomendado pelo Supabase para
// SSR) -- uma unica fonte de verdade, nunca duas listas divergentes.
export const ALLOWED_AUTH_DESTINATION_PREFIXES = ['/primeiro-acesso', '/redefinir-senha'];

export function safeAuthDestination(value: string | null | undefined, fallback = '/primeiro-acesso') {
  const safe = sanitizeInternalNextPath(value, fallback);
  const isAllowed = ALLOWED_AUTH_DESTINATION_PREFIXES.some(
    (prefix) => safe === prefix || safe.startsWith(`${prefix}?`),
  );
  return isAllowed ? safe : fallback;
}
