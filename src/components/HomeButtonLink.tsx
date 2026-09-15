'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Home } from 'lucide-react';

type HomeButtonLinkProps = {
  href: string;
  hasSessionCookie: boolean;
};

export function HomeButtonLink({ href, hasSessionCookie }: HomeButtonLinkProps) {
  const pathname = usePathname();
  if (pathname === '/') return null;

  return (
    <Link
      href={href}
      aria-label="Página inicial"
      title="Página inicial"
      className={`fixed z-50 ${hasSessionCookie ? 'hidden lg:flex' : 'flex'} h-10 w-10 items-center justify-center rounded-full border border-slate-700/80 bg-slate-950/80 text-slate-200 shadow-lg shadow-black/30 backdrop-blur transition hover:border-emerald-400/60 hover:text-emerald-200 motion-reduce:transition-none`}
      style={{ top: 'max(0.75rem, calc(var(--safe-top) + 0.5rem))', left: '0.75rem' }}
    >
      <Home size={18} />
    </Link>
  );
}
