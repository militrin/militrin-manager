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

test('hero preserva o brasao oficial e mostra a arte completa com contain', async () => {
  const hero = await read('src/app/minha-conta/home-featured-hero.tsx');
  assert.match(hero, /mask-logo/);
  assert.match(hero, /Evento em destaque/);
  assert.match(hero, /event\.imageUrl/);
  assert.match(hero, /h-\[168px\]/);
  assert.match(hero, /blur-2xl/);
  assert.match(hero, /object-contain object-center/);
  assert.match(hero, /scale-125 object-cover blur-2xl/);
  assert.doesNotMatch(hero, /banner_card_url/);
  assert.doesNotMatch(hero, /banner_hero_url/);
});

test('compra pendente da home so renderiza com findActionableAccountOrder', async () => {
  const page = await read('src/app/minha-conta/page.tsx');
  const portal = await read('src/lib/account/portal-orders-and-tickets.ts');
  assert.match(page, /findActionableAccountOrder/);
  assert.match(portal, /canContinueCommercialPayment\(resolveAccountOrderStatus/);
  assert.match(page, /hasPendingPurchase && pendingOrder && pendingOrderDetail \? \(/);
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
  assert.doesNotMatch(carousel, /hidden w-\[104px\]/);
  assert.doesNotMatch(page, /generateQrDataUrl/);
  assert.doesNotMatch(page, /HomeQuickActions/);
});

test('Eventos da home usam arte real sem crop e marcam Em alta so com ocupacao real', async () => {
  const page = await read('src/app/minha-conta/page.tsx');
  const list = await read('src/app/minha-conta/home-featured-events.tsx');
  const sponsors = await read('src/app/minha-conta/home-sponsors-carousel.tsx');
  assert.match(page, /isHot: soldPercent !== null && soldPercent >= 50/);
  assert.match(page, /banner_card_url/);
  assert.match(page, /banner_hero_url/);
  assert.match(list, /event\.isHot/);
  assert.match(list, /object-contain/);
  assert.doesNotMatch(list, /object-cover/);
  assert.match(list, /Ver evento/);
  assert.match(list, /overflow-x-auto/);
  assert.match(sponsors, /object-contain object-center/);
  assert.match(sponsors, /\[aspect-ratio:var\(--sponsor-ratio\)\]/);
  assert.doesNotMatch(sponsors, /lg:aspect-auto/);
  assert.doesNotMatch(sponsors, /lg:h-full lg:min-h-\[11\.5rem\]/);
  assert.doesNotMatch(sponsors, /object-cover/);
  assert.doesNotMatch(sponsors, /inset-1\.5/);
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

test('hierarquia da home: evento, acesso, patrocinadores, eventos, compra pendente, loja', async () => {
  const page = await read('src/app/minha-conta/page.tsx');
  const heroIdx = page.indexOf('<HomeFeaturedHero');
  const accessIdx = page.indexOf('<HomeTicketCarousel');
  const sponsorsIdx = page.indexOf('<HomeSponsorsCarousel');
  const eventsIdx = page.indexOf('<HomeFeaturedEvents');
  const pendingIdx = page.indexOf('<HomePendingPurchase');
  const storeIdx = page.indexOf('<HomeStoreBanner');
  const betaIdx = page.indexOf('<BetaFeedbackWidget');
  assert.ok(heroIdx < accessIdx && accessIdx < storeIdx && storeIdx < sponsorsIdx && sponsorsIdx < eventsIdx && eventsIdx < pendingIdx && pendingIdx < betaIdx);
  assert.match(page, /order-1 lg:order-none/);
  assert.match(page, /order-2 lg:order-none lg:col-start-2 lg:row-start-1/);
  assert.match(page, /order-3 lg:order-none/);
  assert.match(page, /order-4 lg:order-none/);
  assert.match(page, /order-5 lg:order-none/);
});

test('desktop empilha acessos e loja na coluna esquerda sem esticar na altura do patrocinador', async () => {
  const page = await read('src/app/minha-conta/page.tsx');
  const store = await read('src/app/minha-conta/home-store-banner.tsx');
  assert.match(page, /lg:grid-cols-\[minmax\(0,0\.42fr\)_minmax\(0,0\.58fr\)\]/);
  assert.match(page, /contents lg:col-start-1 lg:row-start-1 lg:flex lg:flex-col lg:gap-4/);
  assert.match(page, /lg:col-start-2 lg:row-start-1/);
  assert.match(page, /lg:col-span-2 lg:row-start-2/);
  assert.doesNotMatch(page, /lg:row-span-2/);
  assert.doesNotMatch(page, /lg:col-start-1 lg:row-start-2/);
  assert.doesNotMatch(page, /order-1 lg:order-2/);
  assert.doesNotMatch(page, /lg:grid-cols-2 lg:items-stretch/);
  assert.doesNotMatch(page, /lg:grid-cols-\[minmax\(0,1\.45fr\)_minmax\(0,1fr\)\]/);
  assert.match(store, /lg:h-24 lg:w-20/);
  assert.match(store, /lg:text-lg/);
  assert.doesNotMatch(store, /lg:min-h-\[7\.5rem\]/);
});

test('compra pendente no mobile continua apos eventos e antes da loja, sem reimplementar pagamento', async () => {
  const page = await read('src/app/minha-conta/page.tsx');
  const pending = await read('src/app/minha-conta/home-pending-purchase.tsx');
  const eventsIdx = page.indexOf('<HomeFeaturedEvents');
  const pendingIdx = page.indexOf('<HomePendingPurchase');
  assert.ok(eventsIdx < pendingIdx);
  assert.match(page, /order-3 lg:order-none/);
  assert.match(page, /order-4 lg:order-none/);
  assert.match(page, /order-5 lg:order-none/);
  assert.match(pending, /\/minha-conta\/compras\/\$\{orderId\}/);
  assert.match(pending, /Continuar pagamento/);
  assert.match(pending, /lg:h-auto lg:flex-row/);
});

test('PIN da home no mobile reusa getMyPublicPin e some no desktop do card de acesso', async () => {
  const page = await read('src/app/minha-conta/page.tsx');
  const carousel = await read('src/app/minha-conta/home-ticket-carousel.tsx');
  const pin = await read('src/app/minha-conta/public-pin-copy.tsx');
  const layout = await read('src/app/minha-conta/layout.tsx');
  assert.match(page, /getMyPublicPin/);
  assert.match(page, /publicPin=\{publicPin\}/);
  assert.match(carousel, /<PublicPinCopy publicPin=\{publicPin\} compact \/>/);
  assert.match(carousel, /lg:hidden/);
  assert.match(pin, /navigator\.clipboard\.writeText\(publicPin\)/);
  assert.match(pin, /Copiado/);
  assert.match(pin, /Código do ingresso/);
  assert.match(pin, /Copiar código do ingresso/);
  assert.doesNotMatch(pin, /Meu PIN/);
  assert.match(layout, /<PublicPinCopy publicPin=\{publicPin\} \/>/);
  assert.doesNotMatch(layout, /compact/);
});

test('participante ve public_pin como Codigo do ingresso, sem copy de PIN', async () => {
  const dados = await read('src/app/minha-conta/dados/page.tsx');
  const holder = await read('src/app/minha-conta/ingressos/[ticketId]/ticket-holder-actions.tsx');
  const actions = await read('src/app/minha-conta/actions.ts');
  assert.match(dados, /Código do ingresso/);
  assert.doesNotMatch(dados, /Seu PIN Militrin/);
  assert.match(holder, /placeholder="Código do ingresso"/);
  assert.doesNotMatch(holder, /PIN do usuário/);
  assert.match(actions, /Nenhum usuário encontrado para esse código do ingresso/);
  assert.doesNotMatch(actions, /Nenhum usuário encontrado para esse PIN/);
});
