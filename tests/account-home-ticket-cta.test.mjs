import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveAccountHomeQrHref, resolveAccountHomeTicketCta, resolveHomeFeaturedEventCta } from '../src/lib/account/home-ticket-cta.ts';

function card(ticketId, canShowTicket) {
  return { ticketId, canShowTicket };
}

test('0 ingressos acessiveis -> CTA some (nao tenta resolver ticket inexistente)', () => {
  assert.equal(resolveAccountHomeTicketCta([]), null);
});

test('0 ingressos acessiveis mesmo com cards presentes (todos cancelados/pendentes/bloqueados) -> CTA some', () => {
  const cards = [card('t1', false), card('t2', false)];
  assert.equal(resolveAccountHomeTicketCta(cards), null);
});

test('1 unico ingresso acessivel -> abre direto a pagina desse ingresso', () => {
  const cards = [card('t1', true)];
  assert.deepEqual(resolveAccountHomeTicketCta(cards), { type: 'ticket', ticketId: 't1' });
});

test('1 ingresso acessivel entre outros inacessiveis -> ainda abre direto (nunca conta os inacessiveis)', () => {
  const cards = [card('cancelado', false), card('t1', true), card('bloqueado', false)];
  assert.deepEqual(resolveAccountHomeTicketCta(cards), { type: 'ticket', ticketId: 't1' });
});

test('2 ingressos acessiveis -> navega para a lista, nunca escolhe um arbitrariamente', () => {
  const cards = [card('t1', true), card('t2', true)];
  assert.deepEqual(resolveAccountHomeTicketCta(cards), { type: 'list' });
});

test('varios ingressos acessiveis em eventos diferentes -> navega para a lista', () => {
  const cards = [card('t1', true), card('t2', true), card('t3', true), card('t4', true)];
  assert.deepEqual(resolveAccountHomeTicketCta(cards), { type: 'list' });
});

test('atalho de QR: 1 ingresso vai ao QR canonico; varios ou nenhum vao para Meus acessos', () => {
  assert.equal(resolveAccountHomeQrHref({ type: 'ticket', ticketId: 'abc' }), '/minha-conta/ingressos/abc#qr');
  assert.equal(resolveAccountHomeQrHref({ type: 'list' }), '/minha-conta/ingressos');
  assert.equal(resolveAccountHomeQrHref(null), '/minha-conta/ingressos');
});

test('CTA do evento em destaque prefere Ver acesso quando ja ha ingresso daquele evento', () => {
  const tickets = [
    { ticketId: 't1', eventId: 'ev-1', canShowTicket: true },
    { ticketId: 't2', eventId: 'ev-2', canShowTicket: true },
  ];
  assert.deepEqual(resolveHomeFeaturedEventCta({
    featuredEventId: 'ev-1',
    showBuyButton: true,
    buyHref: '/inscricao/militrin',
    tickets,
  }), { label: 'Ver acesso', href: '/minha-conta/ingressos/t1' });
});

test('CTA do evento em destaque usa Comprar ingresso quando nao ha acesso daquele evento e a venda esta aberta', () => {
  assert.deepEqual(resolveHomeFeaturedEventCta({
    featuredEventId: 'ev-9',
    showBuyButton: true,
    buyHref: '/inscricao/militrin',
    tickets: [{ ticketId: 't1', eventId: 'ev-1', canShowTicket: true }],
  }), { label: 'Comprar ingresso', href: '/inscricao/militrin' });
});

test('CTA do evento em destaque some quando nao ha acesso nem venda aberta', () => {
  assert.equal(resolveHomeFeaturedEventCta({
    featuredEventId: 'ev-9',
    showBuyButton: false,
    buyHref: '/minha-conta/comprar',
    tickets: [],
  }), null);
});

test('ingresso cancelado/inacessivel nunca e escolhido indevidamente mesmo sendo o unico card da lista', () => {
  const cards = [card('cancelado-ou-bloqueado', false)];
  assert.equal(resolveAccountHomeTicketCta(cards), null);
});

test('ordem dos cards nunca importa -- decisao depende so da CONTAGEM de acessiveis, nunca de posicao (primeiro/ultimo)', () => {
  const emAAcessivel = [card('a', true), card('b', false), card('c', false)];
  const emZAcessivel = [card('a', false), card('b', false), card('c', true)];
  assert.deepEqual(resolveAccountHomeTicketCta(emAAcessivel), { type: 'ticket', ticketId: 'a' });
  assert.deepEqual(resolveAccountHomeTicketCta(emZAcessivel), { type: 'ticket', ticketId: 'c' });
});
