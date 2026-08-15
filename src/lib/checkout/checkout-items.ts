export type CheckoutItemOwnershipMode = 'self' | 'unassigned' | 'named';
export type CheckoutItemVisualStatus = 'complete' | 'missing' | 'out_of_stock' | 'price_updated' | 'pricing_error';

export type CheckoutItemConfig = {
  clientId: string;
  ownershipMode: CheckoutItemOwnershipMode;
  holder_full_name: string;
  holder_cpf: string;
  holder_email: string;
  holder_phone: string;
  pricingGender: 'male' | 'female' | null;
  shirtType: string;
  shirtSize: string;
  unitPrice: number;
  discountAmount: number;
  finalAmount: number;
  validationErrors: string[];
  visualStatus: CheckoutItemVisualStatus;
  pricingError: string | null;
};

export function createCheckoutItem(seed: number, defaultGender: 'male' | 'female' | null = null): CheckoutItemConfig {
  return {
    clientId: `item-${Date.now()}-${seed}-${Math.random().toString(36).slice(2, 8)}`,
    ownershipMode: seed === 0 ? 'self' : 'unassigned',
    holder_full_name: '',
    holder_cpf: '',
    holder_email: '',
    holder_phone: '',
    pricingGender: defaultGender,
    shirtType: '',
    shirtSize: '',
    unitPrice: 0,
    discountAmount: 0,
    finalAmount: 0,
    validationErrors: [],
    visualStatus: 'missing',
    pricingError: null,
  };
}

/**
 * Funcao pura: calcula o array de itens para uma nova quantidade sem depender
 * do timing de nenhum setState. Chamada tanto por syncItemCount (para gravar o
 * estado) quanto diretamente pelos handlers que precisam do array atualizado no
 * mesmo instante para repassar como itemsOverride ao pipeline de precificacao --
 * e assim nunca reprecificar a partir de um checkoutItems desatualizado (a causa
 * raiz do "2o ingresso perde o preco": o handler de quantidade chamava
 * refreshItemPricingByCoupon logo apos syncItemCount, mas lia checkoutItems por
 * closure, que so refletiria o novo item no PROXIMO render).
 *
 * allowSelfOwnership=false (comprador ja titular de outro ingresso ativo no
 * evento) nunca seleciona nem preserva "self" em nenhum item, nem mesmo o
 * primeiro -- "Este ingresso e para mim" so pode ficar marcado apos a checagem
 * canonica do backend confirmar que esta disponivel.
 */
export function computeSyncedItems(
  targetQuantity: number,
  source: CheckoutItemConfig[],
  defaultGender: 'male' | 'female' | null,
  allowSelfOwnership: boolean,
): CheckoutItemConfig[] {
  const target = Math.max(1, Math.min(10, Number(targetQuantity || 1)));
  const next = Array.from({ length: target }, (_, index) => {
    const existing = source[index];
    if (existing) return existing;
    return createCheckoutItem(index, defaultGender);
  });

  if (!allowSelfOwnership) {
    for (let i = 0; i < next.length; i += 1) {
      if (next[i].ownershipMode === 'self') next[i] = { ...next[i], ownershipMode: 'unassigned' };
    }
    return next;
  }

  const meCount = next.filter((entry) => entry.ownershipMode === 'self').length;
  if (meCount === 0 && next.length > 0) {
    next[0] = { ...next[0], ownershipMode: 'self' };
  }
  if (meCount > 1) {
    let kept = false;
    for (let i = 0; i < next.length; i += 1) {
      if (next[i].ownershipMode !== 'self') continue;
      if (!kept) {
        kept = true;
        continue;
      }
      next[i] = { ...next[i], ownershipMode: 'unassigned' };
    }
  }

  return next;
}

export type CheckoutItemPricingResult =
  | { success: true; pricing: { base_amount: number; discount_amount: number; final_amount: number } }
  | { success: false; message?: string; code?: string | null };

/**
 * Aplica o resultado de precificacao de UM item, casado por clientId (nunca por
 * indice posicional -- ver applyPricingResultsByClientId). Uma falha real do
 * backend vira erro explicito, nunca R$ 0,00 silencioso; a ausencia de
 * resultado (item que nao fez parte desta rodada) preserva o item como estava,
 * sem inventar nem preco nem erro para algo que nao foi checado.
 */
export function applyPricingResultToItem(
  item: CheckoutItemConfig,
  result: CheckoutItemPricingResult | undefined,
): CheckoutItemConfig {
  if (!result) return item;

  if (!result.success) {
    return {
      ...item,
      visualStatus: 'pricing_error',
      pricingError: result.message || 'Nao foi possivel calcular o preco deste ingresso.',
    };
  }

  return {
    ...item,
    unitPrice: Number(result.pricing.base_amount ?? 0),
    discountAmount: Number(result.pricing.discount_amount ?? 0),
    finalAmount: Number(result.pricing.final_amount ?? 0),
    visualStatus: 'price_updated',
    pricingError: null,
  };
}

/**
 * Casa os resultados de precificacao com os itens ATUAIS por clientId. Este e o
 * ponto exato que corrigiu o bug do 2o ingresso: antes, o codigo casava
 * pricingResults[index] com prev[index] por posicao -- se prev (o estado mais
 * recente) tivesse mais itens do que a rodada de precificacao processou (ex.:
 * por causa da closure obsoleta em checkoutItems), o item extra ficava sem par
 * e caia num erro fabricado pelo proprio frontend, nunca devolvido pelo RPC.
 */
export function applyPricingResultsByClientId(
  items: CheckoutItemConfig[],
  resultsByClientId: Map<string, CheckoutItemPricingResult>,
): CheckoutItemConfig[] {
  return items.map((item) => applyPricingResultToItem(item, resultsByClientId.get(item.clientId)));
}
