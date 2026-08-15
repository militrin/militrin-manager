import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  applyPricingResultsByClientId,
  computeSyncedItems,
  createCheckoutItem,
} from '../src/lib/checkout/checkout-items.ts';

const wizardPath = new URL('../src/app/inscricao/[eventSlug]/wizard.tsx', import.meta.url);

function okResult(base, discount, final) {
  return { success: true, pricing: { base_amount: base, discount_amount: discount, final_amount: final } };
}

function errorResult(message, code = null) {
  return { success: false, message, code };
}

test('quantidade 1: um unico item, "self" por padrao', () => {
  const items = computeSyncedItems(1, [], 'male', true);
  assert.equal(items.length, 1);
  assert.equal(items[0].ownershipMode, 'self');
});

test('quantidade 1 -> 2: o item existente e preservado e um novo item e criado, ambos elegiveis a preco', () => {
  const initial = computeSyncedItems(1, [], 'male', true);
  const grown = computeSyncedItems(2, initial, 'male', true);
  assert.equal(grown.length, 2);
  assert.equal(grown[0].clientId, initial[0].clientId, 'o primeiro item nao pode ser recriado ao crescer a quantidade');
  assert.notEqual(grown[1].clientId, undefined);
  assert.notEqual(grown[1].clientId, grown[0].clientId);
});

test('quantidade 2 -> 3: o terceiro item tambem e criado preservando os dois primeiros', () => {
  const two = computeSyncedItems(2, [], 'male', true);
  const three = computeSyncedItems(3, two, 'male', true);
  assert.equal(three.length, 3);
  assert.equal(three[0].clientId, two[0].clientId);
  assert.equal(three[1].clientId, two[1].clientId);
});

test('quantidade 3 -> 1: itens excedentes saem do array sincronizado', () => {
  const three = computeSyncedItems(3, [], 'male', true);
  const shrunk = computeSyncedItems(1, three, 'male', true);
  assert.equal(shrunk.length, 1);
  assert.equal(shrunk[0].clientId, three[0].clientId);
});

test('comprador ja titular de outro ingresso ativo: nenhum item pode nascer ou permanecer "self"', () => {
  const items = computeSyncedItems(2, [], 'male', false);
  assert.ok(items.every((item) => item.ownershipMode !== 'self'));
});

test('apenas um item pode estar marcado como "self" por vez, mesmo que o source tenha mais de um', () => {
  const source = [
    { ...createCheckoutItem(0, 'male'), ownershipMode: 'self' },
    { ...createCheckoutItem(1, 'male'), ownershipMode: 'self' },
  ];
  const synced = computeSyncedItems(2, source, 'male', true);
  const selfCount = synced.filter((item) => item.ownershipMode === 'self').length;
  assert.equal(selfCount, 1);
});

test('quantidade 5: mesmo com todos os itens de origem marcados como "self", so um permanece', () => {
  const source = Array.from({ length: 5 }, (_, index) => ({ ...createCheckoutItem(index, 'male'), ownershipMode: 'self' }));
  const synced = computeSyncedItems(5, source, 'male', true);
  assert.equal(synced.length, 5);
  const selfCount = synced.filter((item) => item.ownershipMode === 'self').length;
  assert.equal(selfCount, 1, 'quantidade alta nao pode relaxar a regra de titularidade unica dentro do mesmo checkout');
  assert.equal(synced[0].ownershipMode, 'self', 'o item mantido como self e o primeiro (kept), os demais viram unassigned');
});

test('quantidade 5, comprador ja titular de outro ingresso ativo: nenhum dos 5 pode ser "self"', () => {
  const items = computeSyncedItems(5, [], 'male', false);
  assert.equal(items.length, 5);
  assert.ok(items.every((item) => item.ownershipMode !== 'self'));
});

test('duas configuracoes identicas: cada item recebe o mesmo preco individualmente calculado', () => {
  const items = computeSyncedItems(2, [], 'male', true);
  const resultsByClientId = new Map([
    [items[0].clientId, okResult(180, 0, 180)],
    [items[1].clientId, okResult(180, 0, 180)],
  ]);
  const priced = applyPricingResultsByClientId(items, resultsByClientId);
  assert.equal(priced[0].finalAmount, 180);
  assert.equal(priced[1].finalAmount, 180);
  assert.equal(priced[0].finalAmount + priced[1].finalAmount, 360, 'o total deve ser a soma real dos dois ingressos, nao o preco do primeiro repetido');
  assert.ok(priced.every((item) => item.visualStatus === 'price_updated'));
});

test('duas configuracoes diferentes: cada item mantem seu proprio preco, nunca copiado do primeiro', () => {
  const items = computeSyncedItems(2, [], 'male', true);
  const resultsByClientId = new Map([
    [items[0].clientId, okResult(180, 0, 180)],
    [items[1].clientId, okResult(220, 0, 220)],
  ]);
  const priced = applyPricingResultsByClientId(items, resultsByClientId);
  assert.equal(priced[0].finalAmount, 180);
  assert.equal(priced[1].finalAmount, 220);
  assert.equal(priced[0].finalAmount + priced[1].finalAmount, 400);
});

test('cupom aplicado: todos os itens recalculam pela mesma regra canonica (nenhum fica de fora)', () => {
  const items = computeSyncedItems(3, [], 'male', true);
  const resultsByClientId = new Map(items.map((item) => [item.clientId, okResult(180, 30, 150)]));
  const priced = applyPricingResultsByClientId(items, resultsByClientId);
  assert.ok(priced.every((item) => item.finalAmount === 150 && item.discountAmount === 30));
});

test('falha real de precificacao em um item nunca vira R$ 0,00: fica marcado com erro e nao contamina os demais', () => {
  const items = computeSyncedItems(2, [], 'male', true);
  const resultsByClientId = new Map([
    [items[0].clientId, okResult(180, 0, 180)],
    [items[1].clientId, errorResult('BATCH_FLAT_PRICE_NOT_CONFIRMED', 'P0001')],
  ]);
  const priced = applyPricingResultsByClientId(items, resultsByClientId);
  assert.equal(priced[0].visualStatus, 'price_updated');
  assert.equal(priced[0].finalAmount, 180);
  assert.equal(priced[1].visualStatus, 'pricing_error');
  assert.notEqual(priced[1].unitPrice, undefined);
  assert.equal(priced[1].unitPrice, 0, 'o item com erro nunca deve receber um finalAmount fabricado; unitPrice permanece o valor inicial nao tratado como preco real');
  assert.equal(priced[1].pricingError, 'BATCH_FLAT_PRICE_NOT_CONFIRMED', 'a mensagem/codigo original do RPC deve ser preservada, nao substituida por um texto generico');
});

test('resultado sem clientId correspondente nao altera o item (item fora desta rodada de precificacao)', () => {
  const items = computeSyncedItems(1, [], 'male', true);
  const priced = applyPricingResultsByClientId(items, new Map());
  assert.deepEqual(priced, items);
});

test('casamento e por clientId, nunca por indice: um array desalinhado nao faz o 2o item herdar o resultado do 1o', () => {
  const items = computeSyncedItems(2, [], 'male', true);
  // Simula uma rodada de precificacao que so processou o primeiro item (a
  // causa raiz original: refreshItemPricingByCoupon disparado com um
  // checkoutItems desatualizado, contendo so 1 item, enquanto o estado real
  // ja tinha crescido para 2).
  const resultsByClientId = new Map([[items[0].clientId, okResult(180, 0, 180)]]);
  const priced = applyPricingResultsByClientId(items, resultsByClientId);
  assert.equal(priced[0].finalAmount, 180);
  assert.equal(priced[1].visualStatus, 'missing', 'o segundo item deve permanecer aguardando precificacao, nunca herdar o preco do primeiro nem virar erro fabricado');
});

test('wizard.tsx importa as funcoes compartilhadas de checkout-items.ts em vez de redefini-las localmente', async () => {
  const source = await readFile(wizardPath, 'utf8');
  assert.match(source, /from '@\/lib\/checkout\/checkout-items'/);
  assert.doesNotMatch(source, /function computeSyncedItems\(/, 'computeSyncedItems nao pode mais estar duplicada dentro do wizard');
  assert.doesNotMatch(source, /function createCheckoutItem\(/, 'createCheckoutItem nao pode mais estar duplicada dentro do wizard');
});

test('todos os call sites que sincronizam quantidade repassam o array atualizado (itemsOverride) ao reprecificar, nunca uma closure desatualizada', async () => {
  const source = await readFile(wizardPath, 'utf8');

  // Handler de quantidade (Etapa 1, hero price card).
  assert.match(source, /const syncedItems = syncItemCount\(nextQuantity\);\s*\n\s*await refreshItemPricingByCoupon\(form\.coupon_code \|\| undefined, syncedItems\);/);

  // handlePersonalNext (transicao Etapa 2 -> Etapa 3).
  assert.match(source, /const syncedItems = syncItemCount\(form\.quantity\);\s*\n\s*await refreshItemPricingByCoupon\(form\.coupon_code \|\| undefined, syncedItems\);/);

  // Nenhum call site pode mais chamar refreshItemPricingByCoupon logo apos
  // syncItemCount sem repassar o array retornado.
  assert.doesNotMatch(source, /syncItemCount\([^)]*\);\s*\n\s*await refreshItemPricingByCoupon\(form\.coupon_code \|\| undefined\);/);
});

test('resultado de precificacao e casado por clientId dentro do wizard, nao por indice posicional', async () => {
  const source = await readFile(wizardPath, 'utf8');
  assert.match(source, /applyPricingResultsByClientId/);
  assert.doesNotMatch(source, /pricingResults\[index\]/);
});
