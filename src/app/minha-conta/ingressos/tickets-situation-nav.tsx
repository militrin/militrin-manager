import Link from 'next/link';
import { cx, militrinType } from '@/components/militrin';

export function AccountTicketsSituationNav({
  view,
  activeCount,
  archivedCount,
}: {
  view: 'ativos' | 'anteriores';
  activeCount: number;
  archivedCount: number;
}) {
  const tabs = [
    {
      id: 'ativos' as const,
      href: '/minha-conta/ingressos',
      label: activeCount === 1 ? 'Acessos ativos (1)' : `Acessos ativos (${activeCount})`,
    },
    {
      id: 'anteriores' as const,
      href: '/minha-conta/ingressos?ver=anteriores',
      label: archivedCount === 1 ? 'Anteriores e inativos (1)' : `Anteriores e inativos (${archivedCount})`,
    },
  ];

  return (
    <nav className="flex flex-wrap gap-2" aria-label="Situação dos acessos">
      {tabs.map((tab) => {
        const selected = view === tab.id;
        return (
          <Link
            key={tab.id}
            href={tab.href}
            aria-current={selected ? 'page' : undefined}
            className={cx(
              'inline-flex rounded-full border px-3 py-1.5 text-xs font-semibold transition',
              selected
                ? 'border-emerald-400/60 bg-emerald-500/15 text-emerald-100'
                : 'border-slate-700 bg-slate-950/60 text-slate-300 hover:border-slate-500',
            )}
          >
            {tab.label}
          </Link>
        );
      })}
      <p className={cx('sr-only', militrinType.micro)}>
        {view === 'ativos' ? 'Mostrando acessos ativos.' : 'Mostrando acessos anteriores e inativos.'}
      </p>
    </nav>
  );
}
