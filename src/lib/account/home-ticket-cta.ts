export type AccountHomeTicketCtaTarget =
  | { type: 'ticket'; ticketId: string }
  | { type: 'list' };

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
