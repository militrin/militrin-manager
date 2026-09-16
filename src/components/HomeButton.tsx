'use client';

import { usePathname } from 'next/navigation';
import { pathRequiresAuth } from '@/lib/auth/middleware-guard';
import { HomeButtonLink } from '@/components/HomeButtonLink';

/**
 * Sem leitura de cookie no servidor: o destino e o recorte mobile seguem o pathname.
 * Rotas autenticadas ja exigem sessao (middleware), entao nao ha flash do
 * botao na Minha Conta / painel. Paginas publicas apontam para `/`.
 */
export function HomeButton() {
  const pathname = usePathname();
  const inAuthenticatedShell = pathRequiresAuth(pathname);
  const href = inAuthenticatedShell ? '/minha-conta' : '/';

  return <HomeButtonLink href={href} hasSessionCookie={inAuthenticatedShell} />;
}
