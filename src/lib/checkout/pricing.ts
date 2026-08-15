export type CheckoutPricingGender = 'male' | 'female';

type GenderResolutionInput = {
  itemGender?: unknown;
  requestGender?: unknown;
  buyerGender?: unknown;
};

export function normalizePricingGenderInput(value: unknown): CheckoutPricingGender | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();

  if (normalized === 'male' || normalized === 'masculino' || normalized === 'm') {
    return 'male';
  }

  if (normalized === 'female' || normalized === 'feminino' || normalized === 'f') {
    return 'female';
  }

  return null;
}

export function resolvePricingGender(input: GenderResolutionInput): CheckoutPricingGender | null {
  return (
    normalizePricingGenderInput(input.itemGender)
    ?? normalizePricingGenderInput(input.requestGender)
    ?? normalizePricingGenderInput(input.buyerGender)
    ?? null
  );
}

/**
 * O RPC get_registration_pricing_preview exige um genero valido ('masculino'
 * ou 'feminino') mesmo quando o preco da categoria/lote e identico para os
 * dois -- ele nao aceita "generico"/vazio. Quando o preco realmente NAO varia
 * por genero (current_male_price === current_female_price, dado ja exposto ao
 * frontend na propria lista de categorias, antes de qualquer selecao), usar
 * 'male' como token de preenchimento para a CHAMADA do RPC e seguro e nao e
 * "fabricar preco": o numero retornado e o mesmo que viria com 'female', e o
 * comprador ainda vai declarar o genero real dele normalmente na Etapa 2 (ou
 * no seletor do proprio item, quando exibido) -- este valor nunca e gravado
 * como pricingGender do item nem enviado na criacao do pedido.
 *
 * Quando o preco varia por genero e o genero do comprador ainda nao e
 * conhecido, retorna null: a Etapa 1 nao pode adivinhar qual dos dois precos
 * mostrar, entao nao ha preview possivel ainda (isso e pending_input
 * legitimo, nunca um pricing_error nem um loading eterno).
 */
export function resolvePricingPreviewGender(
  input: GenderResolutionInput,
  categoryPrices?: { malePrice?: number | null; femalePrice?: number | null } | null,
): CheckoutPricingGender | null {
  const resolved = resolvePricingGender(input);
  if (resolved) return resolved;

  const malePrice = categoryPrices?.malePrice;
  const femalePrice = categoryPrices?.femalePrice;
  if (malePrice != null && femalePrice != null && Number(malePrice) === Number(femalePrice)) {
    return 'male';
  }

  return null;
}

export function sumCheckoutItemTotals(items: Array<{ unitPrice?: number; discountAmount?: number; finalAmount?: number }>) {
  return items.reduce(
    (acc, item) => {
      acc.original += Number(item.unitPrice ?? 0);
      acc.discount += Number(item.discountAmount ?? 0);
      acc.total += Number(item.finalAmount ?? 0);
      return acc;
    },
    { original: 0, discount: 0, total: 0 },
  );
}

export type CheckoutPricingPhase = 'loading' | 'ready' | 'error' | 'pending_input';

export type PricingPhaseInput = {
  // true quando ha uma categoria resolvida E (o genero necessario para
  // precifica-la ja e conhecido OU o preco da categoria nao varia por genero,
  // ver resolvePricingPreviewGender). Enquanto false, nao existe nenhuma
  // tentativa de calculo em andamento -- e um estado estavel de espera por
  // input do proprio usuario, nunca um fetch que nao concluiu.
  canAttemptPricing: boolean;
  isRepricingItems: boolean;
  hasPricingErrorItems: boolean;
  hasPricedCheckoutItems: boolean;
};

/**
 * 'pending_input' so pode significar UMA coisa: ainda falta uma escolha do
 * proprio comprador para sequer tentar o calculo (categoria nao escolhida em
 * evento com 2+ categorias, OU genero nao resolvido quando o preco realmente
 * depende dele) -- nesse caso nao ha nenhum calculo em andamento nem faz
 * sentido tentar (o RPC recusaria de forma previsivel). Assim que
 * canAttemptPricing for true, o resultado e sempre 'loading', 'ready' ou
 * 'error', nunca uma 4a saida silenciosa -- essa 4a saida (alcancavel mesmo
 * com uma tentativa valida em curso, ex.: por causa de um gate extra nao
 * refletido aqui) foi a causa raiz do checkout travando em "Calculando
 * preço..." indefinidamente com o botao Continuar permanecendo clicavel.
 */
export function resolvePricingPhase(input: PricingPhaseInput): CheckoutPricingPhase {
  if (!input.canAttemptPricing) return 'pending_input';
  if (input.isRepricingItems) return 'loading';
  if (input.hasPricingErrorItems) return 'error';
  if (input.hasPricedCheckoutItems) return 'ready';
  return 'loading';
}

export type ZeroPaymentReason = 'courtesy' | 'coupon' | 'free';

export type ZeroPaymentContext = {
  baseAmount: number;
  discountAmount: number;
  finalAmount: number;
  paymentMethod?: string | null;
  couponApplied?: boolean;
};

/**
 * final_amount <= 0 nunca deve, por si so, ser lido como cortesia: um preco
 * final igual a zero pode vir de um ingresso configurado como gratuito, de um
 * cupom aplicado explicitamente, ou (administrativo) de uma cortesia declarada
 * via payment_method. Esta funcao decide qual dos tres representa o pedido.
 */
export function describeZeroPaymentReason(context: ZeroPaymentContext): { reason: ZeroPaymentReason; message: string } | null {
  const finalAmount = Number(context.finalAmount ?? 0);
  if (finalAmount > 0) return null;

  if (context.paymentMethod === 'courtesy') {
    return { reason: 'courtesy', message: 'Cortesia aplicada. Nenhum pagamento será necessário.' };
  }

  const discountAmount = Number(context.discountAmount ?? 0);
  if (context.couponApplied && discountAmount > 0) {
    return { reason: 'coupon', message: 'Cupom aplicado. Nenhum pagamento será necessário.' };
  }

  return { reason: 'free', message: 'Ingresso gratuito. Nenhum pagamento será necessário.' };
}
