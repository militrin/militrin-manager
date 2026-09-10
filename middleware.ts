import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';
import { isEmailConfirmed } from '@/lib/account/email-confirmation';
import {
  AUTH_GET_USER_TIMEOUT_MS,
  hasSupabaseAuthCookie,
  pathNeedsUserResolution,
  withTimeout,
} from '@/lib/auth/middleware-guard';
import { sanitizePostFirstAccessNextPath } from '@/lib/utils/safe-navigation';

function getSupabaseKey() {
  return process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '';
}

function middlewareRequestId(request: NextRequest) {
  return request.headers.get('x-vercel-id') ?? request.headers.get('x-request-id') ?? 'local';
}

export async function middleware(request: NextRequest) {
  const startedAt = Date.now();
  const { pathname, search } = request.nextUrl;
  const requestId = middlewareRequestId(request);
  const response = NextResponse.next({ request: { headers: request.headers } });

  // Nomes preservados para testes que leem o fonte do middleware.
  const protectedPrefixes = [
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
  ];
  const isPublicFirstAccessResend = pathname === '/primeiro-acesso/reenviar';
  const requiresAuth = protectedPrefixes.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`)) && !isPublicFirstAccessResend;
  const publicMetaCallbackPaths = new Set([
    '/api/instagram/oauth/callback',
    '/api/instagram/deauthorize',
    '/api/instagram/data-deletion',
  ]);
  const isPublicMetaCallback = publicMetaCallbackPaths.has(pathname);
  const protectedApiPrefixes = [
    '/api/ingressos',
    '/api/inscricao',
    '/api/instagram',
    '/api/loja',
    '/api/relatorios',
  ];
  const isProtectedApi = !isPublicMetaCallback && protectedApiPrefixes.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));

  const loginRedirect = request.nextUrl.clone();
  loginRedirect.pathname = '/entrar';
  loginRedirect.search = '';

  let user: { email?: string | null; email_confirmed_at?: string | null } | null = null;
  let authMs = 0;
  let authStatus: 'ok' | 'skip_no_cookie' | 'skip_public' | 'timeout' | 'error' = 'skip_public';
  let authUnresolved = false;

  const needsUser = pathNeedsUserResolution(pathname);
  const hasAuthCookie = hasSupabaseAuthCookie(request.cookies.getAll().map((cookie) => cookie.name));

  if (needsUser && hasAuthCookie) {
    const supabase = createServerClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL ?? '',
      getSupabaseKey(),
      {
        cookies: {
          getAll() {
            return request.cookies.getAll();
          },
          setAll(cookiesToSet) {
            cookiesToSet.forEach(({ name, value, options }) => {
              response.cookies.set(name, value, options);
            });
          },
        },
      },
    );
    const authStarted = Date.now();
    try {
      const raced = await withTimeout(supabase.auth.getUser(), AUTH_GET_USER_TIMEOUT_MS);
      authMs = Date.now() - authStarted;
      if (!raced.ok) {
        authStatus = 'timeout';
        authUnresolved = true;
      } else {
        user = raced.value.data.user ?? null;
        authStatus = 'ok';
      }
    } catch {
      authMs = Date.now() - authStarted;
      authStatus = 'error';
      authUnresolved = true;
    }
  } else if (needsUser) {
    authStatus = 'skip_no_cookie';
  }

  let decision = 'next';

  if (requiresAuth && !user) {
    if (authUnresolved) {
      decision = 'next_auth_unresolved';
    } else {
      loginRedirect.searchParams.set('next', `${pathname}${search}`);
      decision = 'login';
      console.info(JSON.stringify({
        src: 'middleware',
        requestId,
        path: pathname,
        authStatus,
        authMs,
        totalMs: Date.now() - startedAt,
        decision,
      }));
      return NextResponse.redirect(loginRedirect);
    }
  }

  if ((requiresAuth || isProtectedApi) && user && !isEmailConfirmed(user)) {
    const confirmationRedirect = request.nextUrl.clone();
    confirmationRedirect.pathname = '/verifique-seu-email';
    confirmationRedirect.search = '';
    if (user.email) confirmationRedirect.searchParams.set('email', user.email);
    decision = 'confirm_email';
    console.info(JSON.stringify({
      src: 'middleware',
      requestId,
      path: pathname,
      authStatus,
      authMs,
      totalMs: Date.now() - startedAt,
      decision,
    }));
    return NextResponse.redirect(confirmationRedirect);
  }

  if (pathname === '/entrar' && user) {
    if (!isEmailConfirmed(user)) {
      const confirmationRedirect = request.nextUrl.clone();
      confirmationRedirect.pathname = '/verifique-seu-email';
      confirmationRedirect.search = '';
      if (user.email) confirmationRedirect.searchParams.set('email', user.email);
      decision = 'confirm_email';
      console.info(JSON.stringify({
        src: 'middleware',
        requestId,
        path: pathname,
        authStatus,
        authMs,
        totalMs: Date.now() - startedAt,
        decision,
      }));
      return NextResponse.redirect(confirmationRedirect);
    }
    const destination = sanitizePostFirstAccessNextPath(request.nextUrl.searchParams.get('next'), '/minha-conta');
    decision = 'leave_entrar';
    console.info(JSON.stringify({
      src: 'middleware',
      requestId,
      path: pathname,
      authStatus,
      authMs,
      totalMs: Date.now() - startedAt,
      decision,
    }));
    return NextResponse.redirect(new URL(destination, request.url));
  }

  console.info(JSON.stringify({
    src: 'middleware',
    requestId,
    path: pathname,
    authStatus,
    authMs,
    totalMs: Date.now() - startedAt,
    decision,
  }));
  return response;
}

export const config = {
  matcher: [
    '/entrar',
    '/minha-conta',
    '/minha-conta/:path*',
    '/inscricao',
    '/inscricao/:path*',
    '/painel',
    '/painel/:path*',
    '/importacoes',
    '/importacoes/:path*',
    '/primeiro-acesso',
    '/primeiro-acesso/:path*',
    '/inscricoes',
    '/inscricoes/:path*',
    '/operacoes',
    '/operacoes/:path*',
    '/ingressos',
    '/ingressos/:path*',
    '/cadastros',
    '/cadastros/:path*',
    '/retirada',
    '/retirada/:path*',
    '/camisetas',
    '/camisetas/:path*',
    '/categorias',
    '/categorias/:path*',
    '/lotes',
    '/lotes/:path*',
    '/cupons',
    '/cupons/:path*',
    '/financeiro',
    '/financeiro/:path*',
    '/configuracao',
    '/configuracao/:path*',
    '/configuracoes',
    '/configuracoes/:path*',
    '/plataforma',
    '/plataforma/:path*',
    '/pedidos',
    '/pedidos/:path*',
    '/relatorios',
    '/relatorios/:path*',
    '/sorteios',
    '/sorteios/:path*',
    '/notificacoes',
    '/notificacoes/:path*',
    '/api/ingressos',
    '/api/ingressos/:path*',
    '/api/inscricao',
    '/api/inscricao/:path*',
    '/api/instagram',
    '/api/instagram/:path*',
    '/api/loja',
    '/api/loja/:path*',
    '/api/relatorios',
    '/api/relatorios/:path*',
  ],
};
