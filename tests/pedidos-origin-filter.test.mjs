import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

const [actionsSource, pageSource, typesSource] = await Promise.all([
  read('src/app/pedidos/actions.ts'),
  read('src/app/pedidos/page.tsx'),
  read('src/app/pedidos/types.ts'),
]);

test('filtro Origem usa orders.buyer_type na query, nunca heuristica de nome/preco/data', () => {
  assert.match(typesSource, /export const ORDER_ORIGIN_VALUES = \["imported_holder", "administrative", "account"\]/);
  assert.match(actionsSource, /parseOrderOrigin\(params\.origin\)/);
  assert.match(actionsSource, /buyer_type/);
  assert.match(actionsSource, /ordersQuery = ordersQuery\.eq\("buyer_type", origin\)/);
  assert.match(actionsSource, /\.eq\("event_id", selectedEvent\.id\)/);
  assert.doesNotMatch(actionsSource, /price_origin === params\.origin/);
  assert.doesNotMatch(actionsSource, /r\.buyerName[\s\S]{0,80}origin/);
});

test('buyer_type entra no select de orders e o .eq de origem precede o limit(500)', () => {
  const selectIndex = actionsSource.indexOf('buyer_type');
  const originEqIndex = actionsSource.indexOf('.eq("buyer_type", origin)');
  const limitIndex = actionsSource.indexOf('.limit(500)');
  assert.ok(selectIndex >= 0 && originEqIndex > selectIndex, 'select precisa trazer buyer_type antes do filtro');
  assert.ok(originEqIndex >= 0 && limitIndex > originEqIndex, 'filtro de origem precisa ser query-side, antes do cap 500');
});

test('UI: Origem — todas ao lado de Pagamento e Status, opcoes canonicas', () => {
  assert.match(pageSource, /<option value="">Origem — todas<\/option>/);
  assert.match(pageSource, /imported_holder: "Importado"/);
  assert.match(pageSource, /administrative: "Emitido pelo operador"/);
  assert.match(pageSource, /account: "Compra pelo site"/);
  const paymentIndex = pageSource.indexOf('name="paymentStatus"');
  const statusIndex = pageSource.indexOf('name="orderStatus"');
  const originIndex = pageSource.indexOf('name="origin"');
  assert.ok(paymentIndex >= 0 && statusIndex > paymentIndex && originIndex > statusIndex);
});

test('Limpar e o query param origin combinam com os filtros existentes', () => {
  assert.match(pageSource, /origin\?: string;/);
  assert.match(pageSource, /params\.q \|\| params\.paymentStatus \|\| params\.orderStatus \|\| params\.origin/);
  assert.match(pageSource, /buildUrl\(\{ q: "", paymentStatus: "", orderStatus: "", origin: "", page: "1" \}\)/);
});
