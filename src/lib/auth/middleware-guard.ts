export const AUTH_GET_USER_TIMEOUT_MS = 4000;

export const PROTECTED_PAGE_PREFIXES = [
  '/minha-conta',
  '/inscricao',
  '/painel',
  '/importacoes',
  '/primeiro-acesso',
  '/inscricoes',
  '/operacoes',
  '/ingressos',
  '/cadastros',
  '/retirada',
  '/camisetas',
  '/categorias',
  '/lotes',
  '/cupons',
  '/financeiro',
  '/configuracao',
  '/configuracoes',
  '/plataforma',
  '/pedidos',
  '/relatorios',
  '/sorteios',
  '/notificacoes',
] as const;

export const PROTECTED_API_PREFIXES = [
  '/api/ingressos',
  '/api/inscricao',
  '/api/instagram',
  '/api/loja',
  '/api/relatorios',
] as const;

export const PUBLIC_META_CALLBACK_PATHS = [
  '/api/instagram/oauth/callback',
  '/api/instagram/deauthorize',
  '/api/instagram/data-deletion',
] as const;

const STATIC_FILE_EXTENSION = /\.(?:svg|png|jpe?g|gif|webp|ico|woff2?|ttf|otf|eot|txt|xml|json|webmanifest|map|css|js)$/i;

export function matchesPrefix(pathname: string, prefix: string) {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

export function isPublicFirstAccessResend(pathname: string) {
  return pathname === '/primeiro-acesso/reenviar';
}

export function isPublicMetaCallback(pathname: string) {
  return (PUBLIC_META_CALLBACK_PATHS as readonly string[]).includes(pathname);
}

export function pathRequiresAuth(pathname: string) {
  return (PROTECTED_PAGE_PREFIXES as readonly string[]).some((prefix) => matchesPrefix(pathname, prefix))
    && !isPublicFirstAccessResend(pathname);
}

export function pathIsProtectedApi(pathname: string) {
  return !isPublicMetaCallback(pathname)
    && (PROTECTED_API_PREFIXES as readonly string[]).some((prefix) => matchesPrefix(pathname, prefix));
}

export function pathNeedsUserResolution(pathname: string) {
  return pathRequiresAuth(pathname) || pathIsProtectedApi(pathname) || pathname === '/entrar';
}

export function isStaticOrAssetPath(pathname: string) {
  if (pathname.startsWith('/_next/static') || pathname.startsWith('/_next/image')) return true;
  if (pathname === '/favicon.ico') return true;
  return STATIC_FILE_EXTENSION.test(pathname);
}

export function hasSupabaseAuthCookie(cookieNames: Iterable<string>) {
  return [...cookieNames].some((name) => /^sb-.*-auth-token(?:\.\d+)?$/.test(name));
}

export async function withTimeout<T>(thenable: PromiseLike<T>, ms: number): Promise<{ ok: true; value: T } | { ok: false; reason: 'timeout' }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve(thenable).then((value) => ({ ok: true as const, value })),
      new Promise<{ ok: false; reason: 'timeout' }>((resolve) => {
        timer = setTimeout(() => resolve({ ok: false, reason: 'timeout' }), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
