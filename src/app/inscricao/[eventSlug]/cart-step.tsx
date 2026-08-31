"use client";

import { useEffect, useState } from "react";
import {
  addProductToCartAction,
  applyCartCouponAction,
  finalizeCartOrderAction,
  getCartOrderDetailsAction,
  getEligibleCartProductsAction,
  removeCartOrderItemAction,
  setCartOrderItemQuantityAction,
} from "../actions";
import { ProductImageGallery, type GalleryImage } from "@/components/store/product-image-gallery";
import { QuantityStepper } from "@/components/store/store-item-controls";
import { computeStoreItemFinalPrice } from "@/lib/store/pricing";
import { shirtDisplayLabel } from "@/lib/constants/shirts";

type CartItem = {
  order_item_id: string;
  item_kind: "ticket" | "product";
  status: string;
  quantity: number;
  unit_price: number;
  /** Preco do produto ANTES do desconto proprio -- null para item_kind="ticket" (get_cart_order_details). */
  product_base_unit_price: number | null;
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
  images: Array<{ id: string; url: string; is_primary: boolean }>;
  price: number;
  /** Desconto intrinseco do produto (mesmo campo de list_store_items_for_event ja usado pelo resto da loja) -- fonte de computeStoreItemFinalPrice. */
  discount_type: "percentage" | "fixed" | null;
  discount_value: number;
  requires_variant: boolean;
  supply_mode: string;
  variant_id: string | null;
  variant_name: string | null;
  variant_value: string | null;
  price_adjustment: number | null;
  available_quantity: number | null;
};

function effectivePrice(row: EligibleProduct) {
  return computeStoreItemFinalPrice(row.price + (row.price_adjustment ?? 0), row.discount_type, row.discount_value);
}

type ProductGroup = [string, EligibleProduct[]];

function money(value: number) {
  return value.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

function isGroupUnavailable(variants: EligibleProduct[]) {
  const hasStockInfo = variants[0]?.available_quantity !== null;
  const anyAvailable = variants.some((v) => v.available_quantity === null || (v.available_quantity ?? 0) > 0);
  return hasStockInfo && !anyAvailable;
}

const EXCEEDED_STOCK_MESSAGE = "Você já adicionou todas as unidades disponíveis deste produto.";

/** null = sem limite conhecido (por encomenda) -- nunca mostra aviso de urgencia. */
function stockUrgencyLabel(availableQuantity: number | null): string | null {
  if (availableQuantity === null) return null;
  if (availableQuantity <= 0) return "Esgotado";
  if (availableQuantity === 1) return "Última unidade disponível";
  if (availableQuantity <= 3) return `Restam apenas ${availableQuantity} unidades`;
  return null;
}

/** Cruza uma linha do carrinho com a mesma fonte canonica de estoque
 * (list_store_items_for_event, ja carregada como `products` pro "Compre
 * junto") pra saber o estoque atual do que ja esta no carrinho. */
function findEligibleProductForCartItem(products: EligibleProduct[], item: CartItem): EligibleProduct | null {
  return products.find((p) =>
    p.store_item_id === item.store_item_id
    && (p.variant_id ?? null) === (item.store_item_variant_id ?? null)
  ) ?? null;
}

/** Clampa pra um inteiro >= 1 e, se houver limite de estoque conhecido, <= max. */
function clampQuantity(value: number, max: number | null) {
  const safe = Number.isFinite(value) ? Math.floor(value) : 1;
  const atLeastOne = Math.max(1, safe);
  return max !== null ? Math.min(atLeastOne, Math.max(1, max)) : atLeastOne;
}

function ProductCard({
  group,
  busy,
  onOpenDetails,
  onQuickAdd,
}: {
  group: ProductGroup;
  busy: boolean;
  onOpenDetails: (storeItemId: string, initialQuantity: number) => void;
  onQuickAdd: (storeItemId: string, quantity: number) => Promise<{ success: boolean; message?: string }>;
}) {
  const [, variants] = group;
  const base = variants[0];
  const outOfStock = isGroupUnavailable(variants);
  const [quantity, setQuantity] = useState(1);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // So mostra urgencia por estoque pro card inteiro quando o produto NAO tem
  // variantes: com variante, cada opcao pode ter estoque diferente -- essa
  // granularidade aparece no modal, por variante, nao aqui.
  const cardAvailableQuantity = base.requires_variant ? null : base.available_quantity;
  const urgencyLabel = stockUrgencyLabel(cardAvailableQuantity);

  async function handleAddClick() {
    if (base.requires_variant) {
      onOpenDetails(base.store_item_id, quantity);
      return;
    }
    setSubmitting(true);
    setError(null);
    const result = await onQuickAdd(base.store_item_id, quantity);
    setSubmitting(false);
    if (!result.success) { setError(result.message ?? "Não foi possível adicionar."); return; }
    setQuantity(1);
  }

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onOpenDetails(base.store_item_id, quantity)}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") onOpenDetails(base.store_item_id, quantity); }}
      className="flex cursor-pointer flex-col gap-3 rounded-xl border border-slate-700 bg-slate-900/60 p-3 text-left transition hover:border-emerald-500/50 hover:bg-slate-900"
    >
      <div className="flex items-start gap-3">
        {base.image_url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={base.image_url} alt="" className="h-14 w-14 shrink-0 rounded-lg object-cover" />
        ) : (
          <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-lg bg-slate-800 text-[9px] text-slate-500">Sem foto</div>
        )}
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-slate-100">{base.name}</p>
          {(() => {
            const original = base.price + (base.price_adjustment ?? 0);
            const final = effectivePrice(base);
            return final < original ? (
              <p className="text-xs">
                <span className="text-slate-500 line-through">{money(original)}</span>{' '}
                <span className="font-semibold text-emerald-300">{money(final)}</span>
              </p>
            ) : (
              <p className="text-xs text-slate-400">{money(original)}</p>
            );
          })()}
          {base.description ? <p className="mt-1 line-clamp-2 text-xs text-slate-500">{base.description}</p> : null}
          {outOfStock ? (
            <p className="mt-1 text-xs font-medium text-rose-400">Esgotado</p>
          ) : urgencyLabel ? (
            <p className={`mt-1 text-xs font-medium ${cardAvailableQuantity === 1 ? "text-rose-400" : "text-amber-400"}`}>{urgencyLabel}</p>
          ) : null}
        </div>
      </div>

      {!outOfStock ? (
        <div className="flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
          <QuantityStepper
            value={quantity}
            max={cardAvailableQuantity}
            onChange={(next) => setQuantity(clampQuantity(next, cardAvailableQuantity))}
            onExceedMax={() => setError(EXCEEDED_STOCK_MESSAGE)}
          />
          <button
            type="button"
            onClick={() => void handleAddClick()}
            disabled={submitting || busy}
            className="flex-1 rounded-lg bg-emerald-500 px-3 py-1.5 text-xs font-semibold text-emerald-950 disabled:opacity-50"
          >
            {submitting ? "Adicionando..." : "Adicionar ao carrinho"}
          </button>
        </div>
      ) : null}
      {error ? <p className="text-xs text-rose-300">{error}</p> : null}
    </div>
  );
}

function ProductDetailModal({
  group,
  initialQuantity,
  onClose,
  onAdd,
}: {
  group: ProductGroup;
  initialQuantity: number;
  onClose: () => void;
  onAdd: (storeItemId: string, variantId: string | null, quantity: number) => Promise<{ success: boolean; message?: string }>;
}) {
  const [storeItemId, variants] = group;
  const base = variants[0];
  const firstAvailable = variants.find((v) => v.available_quantity === null || (v.available_quantity ?? 0) > 0) ?? variants[0];
  const [variantId, setVariantId] = useState<string | null>(base.requires_variant ? firstAvailable.variant_id : null);
  const [quantity, setQuantity] = useState(initialQuantity);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", handleKeyDown);
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      document.body.style.overflow = "";
    };
  }, [onClose]);

  const selectedVariant = base.requires_variant ? variants.find((v) => v.variant_id === variantId) ?? null : null;
  const availableQuantity = base.requires_variant ? (selectedVariant?.available_quantity ?? null) : base.available_quantity;
  const unavailable = base.requires_variant
    ? !selectedVariant || (selectedVariant.available_quantity !== null && (selectedVariant.available_quantity ?? 0) <= 0)
    : base.available_quantity !== null && (base.available_quantity ?? 0) <= 0;

  const galleryImages: GalleryImage[] = base.images.length > 0
    ? base.images.map((image) => ({ id: image.id, url: image.url }))
    : base.image_url
      ? [{ url: base.image_url }]
      : [];

  async function handleAdd() {
    setSubmitting(true);
    setError(null);
    const result = await onAdd(storeItemId, variantId, quantity);
    setSubmitting(false);
    if (!result.success) { setError(result.message ?? "Não foi possível adicionar o produto."); return; }
    onClose();
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 sm:items-center sm:p-4" onClick={onClose}>
      <div
        className="max-h-[90vh] w-full overflow-y-auto rounded-t-3xl bg-slate-950 p-4 sm:max-w-md sm:rounded-3xl sm:p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">Detalhes do produto</p>
          <button type="button" onClick={onClose} aria-label="Fechar" className="rounded-full p-1 text-slate-400 hover:text-slate-200">
            ✕
          </button>
        </div>

        <div className="mt-3">
          <ProductImageGallery images={galleryImages} alt={base.name} />
        </div>

        <div className="mt-4 space-y-1">
          <p className="text-lg font-semibold text-slate-100">{base.name}</p>
          {(() => {
            const activeRow = selectedVariant ?? base;
            const original = activeRow.price + (activeRow.price_adjustment ?? 0);
            const final = effectivePrice(activeRow);
            return final < original ? (
              <p className="text-base">
                <span className="mr-2 text-slate-500 line-through">{money(original)}</span>
                <span className="font-semibold text-emerald-300">{money(final)}</span>
              </p>
            ) : (
              <p className="text-base text-emerald-300">{money(original)}</p>
            );
          })()}
          {stockUrgencyLabel(availableQuantity) ? (
            <p className={`text-xs font-medium ${availableQuantity === 1 ? "text-rose-400" : "text-amber-400"}`}>
              {stockUrgencyLabel(availableQuantity)}
            </p>
          ) : null}
          {base.description ? <p className="text-sm text-slate-400">{base.description}</p> : null}
        </div>

        {base.requires_variant ? (
          <div className="mt-4">
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">Escolha uma opção</p>
            <div className="flex flex-wrap gap-2">
              {variants.map((variant) => {
                const isUnavailable = variant.available_quantity !== null && (variant.available_quantity ?? 0) <= 0;
                const selected = variant.variant_id === variantId;
                return (
                  <button
                    key={variant.variant_id}
                    type="button"
                    onClick={() => {
                      setVariantId(variant.variant_id);
                      setQuantity((current) => clampQuantity(current, variant.available_quantity));
                    }}
                    disabled={isUnavailable}
                    className={`rounded-lg border px-3 py-1.5 text-sm disabled:opacity-40 ${
                      selected ? "border-emerald-500 bg-emerald-500/10 text-emerald-200" : "border-slate-600 text-slate-200"
                    }`}
                  >
                    {variant.variant_name} {variant.variant_value}
                    {isUnavailable ? " (sem estoque)" : ""}
                  </button>
                );
              })}
            </div>
          </div>
        ) : unavailable ? (
          <p className="mt-3 text-sm font-medium text-rose-400">Sem estoque disponível.</p>
        ) : null}

        {!unavailable ? (
          <div className="mt-4">
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">Quantidade</p>
            <QuantityStepper
              value={quantity}
              max={availableQuantity}
              onChange={(next) => setQuantity(clampQuantity(next, availableQuantity))}
              onExceedMax={() => setError(EXCEEDED_STOCK_MESSAGE)}
            />
          </div>
        ) : null}

        {error ? <p className="mt-3 text-xs text-rose-300">{error}</p> : null}

        <button
          type="button"
          onClick={() => void handleAdd()}
          disabled={submitting || unavailable}
          className="mt-5 h-11 w-full rounded-2xl bg-emerald-500 text-sm font-semibold text-emerald-950 disabled:opacity-50"
        >
          {submitting ? "Adicionando..." : unavailable ? "Sem estoque" : "Adicionar ao carrinho"}
        </button>
      </div>
    </div>
  );
}

export function CartStep({
  orderId,
  eventId,
  paymentMethod,
  installments,
  onContinue,
  onEditTicket,
  onSnapshotChange,
}: {
  orderId: string;
  eventId: string;
  paymentMethod: string;
  /** So relevante quando paymentMethod='credit_card_installments' -- ignorado pelos demais metodos (mesmo default 1 de finalizeCartOrderAction). */
  installments?: number;
  onContinue: (order: unknown) => void;
  /** Presente somente em modo edicao de pedido (?editOrder=) -- clicar num
   * card de ingresso navega direto pra Etapa 1 com aquele ingresso em
   * evidencia (order_item_id, nunca indice visual). Ausente no fluxo normal
   * de criacao: nesse caso a Etapa 1 nem representa os ingressos deste
   * pedido (ver comentario de editModeOrderId em wizard.tsx), entao os
   * cards ficam nao-clicaveis. */
  onEditTicket?: (orderItemId: string) => void;
  /** Chamado toda vez que este componente busca ou muta o carrinho (mount,
   * add/remover produto, quantidade, cupom) -- deixa o wizard pai espelhar
   * o MESMO snapshot canonico (get_cart_order_details) pro resumo lateral,
   * que nunca deve calcular nada por conta propria. */
  onSnapshotChange?: (cart: unknown) => void;
}) {
  const [cart, setCart] = useState<CartDetails | null>(null);
  const [products, setProducts] = useState<EligibleProduct[]>([]);
  const [loading, setLoading] = useState(true);
  const [couponCode, setCouponCode] = useState("");
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [selectedProduct, setSelectedProduct] = useState<{ storeItemId: string; initialQuantity: number } | null>(null);

  // Ponto unico: qualquer `cart` novo (fetch inicial ou apos mutacao) passa
  // por aqui, que atualiza o estado local E notifica o wizard pai -- nunca
  // um `setCart` direto que deixaria o pai com um snapshot desatualizado.
  function updateCart(next: CartDetails) {
    setCart(next);
    onSnapshotChange?.(next);
  }

  useEffect(() => {
    let active = true;
    (async () => {
      const [cartResult, productsResult] = await Promise.all([
        getCartOrderDetailsAction(orderId),
        getEligibleCartProductsAction(eventId),
      ]);
      if (!active) return;
      if (cartResult.success) updateCart(cartResult.cart as unknown as CartDetails);
      if (productsResult.success) setProducts(productsResult.products as unknown as EligibleProduct[]);
      setLoading(false);
    })();
    return () => { active = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orderId, eventId]);

  // Um produto pode ter varias variantes (linhas separadas vindas de
  // list_store_items_for_event); agrupamos por store_item_id so pra decidir
  // se ha estoque disponivel em QUALQUER variante, sem duplicar o card.
  const productGroups: ProductGroup[] = Array.from(
    products.reduce((map, row) => {
      const list = map.get(row.store_item_id) ?? [];
      list.push(row);
      map.set(row.store_item_id, list);
      return map;
    }, new Map<string, EligibleProduct[]>()).entries(),
  );
  const selectedGroup = selectedProduct ? productGroups.find(([id]) => id === selectedProduct.storeItemId) ?? null : null;

  async function handleAddProduct(storeItemId: string, variantId: string | null, quantity: number) {
    setBusy(true);
    setMessage(null);
    const result = await addProductToCartAction(orderId, storeItemId, variantId, quantity);
    setBusy(false);
    if (!result.success) { setMessage({ type: "error", text: result.message }); return result; }
    updateCart(result.cart as unknown as CartDetails);
    return result;
  }

  async function handleRemoveItem(orderItemId: string) {
    setBusy(true);
    setMessage(null);
    const result = await removeCartOrderItemAction(orderId, orderItemId);
    setBusy(false);
    if (!result.success) { setMessage({ type: "error", text: result.message }); return; }
    updateCart(result.cart as unknown as CartDetails);
  }

  async function handleSetQuantity(item: CartItem, nextQuantity: number) {
    if (nextQuantity <= 0) { await handleRemoveItem(item.order_item_id); return; }
    setBusy(true);
    setMessage(null);
    const result = await setCartOrderItemQuantityAction(orderId, item.order_item_id, nextQuantity);
    setBusy(false);
    if (!result.success) { setMessage({ type: "error", text: result.message }); return; }
    updateCart(result.cart as unknown as CartDetails);
  }

  async function handleApplyCoupon() {
    setBusy(true);
    setMessage(null);
    const result = await applyCartCouponAction(orderId, couponCode.trim() || null);
    setBusy(false);
    if (!result.success) { setMessage({ type: "error", text: result.message }); return; }
    updateCart(result.cart as unknown as CartDetails);
    setMessage({ type: "success", text: couponCode.trim() ? "Cupom aplicado." : "Cupom removido." });
  }

  async function handleContinue() {
    setBusy(true);
    setMessage(null);
    const result = await finalizeCartOrderAction(orderId, paymentMethod, installments ?? 1);
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

      <div className="space-y-3 rounded-2xl border border-slate-700 bg-slate-950 p-4">
        <p className="text-sm font-semibold text-slate-200">Seu carrinho</p>
        {ticketItems.length > 0 ? (
          <div className="space-y-2">
            {ticketItems.map((item) => {
              const shirtLabel = shirtDisplayLabel(item.shirt_type);
              const editable = Boolean(onEditTicket);
              return (
                <div
                  key={item.order_item_id}
                  role={editable ? "button" : undefined}
                  tabIndex={editable ? 0 : undefined}
                  onClick={editable ? () => onEditTicket?.(item.order_item_id) : undefined}
                  onKeyDown={editable ? (e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      onEditTicket?.(item.order_item_id);
                    }
                  } : undefined}
                  aria-label={editable ? `Editar ingresso${item.category_name ? ` · ${item.category_name}` : ""}` : undefined}
                  className={`flex items-start justify-between gap-3 rounded-xl border border-slate-800/70 bg-slate-900/40 px-3 py-3 ${
                    editable ? "cursor-pointer transition hover:border-emerald-500/50 hover:bg-slate-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/60" : ""
                  }`}
                >
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-slate-100">
                      Ingresso{item.category_name ? ` · ${item.category_name}` : ""}
                    </p>
                    {shirtLabel ? (
                      <p className="mt-0.5 text-xs text-slate-400 break-words">
                        {shirtLabel}{item.shirt_size ? ` · ${item.shirt_size}` : ""}
                      </p>
                    ) : null}
                    <p className="mt-1 text-[11px] text-slate-500 break-words">
                      {item.holder_full_name ? `Titular: ${item.holder_full_name}` : "Titular ainda não definido"}
                    </p>
                    {editable ? (
                      <p className="mt-1 text-[11px] font-medium text-emerald-300 underline underline-offset-2">Editar</p>
                    ) : null}
                  </div>
                  <div className="shrink-0 text-right">
                    <p className="text-sm font-semibold text-slate-100">{money(item.unit_price)}</p>
                    {item.discount_amount > 0 ? (
                      <p className="text-xs text-emerald-300">-{money(item.discount_amount)}</p>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>
        ) : null}
        {productItems.length > 0 ? (
          <div className={`space-y-2 ${ticketItems.length > 0 ? "border-t border-slate-800/70 pt-3" : ""}`}>
            {productItems.map((item) => {
              const matchedProduct = findEligibleProductForCartItem(products, item);
              const availableQuantity = matchedProduct?.available_quantity ?? null;
              // Quanto ainda cabe nesta linha: o que ja esta reservado aqui
              // (item.quantity) + o que ainda esta livre no estoque global
              // (available_quantity ja exclui a propria reserva desta linha,
              // conferido em list_store_items_for_event).
              const maxSettable = availableQuantity === null ? null : item.quantity + availableQuantity;
              const urgencyLabel = stockUrgencyLabel(availableQuantity);
              return (
              <div key={item.order_item_id} className="flex flex-wrap items-center gap-3 rounded-xl border border-slate-800 bg-slate-900/50 p-2">
                {item.store_item_image_url ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={item.store_item_image_url} alt="" className="h-10 w-10 shrink-0 rounded object-cover" />
                ) : (
                  <div className="h-10 w-10 shrink-0 rounded bg-slate-800" />
                )}
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-slate-100">
                    {item.store_item_name}{item.variant_name ? ` · ${item.variant_name} ${item.variant_value}` : ""}
                  </p>
                  <p className="text-xs text-slate-400">
                    {item.quantity}x{' '}
                    {item.product_base_unit_price !== null && item.product_base_unit_price > item.unit_price ? (
                      <>
                        <span className="text-slate-500 line-through">{money(item.product_base_unit_price)}</span>{' '}
                        <span className="font-semibold text-emerald-300">{money(item.unit_price)}</span>
                      </>
                    ) : (
                      money(item.unit_price)
                    )}
                  </p>
                  {urgencyLabel ? (
                    <p className={`text-[11px] font-medium ${availableQuantity === 1 ? "text-rose-400" : "text-amber-400"}`}>{urgencyLabel}</p>
                  ) : null}
                </div>
                <QuantityStepper
                  value={item.quantity}
                  max={maxSettable}
                  onChange={(next) => void handleSetQuantity(item, next)}
                  onExceedMax={() => setMessage({ type: "error", text: EXCEEDED_STOCK_MESSAGE })}
                />
                <span className="w-24 shrink-0 text-right text-sm font-semibold text-slate-100">
                  <span className="block">{money(item.unit_price * item.quantity)}</span>
                  {item.discount_amount > 0 ? <span className="block text-xs font-normal text-emerald-300">-{money(item.discount_amount)}</span> : null}
                </span>
                <button
                  type="button"
                  onClick={() => void handleRemoveItem(item.order_item_id)}
                  disabled={busy}
                  className="shrink-0 text-xs text-rose-300 underline underline-offset-2 disabled:opacity-50"
                >
                  Remover
                </button>
              </div>
              );
            })}
          </div>
        ) : null}
      </div>

      {productGroups.length > 0 ? (
        <div className="space-y-2 rounded-2xl border border-slate-700 bg-slate-950 p-4">
          <p className="text-sm font-semibold uppercase tracking-wide text-slate-300">Compre junto</p>
          <div className="grid gap-2 sm:grid-cols-2">
            {productGroups.map((group) => (
              <ProductCard
                key={group[0]}
                group={group}
                busy={busy}
                onOpenDetails={(storeItemId, initialQuantity) => setSelectedProduct({ storeItemId, initialQuantity })}
                onQuickAdd={(storeItemId, quantity) => handleAddProduct(storeItemId, null, quantity)}
              />
            ))}
          </div>
        </div>
      ) : null}

      {selectedGroup && selectedProduct ? (
        <ProductDetailModal
          group={selectedGroup}
          initialQuantity={selectedProduct.initialQuantity}
          onClose={() => setSelectedProduct(null)}
          onAdd={handleAddProduct}
        />
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
