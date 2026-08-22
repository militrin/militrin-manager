export type StoreItemDiscountType = 'percentage' | 'fixed' | null;

/**
 * Fonte unica de calculo do preco efetivo de um produto da loja no
 * frontend -- espelha byte a byte a formula de public.compute_store_item_
 * final_price (SQL, ja usada por create_store_order, add_product_to_cart_
 * order e admin_grant_store_item). Sempre aplicado sobre o preco unitario
 * da LINHA (preco base + ajuste de variante quando houver uma selecionada),
 * nunca so o preco base isolado -- mesma regra do checkout, pra qualquer
 * tela (card da loja, modal de detalhe, carrinho) nunca calcular um valor
 * diferente do que sera realmente cobrado.
 */
export function computeStoreItemFinalPrice(unitPrice: number, discountType: StoreItemDiscountType, discountValue: number): number {
  if (discountType === 'percentage') return Math.max(unitPrice * (1 - Math.min(discountValue ?? 0, 100) / 100), 0);
  if (discountType === 'fixed') return Math.max(unitPrice - (discountValue ?? 0), 0);
  return Math.max(unitPrice, 0);
}

/** true somente quando ha desconto configurado E ele realmente reduz o preco da linha (nunca so por discountType estar setado). */
export function storeItemHasActiveDiscount(unitPrice: number, discountType: StoreItemDiscountType, discountValue: number): boolean {
  if (!discountType || !(discountValue > 0)) return false;
  return computeStoreItemFinalPrice(unitPrice, discountType, discountValue) < unitPrice;
}

type StoreItemLinePriceInput<V extends { id: string; priceAdjustment: number }> = {
  price: number;
  discountType: StoreItemDiscountType;
  discountValue: number;
  variants: V[];
};

/**
 * Resolve o preco da LINHA (produto + variante selecionada, se houver) --
 * ponto unico usado pelo card da vitrine, pelo modal de detalhe e pelo
 * carrinho, pra nunca calcular um preco diferente em cada tela. baseUnitPrice
 * e o preco ANTES do desconto do produto (o que aparece riscado quando ha
 * desconto); finalUnitPrice e o que efetivamente entra no carrinho e no
 * pedido. Generico sobre o tipo da variante pra devolver o objeto completo
 * (nome/valor etc.), nao so os campos minimos usados no calculo.
 */
export function resolveStoreItemLinePrice<V extends { id: string; priceAdjustment: number }>(item: StoreItemLinePriceInput<V>, variantId: string | null) {
  const variant = variantId ? item.variants.find((v) => v.id === variantId) ?? null : null;
  const baseUnitPrice = item.price + (variant?.priceAdjustment ?? 0);
  const finalUnitPrice = computeStoreItemFinalPrice(baseUnitPrice, item.discountType, item.discountValue);
  return {
    variant,
    baseUnitPrice,
    finalUnitPrice,
    hasDiscount: finalUnitPrice < baseUnitPrice,
  };
}
