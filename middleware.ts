import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';
import { isEmailConfirmed } from '@/lib/account/email-confirmation';
import { sanitizePostFirstAccessNextPath } from '@/lib/utils/safe-navigation';

function getSupabaseKey() {
  return process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '';
}

export async function middleware(request: NextRequest) {
  const response = NextResponse.next({ request: { headers: request.headers } });
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

  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { pathname, search } = request.nextUrl;
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
  ];
  const requiresAuth = protectedPrefixes.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
  const protectedApiPrefixes = [
    '/api/ingressos',
    '/api/inscricao',
    '/api/instagram',
    '/api/loja',
    '/api/relatorios',
  ];
  const isProtectedApi = protectedApiPrefixes.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));

  const loginRedirect = request.nextUrl.clone();
  loginRedirect.pathname = '/entrar';
  loginRedirect.search = '';

  if (requiresAuth && !user) {
    loginRedirect.searchParams.set('next', `${pathname}${search}`);
    return NextResponse.redirect(loginRedirect);
  }

  if ((requiresAuth || isProtectedApi) && user && !isEmailConfirmed(user)) {
    const confirmationRedirect = request.nextUrl.clone();
    confirmationRedirect.pathname = '/verifique-seu-email';
    confirmationRedirect.search = '';
    if (user.email) confirmationRedirect.searchParams.set('email', user.email);
    return NextResponse.redirect(confirmationRedirect);
  }

  if (pathname === '/entrar' && user) {
    if (!isEmailConfirmed(user)) {
      const confirmationRedirect = request.nextUrl.clone();
      confirmationRedirect.pathname = '/verifique-seu-email';
      confirmationRedirect.search = '';
      if (user.email) confirmationRedirect.searchParams.set('email', user.email);
      return NextResponse.redirect(confirmationRedirect);
    }
    const destination = sanitizePostFirstAccessNextPath(request.nextUrl.searchParams.get('next'), '/minha-conta');
    return NextResponse.redirect(new URL(destination, request.url));
  }

  return response;
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
