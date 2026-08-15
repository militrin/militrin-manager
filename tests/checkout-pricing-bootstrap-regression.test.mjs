import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { resolvePricingPhase, resolvePricingPreviewGender } from '../src/lib/checkout/pricing.ts';
import { computeSyncedItems } from '../src/lib/checkout/checkout-items.ts';

const wizardPath = new URL('../src/app/inscricao/[eventSlug]/wizard.tsx', import.meta.url);

// Regressao original reproduzida: evento Esquenta Militrin (1 categoria ativa
// "Pista", category_hidden, categoryChoiceReady=true desde o primeiro render,
// male_price === female_price === 20) ficava preso em "Calculando preço..."
// pra sempre, "Lote: -"/"Lote: Calculando..." e R$ 0,00, mesmo depois de uma
// primeira correcao que impediu o avanco durante o loading.
//
// Rastreamento ponta a ponta (useEffect bootstrap -> refreshItemPricingByCoupon
// -> getPublicPricingPreviewAction -> get_registration_pricing_preview (RPC
// real, testado contra o projeto Supabase configurado em .env.local) ->
// applyPricingResultsByClientId -> setState) confirmou que o RPC responde
// rapido (nao trava) e que o fetch do bootstrap de fato dispara. O preco
// chegava a ser aplicado a checkoutItems -- e era imediatamente sobrescrito
// por um segundo effect (hidratacao do sessionStorage) que voltava a rodar a
// cada mudanca de checkoutItems, porque syncItemCount (dependencia desse
// effect) tinha checkoutItems na sua propria lista de dependencias do
// useCallback. Isso criava um loop auto-sustentado: preco chega -> checkoutItems
// muda -> syncItemCount ganha identidade nova -> effect de hidratacao dispara
// de novo -> le um snapshot do sessionStorage de uma renderizacao atras (o
// effect de persistencia, que grava o snapshot atual, roda DEPOIS dele na
// mesma leva) -> reaplica esse snapshot desatualizado (sem preco) -> loop.
test('syncItemCount nunca pode depender de checkoutItems (causa raiz do loop que apagava o preco recem-calculado)', async () => {
  const src = await readFile(wizardPath, 'utf8');
  const fnMatch = src.match(/const syncItemCount = useCallback\(\(targetQuantity: number, seedItems\?: CheckoutItemConfig\[\]\): CheckoutItemConfig\[\] => \{[\s\S]*?\n  \}, \[[^\]]*\]\);/);
  assert.ok(fnMatch, 'deve existir a definicao de syncItemCount como useCallback');
  assert.doesNotMatch(
    fnMatch[0],
    /\[form\.gender, checkoutItems,/,
    'syncItemCount nao pode ter checkoutItems na sua propria lista de dependencias: isso faz sua identidade mudar toda vez que o preco e aplicado, o que reaciona o effect de hidratacao do sessionStorage (que tem syncItemCount como dependencia) e sobrescreve o preco recem-chegado com um snapshot desatualizado -- um loop que nunca converge',
  );
  assert.match(fnMatch[0], /checkoutItemsRef\.current/, 'syncItemCount deve ler o valor mais recente via ref, nao via closure sobre o state checkoutItems');
});

test('o effect de hidratacao do sessionStorage continua existindo e depende de syncItemCount (agora estavel)', async () => {
  const src = await readFile(wizardPath, 'utf8');
  assert.match(src, /\}, \[activeCategories, categoryConfigurationKey, event, storageKey, syncItemCount, totalSteps\]\);/);
});

// Segunda causa, encontrada ao investigar por que o preco nao aparecia mesmo
// SEM o loop: o RPC get_registration_pricing_preview exige um genero valido
// ('masculino'/'feminino') mesmo quando o preco da categoria e identico para
// os dois generos -- testado ao vivo contra o projeto Supabase real
// (get_registration_pricing_preview com p_gender='' para a categoria Pista do
// Esquenta Militrin retorna 400 "Genero invalido..."). Um comprador sem genero
// salvo no perfil (comum: genero so e coletado na Etapa 2) nunca teria um
// genero resolvivel na Etapa 1. A solucao correta nao e "deixar o RPC recusar
// e virar pricing_error" (isso exigiria uma informacao que so sera coletada na
// proxima etapa) nem "adivinhar o genero" -- e perceber que quando
// current_male_price === current_female_price (dado ja exposto na propria
// lista de categorias, sem depender do RPC), a resposta e a mesma nos dois
// casos, entao um valor placeholder ('male') pode ser usado SO na chamada de
// preview, sem nunca ser gravado como o genero real do comprador.
test('resolvePricingPreviewGender usa placeholder apenas quando o preco realmente nao varia por genero', () => {
  assert.equal(
    resolvePricingPreviewGender({}, { malePrice: 20, femalePrice: 20 }),
    'male',
    'Esquenta Militrin (20/20): preview deve resolver mesmo sem genero conhecido',
  );
  assert.equal(
    resolvePricingPreviewGender({}, { malePrice: 180, femalePrice: 150 }),
    null,
    'Militrin 2026 Open Bar (180/150): preco realmente depende do genero, preview nao pode adivinhar',
  );
  assert.equal(
    resolvePricingPreviewGender({}, null),
    null,
    'sem dados de preco por categoria (ex.: evento sem categoria/flat price), nunca assume invariancia',
  );
});

test('resolvePricingPreviewGender nunca sobrepõe um genero ja conhecido pelo placeholder', () => {
  assert.equal(
    resolvePricingPreviewGender({ itemGender: 'female' }, { malePrice: 180, femalePrice: 150 }),
    'female',
    'genero real do comprador sempre vence, mesmo quando o preco varia por genero',
  );
});

test('categoria unica resolvida com preco genero-invariante (Esquenta Militrin): canAttemptPricing nunca fica preso em pending_input', () => {
  const phase = resolvePricingPhase({
    canAttemptPricing: true,
    isRepricingItems: false,
    hasPricingErrorItems: false,
    hasPricedCheckoutItems: false,
  });
  assert.equal(phase, 'loading', 'sem preco pronto ainda, mas com uma tentativa valida possivel, o unico estado honesto e loading (nunca uma saida neutra que parece Continuar liberado)');
});

test('preco genero-variante sem genero conhecido (Militrin 2026 antes do comprador escolher): pending_input, nunca error nem loading eterno', () => {
  const phase = resolvePricingPhase({
    canAttemptPricing: false,
    isRepricingItems: false,
    hasPricingErrorItems: false,
    hasPricedCheckoutItems: false,
  });
  assert.equal(phase, 'pending_input');
});

test('fetch em andamento sempre vence: mesmo com preco antigo em cache, um novo fetch ativo mostra loading', () => {
  const phase = resolvePricingPhase({
    canAttemptPricing: true,
    isRepricingItems: true,
    hasPricingErrorItems: false,
    hasPricedCheckoutItems: true,
  });
  assert.equal(phase, 'loading');
});

test('erro real do backend nunca vira R$ 0,00 silencioso: pricingPhase reflete error explicitamente', () => {
  const phase = resolvePricingPhase({
    canAttemptPricing: true,
    isRepricingItems: false,
    hasPricingErrorItems: true,
    hasPricedCheckoutItems: false,
  });
  assert.equal(phase, 'error');
});

test('preco calculado com sucesso e sem erro fica ready', () => {
  const phase = resolvePricingPhase({
    canAttemptPricing: true,
    isRepricingItems: false,
    hasPricingErrorItems: false,
    hasPricedCheckoutItems: true,
  });
  assert.equal(phase, 'ready');
});

test('wizard usa resolvePricingPhase com canAttemptPricing (categoria resolvida E genero conhecido/irrelevante), nao mais so categoryChoiceReady', async () => {
  const src = await readFile(wizardPath, 'utf8');
  assert.match(src, /const pricingPhase = resolvePricingPhase\(\{\s*\n\s*canAttemptPricing,/);
  assert.match(src, /const canAttemptPricing = categoryChoiceReady && \(hasResolvableGender \|\| genderIndependentPriceAvailable\);/);
});

test('bootstrap so pula o fetch quando realmente nao ha o que tentar (canAttemptPricing false), nunca fica esperando genero indefinidamente sem sinalizar', async () => {
  const src = await readFile(wizardPath, 'utf8');
  const effectMatch = src.match(/useEffect\(\(\) => \{\s*\n\s*if \(!categoryChoiceReady \|\| !canAttemptPricing\) return;[\s\S]*?\}, \[effectiveCategoryId, categoryChoiceReady\]\);/);
  assert.ok(effectMatch, 'o effect de bootstrap deve verificar canAttemptPricing antes de disparar o fetch');
});

test('mensagem de pending_input nunca reaproveita o texto de loading ("Calculando preço...")', async () => {
  const src = await readFile(wizardPath, 'utf8');
  assert.match(src, /pricingPhase === 'pending_input' \? \(\s*\n\s*<p className="mt-3 text-xs text-slate-400">\{pendingInputMessage\}<\/p>/);
});

// computeSyncedItems (usado por syncItemCount) preserva itens existentes por
// referencia quando vem de seedItems -- confirma que o problema nao estava na
// logica pura de sincronizacao, e sim na instabilidade da memoizacao do
// wizard (ja coberta acima).
test('computeSyncedItems preserva a referencia de itens ja existentes em source (nao e a causa do loop)', () => {
  const items = computeSyncedItems(1, [], 'male', true);
  const synced = computeSyncedItems(1, items, 'male', true);
  assert.equal(synced[0], items[0], 'quando o item ja existe em source, computeSyncedItems devolve a MESMA referencia, sem criar objetos novos desnecessariamente');
});
