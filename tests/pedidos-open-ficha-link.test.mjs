import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

const [pageSource, participantPage, orderPage, cadastroPage] = await Promise.all([
  read('src/app/pedidos/page.tsx'),
  read('src/app/inscricoes/[id]/page.tsx'),
  read('src/app/inscricoes/pedido/[orderId]/page.tsx'),
  read('src/app/cadastros/[id]/page.tsx'),
]);

test('/pedidos "Abrir ficha" usa a ficha canonica do pedido, nunca /inscricoes/[participantId] com order.id', () => {
  assert.match(
    pageSource,
    /href=\{`\/inscricoes\/pedido\/\$\{order\.id\}`\}/,
    'Abrir ficha deve apontar para /inscricoes/pedido/[orderId] (rota de pedido ja existente)',
  );
  assert.doesNotMatch(
    pageSource,
    /href=\{`\/inscricoes\/\$\{order\.id\}`\}/,
    '/inscricoes/[id] busca participants.id; passar orders.id gera 404',
  );
  assert.doesNotMatch(pageSource, /href=\{`\/cadastros\/\$\{order\.id\}`\}/);
  assert.doesNotMatch(pageSource, /href=\{`\/ingressos\/\$\{order\.id\}`\}/);
  assert.doesNotMatch(pageSource, /href=\{`\/pedidos\/\$\{order\.id\}`\}/);
});

test('rotas reais: /inscricoes/[id] e participant, /inscricoes/pedido/[orderId] e order, /cadastros/[id] e contact', () => {
  assert.match(participantPage, /from\('participants'\)/);
  assert.match(participantPage, /\.eq\('id', id\)/);
  assert.match(participantPage, /if \(!participant\?\.id\) notFound\(\);/);

  assert.match(orderPage, /from\("orders"\)/);
  assert.match(orderPage, /\.eq\("id", orderId\)/);
  assert.match(orderPage, /if \(!order\?\.id\) notFound\(\);/);
  assert.match(orderPage, /ownership_status/);
  assert.match(orderPage, /Titular não definido/);

  assert.match(cadastroPage, /from\("registration_contacts"\)/);
});

test('ficha do pedido cobre importado, operador, site, com titular e sem titular: o href nao depende de buyer_type nem de ticket/participant', () => {
  const hrefIndex = pageSource.indexOf('href={`/inscricoes/pedido/${order.id}`}');
  assert.ok(hrefIndex >= 0);
  const aroundHref = pageSource.slice(Math.max(0, hrefIndex - 400), hrefIndex + 200);
  assert.doesNotMatch(aroundHref, /buyer_type|ticketId|participantId|registration_contact/);
  assert.match(aroundHref, /Abrir ficha/);
});

test('paginas canonicas existem (nao criar rota nova so para o link de /pedidos)', async () => {
  await access(new URL('../src/app/inscricoes/pedido/[orderId]/page.tsx', import.meta.url));
  await access(new URL('../src/app/inscricoes/[id]/page.tsx', import.meta.url));
  await access(new URL('../src/app/ingressos/[ticketId]/page.tsx', import.meta.url));
  await access(new URL('../src/app/cadastros/[id]/page.tsx', import.meta.url));
});
