export type AccountHomeTicketCtaTarget =
  | { type: 'ticket'; ticketId: string }
  | { type: 'list' };

export type HomeFeaturedEventCta = {
  label: string;
  href: string;
};

/**
 * Decide o destino do CTA "Acesse seu ingresso" da Home a partir dos MESMOS
 * cards canonicos (ticketScope + canShowTicket) usados na lista completa em
 * /minha-conta/ingressos -- nunca "primeiro"/"ultimo" arbitrario. So conta
 * ingressos realmente acessiveis (canShowTicket): cancelados, pedidos nao
 * confirmados e ingressos com pendencia bloqueante ficam de fora da contagem.
 */
export function resolveAccountHomeTicketCta(
  cards: Array<{ ticketId: string; canShowTicket: boolean }>,
): AccountHomeTicketCtaTarget | null {
  const accessible = cards.filter((card) => card.canShowTicket);
  if (accessible.length === 0) return null;
  if (accessible.length === 1) return { type: 'ticket', ticketId: accessible[0].ticketId };
  return { type: 'list' };
}

/** Atalho de QR da Home: 1 acesso vai ao QR canonico; varios (ou nenhum) vao para Meus acessos. */
export function resolveAccountHomeQrHref(cta: AccountHomeTicketCtaTarget | null): string {
  if (cta?.type === 'ticket') return `/minha-conta/ingressos/${cta.ticketId}#qr`;
  return '/minha-conta/ingressos';
}

/**
 * CTA do card de evento em destaque da Home: compra se a venda estiver
 * aberta, senao "Ver evento" na pagina publica. Nao aponta para QR/acesso
 * -- isso fica so no card Meu acesso.
 */
export function resolveHomeFeaturedEventCta(input: {
  showBuyButton: boolean;
  buyHref: string;
  eventHref?: string | null;
}): HomeFeaturedEventCta | null {
  if (input.showBuyButton && input.buyHref) {
    return { label: 'Comprar ingresso', href: input.buyHref };
  }
  const eventHref = String(input.eventHref ?? '').trim();
  if (eventHref) return { label: 'Ver evento', href: eventHref };
  return null;
}
