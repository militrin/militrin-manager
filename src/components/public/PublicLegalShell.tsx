import type { ReactNode } from 'react';
import Link from 'next/link';
import { PublicBrandMark } from '@/components/public/PublicBrandMark';
import { PublicSiteFooter } from '@/components/public/PublicSiteFooter';
import { militrinTokens } from '@/components/militrin/tokens';
import { cx } from '@/components/militrin/utils';

type PublicLegalShellProps = {
  eyebrow?: string;
  title: string;
  intro: string;
  children: ReactNode;
};

export function PublicLegalShell({ eyebrow = 'Militrin', title, intro, children }: PublicLegalShellProps) {
  return (
    <main className="flex min-h-screen flex-col bg-[radial-gradient(circle_at_top_left,_var(--brand-glow),_transparent_35%),linear-gradient(180deg,_#020617,_#0b1220)] px-4 py-6 text-slate-100 sm:px-6">
      <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col">
        <section className={cx('p-6 shadow-2xl shadow-black/20 sm:p-10', militrinTokens.radius, militrinTokens.surface)}>
          <div className="flex items-center gap-3">
            <div className="relative h-12 w-12 shrink-0 overflow-hidden rounded-2xl bg-black ring-1 ring-(--brand-500)/40 shadow-lg shadow-(--brand-600)/20">
              <div aria-hidden className="mask-logo absolute inset-0.5" />
            </div>
            <div className="min-w-0 space-y-1">
              <PublicBrandMark />
              <p className="text-sm font-semibold text-white">Militrin</p>
            </div>
          </div>

          <p className={cx('mt-6', militrinTokens.eyebrow)}>{eyebrow}</p>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight text-white sm:text-4xl">{title}</h1>
          <p className="mt-3 max-w-2xl text-sm leading-6 text-slate-300 sm:text-base">{intro}</p>

          <div className="mt-8 space-y-8 text-sm leading-7 text-slate-300 sm:text-[0.95rem]">{children}</div>

          <p className="mt-10 text-xs text-slate-500">
            <Link href="/" className={cx('rounded-sm text-slate-400 transition hover:text-slate-200', militrinTokens.focusRing)}>
              Voltar ao início
            </Link>
          </p>
        </section>
        <PublicSiteFooter />
      </div>
    </main>
  );
}
