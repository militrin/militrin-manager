"use client";

import { useEffect, useState } from "react";
import {
  addProductToCartAction,
  applyCartCouponAction,
  finalizeCartOrderAction,
  getCartOrderDetailsAction,
  getEligibleCartProductsAction,
  removeCartOrderItemAction,
} from "../actions";

type CartItem = {
  order_item_id: string;
  item_kind: "ticket" | "product";
  status: string;
  unit_price: number;
  discount_amount: number;
  final_amount: number;
  category_name: string | null;
  shirt_type: string | null;
  shirt_size: string | null;
  holder_full_name: string | null;
  store_item_id: string | null;
  store_item_name: string | null;
  store_item_image_url: string | null;
  store_item_variant_id: string | null;
  variant_name: string | null;
  variant_value: string | null;
};

type CartDetails = {
  order_id: string;
  event_id: string;
  status: string;
  base_amount: number;
  discount_amount: number;
  final_amount: number;
  applied_coupon_code: string | null;
  items: CartItem[];
};

type EligibleProduct = {
  store_item_id: string;
  name: string;
  description: string | null;
  image_url: string | null;
  price: number;
  requires_variant: boolean;
  supply_mode: string;
  variant_id: string | null;
  variant_name: string | null;
  variant_value: string | null;
  price_adjustment: number | null;
  available_quantity: number | null;
};

function money(value: number) {
  return value.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

export function CartStep({
  orderId,
  eventId,
  paymentMethod,
  onContinue,
}: {
  orderId: string;
  eventId: string;
  paymentMethod: string;
  onContinue: (order: unknown) => void;
}) {
  const [cart, setCart] = useState<CartDetails | null>(null);
  const [products, setProducts] = useState<EligibleProduct[]>([]);
  const [loading, setLoading] = useState(true);
  const [couponCode, setCouponCode] = useState("");
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    (async () => {
      const [cartResult, productsResult] = await Promise.all([
        getCartOrderDetailsAction(orderId),
        getEligibleCartProductsAction(eventId),
      ]);
      if (!active) return;
      if (cartResult.success) setCart(cartResult.cart as unknown as CartDetails);
      if (productsResult.success) setProducts(productsResult.products as unknown as EligibleProduct[]);
      setLoading(false);
    })();
    return () => { active = false; };
  }, [orderId, eventId]);

  // Um produto pode ter varias variantes (linhas separadas vindas de
  // list_store_items_for_event); agrupamos por store_item_id so pra decidir
  // se ha estoque disponivel em QUALQUER variante, sem duplicar o card.
  const productGroups = Array.from(
    products.reduce((map, row) => {
      const list = map.get(row.store_item_id) ?? [];
      list.push(row);
      map.set(row.store_item_id, list);
      return map;
    }, new Map<string, EligibleProduct[]>()).entries(),
  );

  async function handleAddProduct(storeItemId: string, variantId: string | null) {
    setBusy(true);
    setMessage(null);
    const result = await addProductToCartAction(orderId, storeItemId, variantId, 1);
    setBusy(false);
    if (!result.success) { setMessage({ type: "error", text: result.message }); return; }
    setCart(result.cart as unknown as CartDetails);
  }

  async function handleRemoveItem(orderItemId: string) {
    setBusy(true);
    setMessage(null);
    const result = await removeCartOrderItemAction(orderId, orderItemId);
    setBusy(false);
    if (!result.success) { setMessage({ type: "error", text: result.message }); return; }
    setCart(result.cart as unknown as CartDetails);
  }

  async function handleApplyCoupon() {
    setBusy(true);
    setMessage(null);
    const result = await applyCartCouponAction(orderId, couponCode.trim() || null);
    setBusy(false);
    if (!result.success) { setMessage({ type: "error", text: result.message }); return; }
    setCart(result.cart as unknown as CartDetails);
    setMessage({ type: "success", text: couponCode.trim() ? "Cupom aplicado." : "Cupom removido." });
  }

  async function handleContinue() {
    setBusy(true);
    setMessage(null);
    const result = await finalizeCartOrderAction(orderId, paymentMethod);
    setBusy(false);
    if (!result.success) { setMessage({ type: "error", text: result.message }); return; }
    onContinue(result.order);
  }

  if (loading) {
    return <p className="text-sm text-slate-400">Carregando carrinho...</p>;
  }
  if (!cart) {
    return <p className="text-sm text-rose-300">Nao foi possivel carregar o carrinho.</p>;
  }

  const ticketItems = cart.items.filter((item) => item.item_kind === "ticket");
  const productItems = cart.items.filter((item) => item.item_kind === "product");

  return (
    <div className="space-y-4">
      <h2 className="text-lg font-semibold">3. Carrinho</h2>

      {message ? (
        <div className={`rounded-xl border px-3 py-2 text-sm ${message.type === "success" ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-200" : "border-red-500/30 bg-red-500/10 text-red-200"}`}>
          {message.text}
        </div>
      ) : null}

      <div className="space-y-2 rounded-2xl border border-slate-700 bg-slate-950 p-4">
        <p className="text-sm font-semibold text-slate-200">Seu carrinho</p>
        {ticketItems.map((item) => (
          <div key={item.order_item_id} className="flex items-center justify-between text-sm text-slate-200">
            <span>1x Ingresso{item.category_name ? ` · ${item.category_name}` : ""}{item.shirt_type ? ` · ${item.shirt_type} / ${item.shirt_size}` : ""}</span>
            <span>{money(item.final_amount)}</span>
          </div>
        ))}
        {productItems.map((item) => (
          <div key={item.order_item_id} className="flex items-center justify-between text-sm text-slate-200">
            <span>1x {item.store_item_name}{item.variant_name ? ` · ${item.variant_name} ${item.variant_value}` : ""}</span>
            <span className="flex items-center gap-2">
              {money(item.final_amount)}
              <button type="button" onClick={() => void handleRemoveItem(item.order_item_id)} disabled={busy} className="text-xs text-rose-300 underline underline-offset-2 disabled:opacity-50">
                Remover
              </button>
            </span>
          </div>
        ))}
      </div>

      {productGroups.length > 0 ? (
        <div className="space-y-2 rounded-2xl border border-slate-700 bg-slate-950 p-4">
          <p className="text-sm font-semibold uppercase tracking-wide text-slate-300">Compre junto</p>
          <div className="grid gap-2 sm:grid-cols-2">
            {productGroups.map(([storeItemId, variants]) => {
              const base = variants[0];
              const hasStockInfo = base.available_quantity !== null;
              const anyAvailable = variants.some((v) => v.available_quantity === null || (v.available_quantity ?? 0) > 0);
              return (
                <div key={storeItemId} className="flex items-center gap-3 rounded-xl border border-slate-700 bg-slate-900/60 p-3">
                  {base.image_url ? <img src={base.image_url} alt="" className="h-12 w-12 rounded object-cover" /> : null}
                  <div className="flex-1">
                    <p className="text-sm font-medium text-slate-100">{base.name}</p>
                    <p className="text-xs text-slate-400">{money(Number(base.price))}</p>
                    {!base.requires_variant ? (
                      <button
                        type="button"
                        onClick={() => void handleAddProduct(storeItemId, null)}
                        disabled={busy || (hasStockInfo && !anyAvailable)}
                        className="mt-1 rounded-lg bg-emerald-500 px-3 py-1 text-xs font-semibold text-emerald-950 disabled:opacity-50"
                      >
                        {hasStockInfo && !anyAvailable ? "Sem estoque" : "Adicionar"}
                      </button>
                    ) : (
                      <div className="mt-1 flex flex-wrap gap-1">
                        {variants.map((variant) => {
                          const unavailable = variant.available_quantity !== null && (variant.available_quantity ?? 0) <= 0;
                          return (
                            <button
                              key={variant.variant_id}
                              type="button"
                              onClick={() => void handleAddProduct(storeItemId, variant.variant_id)}
                              disabled={busy || unavailable}
                              className="rounded-lg border border-slate-600 px-2 py-1 text-xs text-slate-200 disabled:opacity-40"
                            >
                              {variant.variant_name} {variant.variant_value}{unavailable ? " (sem estoque)" : ""}
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ) : null}

      <div className="space-y-2 rounded-2xl border border-slate-700 bg-slate-950 p-4">
        <p className="text-sm font-semibold text-slate-200">Cupom</p>
        <div className="flex gap-2">
          <input
            value={couponCode}
            onChange={(e) => setCouponCode(e.target.value.toUpperCase())}
            placeholder="Código do cupom"
            className="h-10 flex-1 rounded-xl border border-slate-700 bg-slate-900 px-3 text-sm"
          />
          <button type="button" onClick={() => void handleApplyCoupon()} disabled={busy} className="h-10 rounded-xl border border-slate-600 px-4 text-sm text-slate-200 disabled:opacity-50">
            {cart.applied_coupon_code ? "Trocar" : "Aplicar"}
          </button>
          {cart.applied_coupon_code ? (
            <button type="button" onClick={() => { setCouponCode(""); void handleApplyCoupon(); }} disabled={busy} className="h-10 rounded-xl border border-slate-600 px-3 text-xs text-slate-400 disabled:opacity-50">
              Remover
            </button>
          ) : null}
        </div>
        {cart.applied_coupon_code ? <p className="text-xs text-emerald-300">Cupom aplicado: {cart.applied_coupon_code}</p> : null}
      </div>

      <div className="space-y-1 rounded-2xl border border-slate-700 bg-slate-950 p-4 text-sm text-slate-200">
        <p className="font-semibold text-slate-100">Resumo</p>
        <p>Subtotal: {money(cart.base_amount)}</p>
        <p>Desconto: {money(cart.discount_amount)}</p>
        <p className="text-base font-semibold text-emerald-200">Total: {money(cart.final_amount)}</p>
      </div>

      <div className="flex justify-end">
        <button
          type="button"
          onClick={() => void handleContinue()}
          disabled={busy}
          className="h-11 rounded-2xl bg-emerald-500 px-6 text-sm font-semibold text-emerald-950 disabled:opacity-50"
        >
          {busy ? "Processando..." : "Continuar para pagamento"}
        </button>
      </div>
    </div>
  );
}
