export type TicketPresentationMode = 'single' | 'category_hidden' | 'category_visible';

/**
 * Decide como o comprador (e o preview administrativo) devem apresentar
 * categoria/lote a partir da contagem de categorias ATIVAS do evento. Esta é
 * a única fonte da regra adaptativa — checkout público e preview administrativo
 * devem sempre chamar esta função em vez de reimplementar o corte 0/1/2+.
 *
 * - single: sem categoria ativa nenhuma. Não existe escolha a fazer; mostra
 *   apenas "Ingresso único".
 * - category_hidden: exatamente 1 categoria ativa. A categoria continua sendo
 *   a fonte canônica de preço no backend/order item, mas não vale a pena expor
 *   como uma "escolha" ao comprador — mostra só o lote resolvido.
 * - category_visible: 2+ categorias ativas. O comprador precisa escolher a
 *   categoria; depois disso, o lote correspondente é resolvido e exibido.
 */
export function resolveTicketPresentationMode(activeCategoryCount: number): TicketPresentationMode {
  if (activeCategoryCount <= 0) return 'single';
  if (activeCategoryCount === 1) return 'category_hidden';
  return 'category_visible';
}

export type CategoryAvailability = {
  is_active: boolean;
  current_batch_id: string | null;
  available_slots: number | null;
};

/**
 * Espelha em TS o mesmo criterio de "categoria vendavel" que
 * get_registration_pricing_preview usa no banco para contar
 * v_eligible_categories (categoria ativa, com lote/preco resolvido via
 * current_batch_id, e com vaga restante). As duas precisam concordar sempre
 * — se o guard do RPC mudar, este espelho tem que mudar junto.
 */
export function hasSellableCategory(categories: CategoryAvailability[]): boolean {
  return categories.some(
    (category) => category.is_active && category.current_batch_id !== null && (category.available_slots === null || category.available_slots > 0),
  );
}

/**
 * "Configuração incompleta": existe 1+ categoria ativa mas nenhuma delas tem
 * lote/preço vendável — o mesmo estado que faz get_registration_pricing_preview
 * levantar TICKET_CATEGORY_UNAVAILABLE. Não é um estado persistido no banco;
 * é sempre recalculado a partir de ticket_categories/registration_batch_prices,
 * do mesmo jeito que o modo de apresentação (single/category_hidden/category_visible).
 */
export function isCategoryConfigurationIncomplete(categories: CategoryAvailability[]): boolean {
  const hasActiveCategory = categories.some((category) => category.is_active);
  if (!hasActiveCategory) return false;
  return !hasSellableCategory(categories);
}
