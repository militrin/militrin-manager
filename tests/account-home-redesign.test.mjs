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

test('QR da home usa o token do ticket, sem gerar QR novo no servidor', async () => {
  const cards = await read('src/lib/account/home-ticket-cards.ts');
  const carousel = await read('src/app/minha-conta/home-ticket-carousel.tsx');
  const page = await read('src/app/minha-conta/page.tsx');
  assert.match(cards, /token: canShowQr \? String\(ticket\.token\) : null/);
  assert.match(carousel, /LocalQrImage/);
  assert.match(carousel, /current\.token/);
  assert.match(carousel, /#qr/);
  assert.match(carousel, /hidden w-\[104px\][\s\S]*LocalQrImage/);
  assert.doesNotMatch(page, /generateQrDataUrl/);
  assert.doesNotMatch(page, /HomeQuickActions/);
});

test('Eventos da home usam arte real e marcam Em alta so com ocupacao real', async () => {
  const page = await read('src/app/minha-conta/page.tsx');
  const list = await read('src/app/minha-conta/home-featured-events.tsx');
  assert.match(page, /isHot: soldPercent !== null && soldPercent >= 50/);
  assert.match(page, /banner_card_url/);
  assert.match(page, /banner_hero_url/);
  assert.match(list, /event\.isHot/);
  assert.match(list, /MilitrinEventArtwork/);
  assert.match(list, /Ver evento/);
});

test('home nao restaura atalhos, numeros nem novidades', async () => {
  const page = await read('src/app/minha-conta/page.tsx');
  assert.doesNotMatch(page, /HomeQuickActions/);
  assert.doesNotMatch(page, /HomeIndicators/);
  assert.doesNotMatch(page, /Últimas novidades/);
  assert.doesNotMatch(page, /Seus números/);
  assert.doesNotMatch(page, /Acessar meu QR Code/);
  assert.match(page, /HomeTicketCarousel/);
  assert.match(page, /HomeStoreBanner/);
  assert.match(page, /HomeSponsorsCarousel/);
  assert.match(page, /get_active_sponsors_for_home/);
});

test('hierarquia da home: evento, acesso, eventos, loja, patrocinadores', async () => {
  const page = await read('src/app/minha-conta/page.tsx');
  const heroIdx = page.indexOf('<HomeFeaturedHero');
  const accessIdx = page.indexOf('<HomeTicketCarousel');
  const eventsIdx = page.indexOf('<HomeFeaturedEvents');
  const storeIdx = page.indexOf('<HomeStoreBanner');
  const sponsorsIdx = page.indexOf('<HomeSponsorsCarousel');
  const betaIdx = page.indexOf('<BetaFeedbackWidget');
  assert.ok(heroIdx < accessIdx && accessIdx < eventsIdx && eventsIdx < storeIdx && storeIdx < sponsorsIdx && sponsorsIdx < betaIdx);
});
