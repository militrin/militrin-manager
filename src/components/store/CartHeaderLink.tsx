'use client';

import Link from 'next/link';
import { ShoppingCart } from 'lucide-react';
import { useStoreCart } from '@/lib/store/cart-context';

export function CartHeaderLink() {
  const { totalCount } = useStoreCart();

  return (
    <Link
      href="/minha-conta/carrinho"
      aria-label="Carrinho de compras"
      className="relative flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl border border-slate-800 bg-slate-900/70 text-slate-200 transition hover:border-(--brand-400)/40 hover:bg-slate-900"
    >
      <ShoppingCart size={18} />
      {totalCount > 0 ? (
        <span className="absolute -right-1.5 -top-1.5 flex h-5 min-w-5 items-center justify-center rounded-full bg-(--brand-500) px-1 text-[10px] font-bold text-white">
          {totalCount > 99 ? '99+' : totalCount}
        </span>
      ) : null}
    </Link>
  );
}

export function MobileCartLink({ active = false }: { active?: boolean }) {
  const { totalCount } = useStoreCart();

  return (
    <Link href="/minha-conta/carrinho" className={`relative flex flex-col items-center gap-1 rounded-xl px-2 py-2 ${active ? 'bg-(--brand-500)/15 font-semibold text-(--brand-200)' : 'text-slate-200'}`}>
      <ShoppingCart size={15} />
      Carrinho
      {totalCount > 0 ? (
        <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-(--brand-500) px-1 text-[9px] font-bold text-white">
          {totalCount > 99 ? '99+' : totalCount}
        </span>
      ) : null}
    </Link>
  );
}

export function CartNavLink({ active = false }: { active?: boolean }) {
  const { totalCount } = useStoreCart();

  return (
    <Link
      href="/minha-conta/carrinho"
      className={`flex items-center justify-between rounded-2xl border px-4 py-3 transition ${
        active
          ? 'border-(--brand-400)/50 bg-(--brand-500)/15 font-semibold text-(--brand-100) hover:bg-(--brand-500)/25'
          : 'border-slate-800 bg-slate-900/70 text-slate-200 hover:border-(--brand-400)/40 hover:bg-slate-900'
      }`}
    >
      <span className="flex items-center gap-3">
        <ShoppingCart size={16} />
        Carrinho de Compras
      </span>
      {totalCount > 0 ? (
        <span className={`flex h-5 min-w-5 items-center justify-center rounded-full px-1.5 text-[10px] font-bold text-white ${active ? 'bg-(--brand-600)' : 'bg-(--brand-500)'}`}>
          {totalCount > 99 ? '99+' : totalCount}
        </span>
      ) : null}
    </Link>
  );
}
