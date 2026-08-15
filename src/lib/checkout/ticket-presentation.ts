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
