'use client';

import { useEffect, useState } from 'react';
import { getCartOrderDetailsAction, changePendingOrderItemShirtAction } from '../actions';
import { buildShirtInventoryVariants, shirtDisplayLabel, type ShirtInventorySourceRow } from '@/lib/constants/shirts';

type EditableTicketItem = {
  order_item_id: string;
  item_kind: 'ticket' | 'product';
  status: string;
  category_name: string | null;
  batch_name: string | null;
  shirt_type: string | null;
  shirt_size: string | null;
  holder_full_name: string | null;
  unit_price: number;
};

type CartDetails = {
  order_id: string;
  items: EditableTicketItem[];
};

function money(value: number) {
  return value.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

/**
 * Etapa 1 do wizard quando ?editOrder=<orderId> esta ativo. Nunca cria
 * pedido -- so hidrata os ingressos JA EXISTENTES do mesmo order_id (via
 * get_cart_order_details, a mesma fonte que o CartStep usa) e deixa trocar
 * camiseta/tamanho por ingresso (change_pending_order_item_shirt). Quantidade
 * de ingressos fica bloqueada nesta primeira versao de edicao -- so mostra
 * quantos existem.
 */
export function EditTicketsStep({
  orderId,
  inventory,
  enforcePhysicalStock,
  onContinue,
}: {
  orderId: string;
  inventory: ShirtInventorySourceRow[];
  enforcePhysicalStock: boolean;
  onContinue: () => void;
}) {
  const [cart, setCart] = useState<CartDetails | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyItemId, setBusyItemId] = useState<string | null>(null);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  useEffect(() => {
    let active = true;
    (async () => {
      const result = await getCartOrderDetailsAction(orderId);
      if (!active) return;
      if (result.success) setCart(result.cart as unknown as CartDetails);
      setLoading(false);
    })();
    return () => { active = false; };
  }, [orderId]);

  const shirtVariants = buildShirtInventoryVariants(inventory);

  async function handleShirtChange(item: EditableTicketItem, shirtType: string, shirtSize: string) {
    setBusyItemId(item.order_item_id);
    setMessage(null);
    const result = await changePendingOrderItemShirtAction(orderId, item.order_item_id, shirtType, shirtSize);
    setBusyItemId(null);
    if (!result.success) { setMessage({ type: 'error', text: result.message }); return; }
    setCart(result.cart as unknown as CartDetails);
    setMessage({ type: 'success', text: 'Camiseta atualizada.' });
  }

  if (loading) return <p className="text-sm text-slate-400">Carregando ingressos do pedido...</p>;
  if (!cart) return <p className="text-sm text-rose-300">Não foi possível carregar os ingressos deste pedido.</p>;

  const ticketItems = cart.items.filter((item) => item.item_kind === 'ticket');

  return (
    <div className="space-y-4">
      <h2 className="text-lg font-semibold">1. Editar ingressos</h2>
      <p className="text-sm text-slate-400">
        {ticketItems.length} ingresso{ticketItems.length === 1 ? '' : 's'} neste pedido. A quantidade não pode ser
        alterada por aqui — apenas a configuração de cada ingresso já existente.
      </p>

      {message ? (
        <div className={`rounded-xl border px-3 py-2 text-sm ${message.type === 'success' ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-200' : 'border-red-500/30 bg-red-500/10 text-red-200'}`}>
          {message.text}
        </div>
      ) : null}

      <div className="space-y-3">
        {ticketItems.map((item, index) => {
          const busy = busyItemId === item.order_item_id;
          return (
            <div key={item.order_item_id} className="rounded-2xl border border-slate-700 bg-slate-950 p-4 text-sm text-slate-200">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-slate-100">
                    Ingresso {index + 1}{item.category_name ? ` — ${item.category_name}` : ''}
                  </p>
                  <p className="mt-1 text-xs text-slate-400">
                    {item.holder_full_name ? `Titular: ${item.holder_full_name}` : 'Titular ainda não definido'}
                  </p>
                  {item.batch_name ? <p className="text-xs text-slate-500">{item.batch_name}</p> : null}
                </div>
                <p className="shrink-0 text-sm font-semibold text-slate-100">{money(item.unit_price)}</p>
              </div>

              <div className="mt-3">
                <label className="space-y-1">
                  <span className="text-xs text-slate-300">Camiseta</span>
                  <select
                    value={item.shirt_type && item.shirt_size ? `${item.shirt_type}::${item.shirt_size}` : ''}
                    disabled={busy}
                    onChange={(e) => {
                      const [nextType, nextSize] = e.target.value.split('::');
                      if (nextType && nextSize) void handleShirtChange(item, nextType, nextSize);
                    }}
                    className="h-10 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 text-sm disabled:opacity-50"
                  >
                    <option value="">Selecione</option>
                    {shirtVariants.map((variant) => {
                      const isCurrentSelection = variant.shirt_type === item.shirt_type && variant.shirt_size === item.shirt_size;
                      const outOfStock = enforcePhysicalStock && variant.available_quantity <= 0 && !isCurrentSelection;
                      return (
                        <option key={variant.id} value={`${variant.shirt_type}::${variant.shirt_size}`} disabled={outOfStock}>
                          {shirtDisplayLabel(variant.shirt_type)} · {variant.shirt_size}{outOfStock ? ' (sem estoque)' : ''}
                        </option>
                      );
                    })}
                  </select>
                </label>
              </div>
            </div>
          );
        })}
      </div>

      <div className="flex justify-end">
        <button
          type="button"
          onClick={onContinue}
          className="h-11 rounded-2xl bg-emerald-500 px-6 text-sm font-semibold text-emerald-950"
        >
          Voltar ao carrinho
        </button>
      </div>
    </div>
  );
}
