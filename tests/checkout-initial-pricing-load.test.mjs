import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const wizardPath = new URL('../src/app/inscricao/[eventSlug]/wizard.tsx', import.meta.url);

async function source() {
  return readFile(wizardPath, 'utf8');
}

test('preco e buscado assim que a opcao de ingresso e resolvida, nao apenas na etapa de pagamento', async () => {
  const src = await source();
  // canAttemptPricing = categoryChoiceReady && (genero conhecido OU preco nao
  // varia por genero) -- ver tests/checkout-pricing-bootstrap-regression.test.mjs.
  // So pula o fetch quando realmente nao ha o que tentar ainda.
  assert.match(src, /useEffect\(\(\) => \{\s*\n\s*if \(!categoryChoiceReady \|\| !canAttemptPricing\) return;/, 'deve existir um effect de bootstrap disparado por categoryChoiceReady/effectiveCategoryId');
  assert.match(src, /\}, \[effectiveCategoryId, categoryChoiceReady\]\);/, 'o effect de bootstrap reage a mudanca da opcao de ingresso, nao a etapa atual');
});

test('categoria unica (auto-selecionada) tambem dispara o calculo automatico de preco', async () => {
  const src = await source();
  // O effect de bootstrap depende apenas de categoryChoiceReady/effectiveCategoryId,
  // que ja ficam resolvidos automaticamente quando ha exatamente 1 categoria ativa
  // (activeCategories.length === 1 ? activeCategories[0] : ...), sem exigir clique.
  assert.match(src, /const selectedCategory = activeCategories\.length === 1\s*\n\s*\? activeCategories\[0\]/);
});

test('nunca usa 0 como estado provisorio: enquanto carrega ou falha, o valor nao aparece', async () => {
  const src = await source();
  assert.match(src, /pricingPhase === 'ready' \? \(/);
  assert.match(src, /Calculando preço\.\.\./);
  assert.doesNotMatch(src, />R\$ 0,00</, 'nao deve haver R$ 0,00 hardcoded como fallback visual');
});

test('erro de precificacao bloqueia o Continuar e nunca cai para zero', async () => {
  const src = await source();
  assert.match(src, /disabled=\{isPending \|\| pricingPhase === 'loading' \|\| pricingPhase === 'error'\}/);
  assert.match(src, /Não foi possível calcular o preço: \{firstPricingErrorMessage\}/);
});

test('trocar de categoria limpa o preco anterior antes de recalcular (nunca mostra valor de outra opcao)', async () => {
  const src = await source();
  assert.match(src, /function selectCategory\(categoryId: string\) \{[\s\S]*?setPricing\(null\);/);
});

test('ingresso gratuito legitimo (preco base zero) continua sendo exibido corretamente na etapa 1', async () => {
  const src = await source();
  assert.match(src, /pricingPhase === 'ready' \? \([\s\S]*?zeroPaymentSummaryReason \? \(/);
});

test('evento sem categoria mostra "Ingresso único" e nunca "Lote: Não selecionado"', async () => {
  const src = await source();
  assert.doesNotMatch(src, /Lote: Não selecionado/);
  assert.doesNotMatch(src, /'Lote: '.*'Não selecionado'/);
  assert.match(src, /const isSingleTicketEvent = ticketPresentationMode === 'single';/);
  assert.match(src, /const batchDisplayLabel = isSingleTicketEvent\s*\n\s*\? 'Ingresso único'/);
  assert.match(src, /\{isSingleTicketEvent \? 'Ingresso' : 'Lote'\}: \{batchDisplayLabel\}/);
});

test('resumo lateral/mobile, card principal e etapa de pagamento usam a mesma fonte de preco (summaryValues/batchDisplayLabel)', async () => {
  const src = await source();
  const mobileAndSidebarOccurrences = src.match(/\{isSingleTicketEvent \? 'Ingresso' : 'Lote'\}: \{summaryValues\.batch\}/g) ?? [];
  assert.equal(mobileAndSidebarOccurrences.length, 2, 'resumo mobile e resumo lateral devem usar summaryValues.batch identicamente');
  assert.match(src, /<strong>\{isSingleTicketEvent \? 'Ingresso' : 'Lote'\}:<\/strong> \{batchDisplayLabel\}/, 'etapa de pagamento deve usar o mesmo batchDisplayLabel do card principal');
  assert.match(src, /batch: batchDisplayLabel,/, 'summaryValues.batch deve vir do mesmo batchDisplayLabel usado no card principal');
});

test('confirmacao final (pos-pedido) tambem trata ingresso unico sem "Não selecionado"', async () => {
  const src = await source();
  assert.match(src, /\{isSingleTicketEvent \? 'Ingresso' : 'Lote'\}:<\/strong> \{isSingleTicketEvent \? 'Ingresso único' : \(registration\.batch_name \|\| '-'\)\}/);
});
