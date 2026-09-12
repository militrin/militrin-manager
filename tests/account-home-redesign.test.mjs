import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('home usa o evento em destaque canonico e some o card se nao houver elegivel', async () => {
  const page = await read('src/app/minha-conta/page.tsx');
  assert.match(page, /getPrimaryAccountHeaderEvent/);
  assert.match(page, /headerEvent \? <HomeFeaturedHero/);
  assert.match(page, /resolveHomeFeaturedEventCta/);
});

test('card de evento em destaque usa logo da marca, nunca o banner do evento como imagem principal', async () => {
  const hero = await read('src/app/minha-conta/home-featured-hero.tsx');
  assert.match(hero, /mask-logo/);
  assert.match(hero, /Evento em destaque/);
  assert.doesNotMatch(hero, /event\.imageUrl/);
  assert.doesNotMatch(hero, /banner_card_url/);
  assert.doesNotMatch(hero, /banner_hero_url/);
});

test('compra pendente da home so renderiza com canContinueCommercialPayment', async () => {
  const page = await read('src/app/minha-conta/page.tsx');
  assert.match(page, /canContinueCommercialPayment/);
  assert.match(page, /pendingOrder && pendingOrderDetail \? \(/);
  assert.doesNotMatch(page, /Nenhuma compra pendente no momento/);
});

test('atalho de QR e secao de acessos reutilizam o token do ticket, sem gerar QR novo no servidor', async () => {
  const cards = await read('src/lib/account/home-ticket-cards.ts');
  const carousel = await read('src/app/minha-conta/home-ticket-carousel.tsx');
  const page = await read('src/app/minha-conta/page.tsx');
  assert.match(cards, /token: canShowQr \? String\(ticket\.token\) : null/);
  assert.match(carousel, /LocalQrImage/);
  assert.match(carousel, /current\.token/);
  assert.match(page, /resolveAccountHomeQrHref/);
  assert.doesNotMatch(page, /generateQrDataUrl/);
});

test('Eventos em destaque so marcam Em alta com dado real de ocupacao', async () => {
  const page = await read('src/app/minha-conta/page.tsx');
  const list = await read('src/app/minha-conta/home-featured-events.tsx');
  assert.match(page, /isHot: soldPercent !== null && soldPercent >= 50/);
  assert.match(list, /event\.isHot/);
});

test('novidades da home usam pedido real e omitem a secao se nao houver', async () => {
  const page = await read('src/app/minha-conta/page.tsx');
  assert.match(page, /latestOrder \? \(/);
  assert.match(page, /Últimas novidades/);
  assert.doesNotMatch(page, /Seu primeiro pedido aparecerá aqui/);
});
