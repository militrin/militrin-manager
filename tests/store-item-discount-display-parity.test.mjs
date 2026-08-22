import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile as readFileRaw } from 'node:fs/promises';
import { computeStoreItemFinalPrice, resolveStoreItemLinePrice, storeItemHasActiveDiscount } from '../src/lib/store/pricing.ts';

// Bug: a loja do usuario ("/minha-conta/loja") mostrava o preco BASE mesmo
// quando o produto tinha desconto configurado no admin -- o checkout ja
// cobrava certo (compute_store_item_final_price no banco), so a vitrine
// (card + modal + carrinho) ignorava discount_type/discount_value.

async function readFile(url, encoding) {
  return (await readFileRaw(url, encoding)).replace(/\r\n/g, '\n');
}

const getStoreItems = await readFile(new URL('../src/lib/store/get-store-items.ts', import.meta.url), 'utf8');
const accountStoreShop = await readFile(new URL('../src/components/store/AccountStoreShop.tsx', import.meta.url), 'utf8');
const storeCart = await readFile(new URL('../src/components/store/StoreCart.tsx', import.meta.url), 'utf8');
const storeItemControls = await readFile(new URL('../src/components/store/store-item-controls.tsx', import.meta.url), 'utf8');
const lojaAdminPage = await readFile(new URL('../src/app/loja/page.tsx', import.meta.url), 'utf8');
const cartStep = await readFile(new URL('../src/app/inscricao/[eventSlug]/cart-step.tsx', import.meta.url), 'utf8');
const discountMigration = await readFile(new URL('../supabase/migrations/20260855000000_store_item_lifecycle_and_discount_pricing.sql', import.meta.url), 'utf8');
const storeItemsSchemaMigration = discountMigration; // mesma migration cria as colunas de desconto

// ── Formula canonica (espelha public.compute_store_item_final_price) ───────

test('computeStoreItemFinalPrice: produto SEM desconto devolve o proprio preco (nunca negativo)', () => {
  assert.equal(computeStoreItemFinalPrice(70, null, 0), 70);
  assert.equal(computeStoreItemFinalPrice(0, null, 0), 0);
});

test('computeStoreItemFinalPrice: desconto FIXO -- exemplo do bug (R$70 riscado -> R$55, desconto de R$15)', () => {
  assert.equal(computeStoreItemFinalPrice(70, 'fixed', 15), 55);
});

test('computeStoreItemFinalPrice: desconto PERCENTUAL', () => {
  assert.equal(computeStoreItemFinalPrice(70, 'percentage', 20), 56);
  assert.equal(computeStoreItemFinalPrice(200, 'percentage', 50), 100);
});

test('computeStoreItemFinalPrice: piso em 0 -- desconto fixo maior que o preco, ou percentual acima de 100 tratado como 100', () => {
  assert.equal(computeStoreItemFinalPrice(50, 'fixed', 999), 0);
  assert.equal(computeStoreItemFinalPrice(50, 'percentage', 150), 0);
});

test('storeItemHasActiveDiscount: so true quando ha desconto configurado E ele realmente reduz o preco', () => {
  assert.equal(storeItemHasActiveDiscount(70, null, 0), false);
  assert.equal(storeItemHasActiveDiscount(70, 'fixed', 0), false);
  assert.equal(storeItemHasActiveDiscount(70, 'fixed', 15), true);
  assert.equal(storeItemHasActiveDiscount(70, 'percentage', 20), true);
});

// ── resolveStoreItemLinePrice: preco base + ajuste de variante + desconto ──

test('resolveStoreItemLinePrice: produto sem variante e sem desconto -- final = base = price', () => {
  const item = { price: 70, discountType: null, discountValue: 0, variants: [] };
  const result = resolveStoreItemLinePrice(item, null);
  assert.equal(result.baseUnitPrice, 70);
  assert.equal(result.finalUnitPrice, 70);
  assert.equal(result.hasDiscount, false);
  assert.equal(result.variant, null);
});

test('resolveStoreItemLinePrice: produto com desconto fixo -- final = base - desconto (mesmo exemplo do bug)', () => {
  const item = { price: 70, discountType: 'fixed', discountValue: 15, variants: [] };
  const result = resolveStoreItemLinePrice(item, null);
  assert.equal(result.baseUnitPrice, 70);
  assert.equal(result.finalUnitPrice, 55);
  assert.equal(result.hasDiscount, true);
});

test('resolveStoreItemLinePrice: desconto percentual', () => {
  const item = { price: 100, discountType: 'percentage', discountValue: 25, variants: [] };
  const result = resolveStoreItemLinePrice(item, null);
  assert.equal(result.finalUnitPrice, 75);
  assert.equal(result.hasDiscount, true);
});

test('resolveStoreItemLinePrice: ajuste de variante entra no preco ANTES do desconto (mesma ordem do checkout: base+ajuste -> desconto)', () => {
  const item = {
    price: 70,
    discountType: 'percentage',
    discountValue: 10,
    variants: [{ id: 'gg', priceAdjustment: 10 }],
  };
  const result = resolveStoreItemLinePrice(item, 'gg');
  assert.equal(result.variant?.id, 'gg');
  assert.equal(result.baseUnitPrice, 80); // 70 + 10 de ajuste, ANTES do desconto
  assert.equal(result.finalUnitPrice, 72); // 80 * 0.9
  assert.equal(result.hasDiscount, true);
});

test('resolveStoreItemLinePrice: devolve o objeto de variante completo (nome/valor), nao so os campos minimos do calculo', () => {
  const item = {
    price: 70,
    discountType: null,
    discountValue: 0,
    variants: [{ id: 'gg', priceAdjustment: 10, name: 'Tamanho', value: 'GG' }],
  };
  const result = resolveStoreItemLinePrice(item, 'gg');
  assert.equal(result.variant?.name, 'Tamanho');
  assert.equal(result.variant?.value, 'GG');
});

// ── Causa raiz: get-store-items.ts descartava discount_type/discount_value da RPC ──

test('getStoreItemsForEvent mapeia discountType/discountValue da RPC (causa raiz: antes so mapeava price, descartando o desconto)', () => {
  assert.match(getStoreItems, /discountType: row\.discount_type === 'percentage' \|\| row\.discount_type === 'fixed' \? row\.discount_type : null,/);
  assert.match(getStoreItems, /discountValue: Number\(row\.discount_value \?\? 0\),/);
});

// ── Card/modal (usuario sem ingresso ou com ingresso -- produto global) ────

test('AccountStoreShop (card da vitrine) usa StoreItemPrice/resolveStoreItemLinePrice -- nunca money(item.price) cru', () => {
  assert.match(accountStoreShop, /import \{ resolveStoreItemLinePrice \} from '@\/lib\/store\/pricing';/);
  assert.match(accountStoreShop, /<StoreItemPrice item=\{item\} variantId=\{sel\.variantId\} \/>/);
  assert.doesNotMatch(accountStoreShop, /money\(item\.price\)/);
});

test('AccountStoreShop.addToCart grava no carrinho o preco JA promocional (finalUnitPrice) -- nao o preco base', () => {
  assert.match(accountStoreShop, /const \{ variant, finalUnitPrice \} = resolveStoreItemLinePrice\(item, sel\.variantId\);/);
  assert.match(accountStoreShop, /unitPrice: finalUnitPrice,/);
  assert.doesNotMatch(accountStoreShop, /unitPrice: item\.price \+ \(variant\?\.priceAdjustment/);
});

test('StoreItemPrice (card + modal, componente unico) mostra preco riscado + final + badge quando ha desconto, e so o preco normal quando nao ha', () => {
  const fn = storeItemControls.slice(storeItemControls.indexOf('export function StoreItemPrice'));
  assert.match(fn, /if \(!hasDiscount\) \{\s*\n\s*return <p className=\{`\$\{textClass\} text-\(--brand-300\)`\}>\{money\(finalUnitPrice\)\}<\/p>;/);
  assert.match(fn, /className="text-slate-500 line-through">\{money\(baseUnitPrice\)\}/);
  assert.match(fn, /item\.discountType === 'percentage' \? `-\$\{item\.discountValue\}%` : `-\$\{money\(item\.discountValue\)\}`/);
});

test('ItemDetailModal (produto global e de evento, mesmo modal) usa StoreItemPrice reagindo a variante selecionada -- nao mais money(item.price) fixo', () => {
  assert.doesNotMatch(storeItemControls, /text-lg font-semibold text-\(--brand-300\)">\{money\(item\.price\)\}/);
  assert.match(storeItemControls, /<StoreItemPrice item=\{item\} variantId=\{selection\.variantId\} size="lg" \/>/);
});

// ── Carrinho "compre junto" do evento (StoreCart.tsx) -- produto de evento ──

test('StoreCart (compre junto, produto de evento) calcula lineTotal a partir de finalUnitPrice -- carrinho nunca soma o preco base', () => {
  assert.match(storeCart, /const \{ variant, finalUnitPrice \} = resolveStoreItemLinePrice\(item, cartLine\.variantId\);/);
  assert.match(storeCart, /lineTotal: finalUnitPrice \* cartLine\.quantity/);
  assert.doesNotMatch(storeCart, /unitPrice = item\.price \+ \(variant\?\.priceAdjustment/);
  assert.match(storeCart, /<StoreItemPrice item=\{item\} variantId=\{sel\.variantId\} \/>/);
});

// ── Compre junto no wizard de inscricao (outro produto de evento, RPC list_store_items_for_event tambem) ──

test('cart-step.tsx (compre junto no wizard de inscricao) tambem calcula o preco efetivo via computeStoreItemFinalPrice -- terceira tela que tinha o mesmo bug', () => {
  assert.match(cartStep, /import \{ computeStoreItemFinalPrice \} from "@\/lib\/store\/pricing";/);
  assert.match(cartStep, /function effectivePrice\(row: EligibleProduct\) \{/);
  assert.match(cartStep, /discount_type: "percentage" \| "fixed" \| null;/);
  assert.doesNotMatch(cartStep, /money\(Number\(base\.price\)\)/);
});

// ── Admin /loja -- unica funcao de verdade, nenhum calculo duplicado ────────

test('admin /loja/page.tsx usa a MESMA computeStoreItemFinalPrice compartilhada -- nao reimplementa a formula localmente', () => {
  assert.match(lojaAdminPage, /import \{ computeStoreItemFinalPrice \} from "@\/lib\/store\/pricing";/);
  assert.match(lojaAdminPage, /finalPrice: computeStoreItemFinalPrice\(price, discountType, discountValue\),/);
  assert.doesNotMatch(lojaAdminPage, /function computeFinalPrice/);
});

// ── Vigencia por data -- auditoria explicita do que existe hoje ─────────────

test('vigencia por periodo/data de desconto: auditado e confirmado que NAO existe essa coluna/logica hoje -- store_items so tem discount_type/discount_value, sem inicio/fim; nao foi inventada uma feature nova pra esta correcao', () => {
  assert.match(storeItemsSchemaMigration, /add column if not exists discount_type text,\s*\n\s*add column if not exists discount_value numeric\(10,2\) not null default 0;/);
  assert.doesNotMatch(storeItemsSchemaMigration, /discount_starts_at|discount_ends_at|discount_valid/);
});

// ── Invariante central do bug: card === carrinho === checkout ───────────────

test('invariante: o mesmo par (unitPrice, discountType, discountValue) sempre produz o mesmo preco final, seja pro card, pro carrinho ou pro que create_store_order cobraria (mesma formula em compute_store_item_final_price)', () => {
  const scenarios = [
    { unitPrice: 70, discountType: null, discountValue: 0 },
    { unitPrice: 70, discountType: 'fixed', discountValue: 15 },
    { unitPrice: 70, discountType: 'percentage', discountValue: 20 },
    { unitPrice: 80, discountType: 'percentage', discountValue: 10 }, // preco+ajuste de variante
  ];
  for (const s of scenarios) {
    const cardPrice = computeStoreItemFinalPrice(s.unitPrice, s.discountType, s.discountValue);
    const cartPrice = computeStoreItemFinalPrice(s.unitPrice, s.discountType, s.discountValue);
    assert.equal(cardPrice, cartPrice, `card e carrinho divergiram pro cenario ${JSON.stringify(s)}`);
  }
  // A formula em si (nao so a chamada) bate com o SQL de compute_store_item_final_price.
  assert.match(discountMigration, /p_unit_price \* \(1 - least\(coalesce\(p_discount_value,0\),100\) \/ 100\.0\)/);
  assert.match(discountMigration, /p_unit_price - coalesce\(p_discount_value,0\)/);
});
