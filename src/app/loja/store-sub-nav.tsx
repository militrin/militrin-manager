import Link from 'next/link';

const STORE_TABS = [
  ['produtos', 'Produtos', '/loja'],
  ['pedidos', 'Pedidos', '/loja/pedidos'],
] as const;

export function StoreSubNav({ active }: { active: 'produtos' | 'pedidos' }) {
  return (
    <nav className="flex flex-wrap gap-2" aria-label="Áreas da loja">
      {STORE_TABS.map(([code, label, href]) => (
        <Link
          key={code}
          href={href}
          className={`rounded-xl border px-3 py-1.5 text-xs ${active === code ? 'border-emerald-400 bg-emerald-500/10 text-emerald-200' : 'border-slate-700 text-slate-300'}`}
        >
          {label}
        </Link>
      ))}
    </nav>
  );
}
