'use client';

import { useEffect, useRef, useState } from 'react';
import { getCartOrderDetailsAction, changePendingOrderItemShirtAction, changePendingOrderItemGenderAction } from '../actions';
import { buildShirtInventoryVariants, shirtDisplayLabel, type ShirtInventorySourceRow } from '@/lib/constants/shirts';

type PricingGender = 'male' | 'female';

type EditableTicketItem = {
  order_item_id: string;
  item_kind: 'ticket' | 'product';
  status: string;
  category_name: string | null;
  batch_name: string | null;
  shirt_type: string | null;
  shirt_size: string | null;
  pricing_gender: PricingGender | null;
  holder_full_name: string | null;
  unit_price: number;
};

type CartDetails = {
  order_id: string;
  items: EditableTicketItem[];
};

type PendingShirt = { type: string; size: string };

function money(value: number) {
  return value.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function genderLabel(gender: PricingGender | '' | null | undefined) {
  if (gender === 'male') return 'Masculino';
  if (gender === 'female') return 'Feminino';
  return null;
}

/**
 * Etapa 1 do wizard quando ?editOrder=<orderId> esta ativo. Nunca cria
 * pedido -- so hidrata os ingressos JA EXISTENTES do mesmo order_id (via
 * get_cart_order_details, a mesma fonte que o CartStep usa) e deixa trocar
 * genero/camiseta/tamanho por ingresso. Quantidade de ingressos fica
 * bloqueada nesta versao de edicao -- so mostra quantos existem.
 *
 * Tres selects INDEPENDENTES -- nunca um so campo escondendo os tres:
 *
 *  - Genero do ingresso: controla PRECO (registration_batches.male_price/
 *    female_price do MESMO lote ja travado no item). Editar aqui chama
 *    change_pending_order_item_gender, que recalcula unit_price do item e
 *    reaplica o cupom/total do pedido (invalida PIX se o total mudar).
 *    Hidratado de item.pricing_gender -- coluna propria em order_items
 *    (migration 20260846000000). Pedidos criados ANTES dessa migration tem
 *    pricing_gender null ("nao definido"): NUNCA inferido de shirt_type, o
 *    comprador precisa escolher explicitamente antes de poder salvar.
 *  - Tipo de camiseta + Tamanho: NUNCA afetam preco neste schema (ver
 *    change_pending_order_item_shirt) -- so trocam a reserva de estoque.
 *    Trocar o tipo troca a lista de tamanhos e so mantem o tamanho
 *    selecionado se ele existir no novo tipo; caso contrario o tamanho e
 *    limpo e uma nova escolha e exigida antes de poder salvar.
 *
 * As opcoes de tipo/tamanho vem sempre de `inventory` (shirt_inventory do
 * evento) -- nunca hardcoded -- e shirtDisplayLabel nunca embute genero no
 * rotulo (Camiseta/Babylook sao modelos, nao generos: qualquer combinacao
 * configurada no evento e valida, ex. Babylook + genero masculino).
 */
export function EditTicketsStep({
  orderId,
  inventory,
  enforcePhysicalStock,
  focusItemId,
  onContinue,
}: {
  orderId: string;
  inventory: ShirtInventorySourceRow[];
  enforcePhysicalStock: boolean;
  /** order_item_id a rolar/destacar assim que os ingressos carregarem --
   * setado pelo wizard quando o comprador clica num card de ingresso no
   * carrinho (CartStep). null = nenhum foco especifico. */
  focusItemId?: string | null;
  onContinue: () => void;
}) {
  const [cart, setCart] = useState<CartDetails | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyItemId, setBusyItemId] = useState<string | null>(null);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  // Selecao em edicao (ainda nao salva) por ingresso -- separada do valor
  // persistido em cart.items, pra trocar o tipo sem disparar a RPC antes do
  // tamanho correspondente ser escolhido.
  const [pendingByItem, setPendingByItem] = useState<Record<string, PendingShirt>>({});
  // Genero pendente por ingresso -- estado PROPRIO, separado do de
  // camiseta/tamanho: sao duas RPCs diferentes com efeitos diferentes
  // (genero recalcula preco; camiseta nunca recalcula).
  const [pendingGenderByItem, setPendingGenderByItem] = useState<Record<string, PricingGender | ''>>({});
  const [highlightedItemId, setHighlightedItemId] = useState<string | null>(null);
  const itemRefs = useRef<Record<string, HTMLDivElement | null>>({});

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

  // Inicializa a selecao pendente de cada ingresso a partir do valor
  // persistido, sem sobrescrever uma edicao ja em andamento (ex.: apos salvar
  // um outro item e o cart recarregar). So preenche entradas ainda ausentes.
  // setState adiado pra macrotask (mesmo padrao ja usado no wizard pai) pra
  // nao disparar o lint de cascading render por setState sincrono no corpo
  // do effect.
  useEffect(() => {
    if (!cart) return;
    const timer = window.setTimeout(() => {
      setPendingByItem((prev) => {
        let changed = false;
        const next = { ...prev };
        for (const item of cart.items) {
          if (item.item_kind !== 'ticket') continue;
          if (!next[item.order_item_id]) {
            next[item.order_item_id] = { type: item.shirt_type ?? '', size: item.shirt_size ?? '' };
            changed = true;
          }
        }
        return changed ? next : prev;
      });
      setPendingGenderByItem((prev) => {
        let changed = false;
        const next = { ...prev };
        for (const item of cart.items) {
          if (item.item_kind !== 'ticket') continue;
          if (!(item.order_item_id in next)) {
            next[item.order_item_id] = item.pricing_gender ?? '';
            changed = true;
          }
        }
        return changed ? next : prev;
      });
    }, 0);
    return () => window.clearTimeout(timer);
  }, [cart]);

  // Rola ate o card focado e aplica um highlight temporario -- nunca esconde
  // os demais ingressos, so ajuda a localizar o que foi clicado no carrinho.
  useEffect(() => {
    if (!focusItemId || !cart) return;
    const node = itemRefs.current[focusItemId];
    if (node) node.scrollIntoView({ behavior: 'smooth', block: 'center' });
    const showTimer = window.setTimeout(() => setHighlightedItemId(focusItemId), 0);
    const hideTimer = window.setTimeout(() => {
      setHighlightedItemId((current) => (current === focusItemId ? null : current));
    }, 2500);
    return () => {
      window.clearTimeout(showTimer);
      window.clearTimeout(hideTimer);
    };
  }, [focusItemId, cart]);

  const shirtVariants = buildShirtInventoryVariants(inventory);
  const shirtTypes = Array.from(new Set(shirtVariants.map((variant) => variant.shirt_type)));

  function sizesForType(shirtType: string) {
    return shirtVariants.filter((variant) => variant.shirt_type === shirtType);
  }

  async function handleSaveShirt(item: EditableTicketItem) {
    const pending = pendingByItem[item.order_item_id];
    if (!pending?.type || !pending?.size) return;
    setBusyItemId(item.order_item_id);
    setMessage(null);
    const result = await changePendingOrderItemShirtAction(orderId, item.order_item_id, pending.type, pending.size);
    setBusyItemId(null);
    if (!result.success) { setMessage({ type: 'error', text: result.message }); return; }
    setCart(result.cart as unknown as CartDetails);
    setMessage({ type: 'success', text: 'Camiseta atualizada.' });
  }

  async function handleSaveGender(item: EditableTicketItem) {
    const pending = pendingGenderByItem[item.order_item_id];
    if (!pending) return;
    setBusyItemId(item.order_item_id);
    setMessage(null);
    const result = await changePendingOrderItemGenderAction(orderId, item.order_item_id, pending);
    setBusyItemId(null);
    if (!result.success) { setMessage({ type: 'error', text: result.message }); return; }
    setCart(result.cart as unknown as CartDetails);
    setMessage({ type: 'success', text: 'Genero atualizado e preco recalculado.' });
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
          const pending = pendingByItem[item.order_item_id] ?? { type: item.shirt_type ?? '', size: item.shirt_size ?? '' };
          const sizeOptions = pending.type ? sizesForType(pending.type) : [];
          const isShirtDirty = Boolean(pending.type) && Boolean(pending.size)
            && (pending.type !== (item.shirt_type ?? '') || pending.size !== (item.shirt_size ?? ''));

          const pendingGender = pendingGenderByItem[item.order_item_id] ?? (item.pricing_gender ?? '');
          const isGenderDirty = Boolean(pendingGender) && pendingGender !== (item.pricing_gender ?? '');

          const isHighlighted = highlightedItemId === item.order_item_id;

          return (
            <div
              key={item.order_item_id}
              ref={(node) => { itemRefs.current[item.order_item_id] = node; }}
              className={`rounded-2xl border p-4 text-sm text-slate-200 transition ${
                isHighlighted ? 'border-emerald-400 bg-emerald-900/10 ring-2 ring-emerald-400/40' : 'border-slate-700 bg-slate-950'
              }`}
            >
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

              <div className="mt-4 border-t border-slate-800/70 pt-3">
                <label className="block space-y-1">
                  <span className="text-xs text-slate-300">Gênero do ingresso</span>
                  <select
                    value={pendingGender}
                    disabled={busy}
                    onChange={(e) => {
                      const next = e.target.value as PricingGender | '';
                      setPendingGenderByItem((prev) => ({ ...prev, [item.order_item_id]: next }));
                    }}
                    className="h-10 w-full max-w-xs rounded-lg border border-slate-700 bg-slate-900 px-3 text-sm disabled:opacity-50"
                  >
                    <option value="">{genderLabel(item.pricing_gender) ?? 'Não definido'}</option>
                    <option value="male">Masculino</option>
                    <option value="female">Feminino</option>
                  </select>
                </label>
                <p className="mt-1 text-[11px] text-slate-500">
                  Alterar o gênero recalcula o preço deste ingresso (não é inferido a partir da camiseta).
                </p>
                {isGenderDirty ? (
                  <div className="mt-2 flex justify-end">
                    <button
                      type="button"
                      onClick={() => void handleSaveGender(item)}
                      disabled={busy}
                      className="h-9 rounded-lg bg-emerald-500 px-4 text-xs font-semibold text-emerald-950 disabled:opacity-50"
                    >
                      {busy ? 'Salvando...' : 'Salvar gênero'}
                    </button>
                  </div>
                ) : null}
              </div>

              <div className="mt-4 border-t border-slate-800/70 pt-3">
                <div className="grid gap-3 sm:grid-cols-2">
                  <label className="space-y-1">
                    <span className="text-xs text-slate-300">Tipo de camiseta</span>
                    <select
                      value={pending.type}
                      disabled={busy}
                      onChange={(e) => {
                        const nextType = e.target.value;
                        setPendingByItem((prev) => {
                          const currentSize = prev[item.order_item_id]?.size ?? '';
                          const validSizes = sizesForType(nextType).map((variant) => variant.shirt_size);
                          return {
                            ...prev,
                            [item.order_item_id]: {
                              type: nextType,
                              size: validSizes.includes(currentSize) ? currentSize : '',
                            },
                          };
                        });
                      }}
                      className="h-10 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 text-sm disabled:opacity-50"
                    >
                      <option value="">Selecione</option>
                      {shirtTypes.map((shirtType) => (
                        <option key={shirtType} value={shirtType}>{shirtDisplayLabel(shirtType)}</option>
                      ))}
                    </select>
                  </label>

                  <label className="space-y-1">
                    <span className="text-xs text-slate-300">Tamanho</span>
                    <select
                      value={pending.size}
                      disabled={busy || !pending.type}
                      onChange={(e) => {
                        const nextSize = e.target.value;
                        setPendingByItem((prev) => ({
                          ...prev,
                          [item.order_item_id]: { type: prev[item.order_item_id]?.type ?? pending.type, size: nextSize },
                        }));
                      }}
                      className="h-10 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 text-sm disabled:opacity-50"
                    >
                      <option value="">{pending.type ? 'Selecione' : 'Escolha o tipo primeiro'}</option>
                      {sizeOptions.map((variant) => {
                        const isCurrentSelection = variant.shirt_type === item.shirt_type && variant.shirt_size === item.shirt_size;
                        const outOfStock = enforcePhysicalStock && variant.available_quantity <= 0 && !isCurrentSelection;
                        return (
                          <option key={variant.id} value={variant.shirt_size} disabled={outOfStock}>
                            {variant.shirt_size}{outOfStock ? ' (sem estoque)' : ''}
                          </option>
                        );
                      })}
                    </select>
                  </label>
                </div>
                <p className="mt-1 text-[11px] text-slate-500">
                  Tipo e tamanho da camiseta não alteram o preço deste ingresso.
                </p>

                {isShirtDirty ? (
                  <div className="mt-2 flex justify-end">
                    <button
                      type="button"
                      onClick={() => void handleSaveShirt(item)}
                      disabled={busy}
                      className="h-9 rounded-lg bg-emerald-500 px-4 text-xs font-semibold text-emerald-950 disabled:opacity-50"
                    >
                      {busy ? 'Salvando...' : 'Salvar camiseta'}
                    </button>
                  </div>
                ) : null}
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
